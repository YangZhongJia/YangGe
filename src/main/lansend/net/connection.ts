/**
 * A framed, authenticated TCP connection.
 *
 * One class serves both planes: the first frame decides whether the peer is a
 * control link or a data link, and the role is inside the signature so it
 * cannot be swapped in flight.
 *
 * The class deliberately does not know about files, offers or sessions. It
 * delivers decoded control messages and raw data buffers, and lets the data
 * plane write frames straight to the socket (`raw`) so the sender can do its
 * own cork/uncork + drain handling without an extra copy.
 */

import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';

import { signHandshake, verifyHandshake, type StoredIdentity, type WirePeerInfo } from '../crypto/identity';
import { HANDSHAKE_TIMEOUT_MS, IDLE_TIMEOUT_MS, PROTOCOL_VERSION } from '../protocol/constants';
import { decodeControl, encodeControl } from '../protocol/codec';
import { encodeControlFrame, FrameDecoder, type DecodedFrame } from '../protocol/frame';
import type { ControlMessage } from '../protocol/types';

export type PeerRole = 'control' | 'data';

export interface FramedConnectionOptions {
  readonly socket: Socket;
  readonly identity: StoredIdentity;
  /**
   * Role this side sends in its `hello`. Only the connecting side sends one,
   * so the accepting side passes `null` and learns the role from the peer.
   */
  readonly role: PeerRole | null;
  /**
   * Role the peer must present. `'any'` on the accepting side: the first
   * `hello` decides whether this is a control or a data connection.
   */
  readonly expectRole: PeerRole | 'any';
  /** For data links: the transfer this connection is bound to. Signed. */
  readonly transferId?: string;
  readonly localInfo: WirePeerInfo;
  /** Called for every validated control message after the handshake. */
  readonly onControl: (msg: ControlMessage, conn: FramedConnection) => void;
  /** Called for every data frame. Only data connections receive these. */
  readonly onData?: (payload: Buffer, conn: FramedConnection) => void;
  /** Called exactly once when the connection ends, with the reason if it failed. */
  readonly onClose?: (error: Error | null) => void;
  /** Inbound peer info after a successful handshake. */
  readonly onReady?: (peer: WirePeerInfo, conn: FramedConnection) => void;
  readonly idleTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
}

export type ConnectionState = 'handshaking' | 'ready' | 'closed';

/**
 * Tracks one side of a TCP connection.
 *
 * Lifecycle: `handshaking` → `ready` → `closed`. Any protocol violation closes
 * the connection; the caller decides whether that is retryable.
 */
export class FramedConnection {
  readonly socket: Socket;
  readonly remoteAddress: string;

  #options: FramedConnectionOptions;
  #role: PeerRole | null = null;
  #transferId: string | null = null;
  #decoder = new FrameDecoder();
  #state: ConnectionState = 'handshaking';
  #peer: WirePeerInfo | null = null;
  #handshakeTimer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #closeEmitted = false;
  #paused = false;
  #controlHandler: (msg: ControlMessage, conn: FramedConnection) => void;
  #dataHandler: ((payload: Buffer, conn: FramedConnection) => void) | null;

  constructor(options: FramedConnectionOptions) {
    this.#options = options;
    this.#controlHandler = options.onControl;
    this.#dataHandler = options.onData ?? null;
    this.socket = options.socket;
    this.#role = options.role;
    this.#transferId = options.transferId ?? null;
    this.remoteAddress = normalizeAddress(options.socket.remoteAddress);

    this.socket.setNoDelay(true);
    this.socket.setKeepAlive(true, 10_000);
    this.socket.on('data', (chunk) => this.#onData(chunk));
    this.socket.on('error', (error) => this.#finish(error));
    this.socket.on('close', () => this.#finish(null));
    this.socket.on('timeout', () => this.#finish(new Error('socket-timeout')));

    this.#armHandshakeTimeout();
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** The negotiated role, known once the handshake completes. */
  get role(): PeerRole | null {
    return this.#role;
  }

  /** The transfer this data link serves; null for control links. */
  get transferId(): string | null {
    return this.#transferId;
  }

  /** The authenticated peer, or null before the handshake completes. */
  get peer(): WirePeerInfo | null {
    return this.#peer;
  }

  get isReady(): boolean {
    return this.#state === 'ready';
  }

  /** Sends a `hello` frame. Called by the connecting side immediately. */
  sendHello(): void {
    const role = this.#role;
    if (role === null) throw new Error('sendHello requires a role');
    const transferId = this.#transferId;
    if (role === 'data' && transferId === null) throw new Error('data hello requires a transferId');
    const ts = Date.now();
    const sig = role === 'data'
      ? signHandshake(this.#options.identity, ts, role, transferId ?? undefined)
      : signHandshake(this.#options.identity, ts, role);
    this.writeControl({
      t: 'hello',
      v: PROTOCOL_VERSION,
      info: this.#options.localInfo,
      ts,
      sig,
      role,
      ...(role === 'data' ? { transferId: transferId as string } : {}),
    });
  }

  /** Sends a control message. Silently drops it once the connection is closed. */
  writeControl(msg: ControlMessage): boolean {
    if (this.#state === 'closed' || this.socket.destroyed) return false;
    return this.socket.write(encodeControlFrame(encodeControl(msg)));
  }

  /**
   * Exposes the raw socket for the data plane. The sender writes DATA frames
   * itself so file bytes are never copied into a framing buffer.
   */
  get raw(): Socket {
    return this.socket;
  }

  /**
   * Replaces the control handler.
   *
   * The router uses this to hand a connection to a session: the first frame
   * establishes the role, and every later frame belongs to the session that
   * claimed it. Passing `null` restores the original handler.
   */
  setControlHandler(handler: ((msg: ControlMessage, conn: FramedConnection) => void) | null): void {
    this.#controlHandler = handler ?? this.#options.onControl;
  }

  /** Replaces the data handler, same rationale as `setControlHandler`. */
  setDataHandler(handler: ((payload: Buffer, conn: FramedConnection) => void) | null): void {
    this.#dataHandler = handler ?? this.#options.onData ?? null;
  }

  /** Pauses reads; the receiver uses this when its disk write queue is full. */
  pause(): void {
    if (this.#paused) return;
    this.#paused = true;
    this.socket.pause();
  }

  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.socket.resume();
  }

  /** Closes the connection. Idempotent. */
  destroy(reason?: string): void {
    if (this.#state === 'closed') return;
    this.#finish(reason ? new Error(reason) : null);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #armHandshakeTimeout(): void {
    const ms = this.#options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.#handshakeTimer = setTimeout(() => this.#finish(new Error('handshake-timeout')), ms);
    this.#handshakeTimer.unref?.();
  }

  #armIdleTimeout(): void {
    this.#clearIdleTimeout();
    const ms = this.#options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.#idleTimer = setTimeout(() => this.#finish(new Error('idle-timeout')), ms);
    this.#idleTimer.unref?.();
  }

  #clearIdleTimeout(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  #onData(chunk: Buffer): void {
    if (this.#state === 'closed') return;
    let frames: DecodedFrame[];
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      // A bad frame is unrecoverable: the stream position is unknown, so the
      // only safe action is to drop the connection.
      this.#finish(error as Error);
      return;
    }
    for (const frame of frames) {
      if ((this.#state as ConnectionState) === 'closed') return;
      if (frame.kind === 'control') {
        this.#onControlFrame(frame.payload);
      } else {
        if (this.#state !== 'ready') {
          this.#finish(new Error('data-before-handshake'));
          return;
        }
        const onData = this.#dataHandler;
        if (onData === null) {
          this.#finish(new Error('unexpected-data'));
          return;
        }
        onData(frame.payload, this);
      }
    }
    if (this.#state === 'ready') this.#armIdleTimeout();
  }

  #onControlFrame(payload: Buffer): void {
    const msg = decodeControl(payload);
    if (msg === null) {
      this.#finish(new Error('bad-control-frame'));
      return;
    }

    if (this.#state === 'handshaking') {
      this.#completeHandshake(msg);
      return;
    }

    if (msg.t === 'hello' || msg.t === 'hello-ok') {
      // A second handshake is either a confused peer or an attempt to swap
      // identities mid-connection. Neither is recoverable.
      this.#finish(new Error('duplicate-handshake'));
      return;
    }

    this.#controlHandler(msg, this);
  }

  #completeHandshake(msg: ControlMessage): void {
    if (msg.t === 'hello') {
      // Accepting side: the peer declares the role, we verify it is allowed.
      const expect = this.#options.expectRole;
      if (expect !== 'any' && msg.role !== expect) {
        this.#finish(new Error('role-mismatch'));
        return;
      }
      this.#role = msg.role;
      if (msg.role === 'data') this.#transferId = msg.transferId ?? null;
      const verdict = verifyHandshake({
        nodeId: msg.info.nodeId,
        publicKey: msg.info.publicKey,
        ts: msg.ts,
        role: msg.role,
        ...(msg.role === 'data' ? { transferId: msg.transferId } : {}),
        sig: msg.sig,
      });
      if (!verdict.ok) {
        this.#finish(new Error(`handshake-rejected:${verdict.reason ?? 'unknown'}`));
        return;
      }
      this.#peer = msg.info;
      this.#promote();
      const ts = Date.now();
      this.writeControl({
        t: 'hello-ok',
        v: PROTOCOL_VERSION,
        info: this.#options.localInfo,
        ts,
        sig: msg.role === 'data'
          ? signHandshake(this.#options.identity, ts, msg.role, msg.transferId)
          : signHandshake(this.#options.identity, ts, msg.role),
      });
      return;
    }

    if (msg.t === 'hello-ok') {
      // Connecting side: verify the answer against the role we sent.
      const role = this.#role;
      if (role === null) {
        this.#finish(new Error('unexpected-hello-ok'));
        return;
      }
      const verdict = verifyHandshake({
        nodeId: msg.info.nodeId,
        publicKey: msg.info.publicKey,
        ts: msg.ts,
        role,
        ...(role === 'data' && this.#transferId !== null ? { transferId: this.#transferId } : {}),
        sig: msg.sig,
      });
      if (!verdict.ok) {
        this.#finish(new Error(`handshake-rejected:${verdict.reason ?? 'unknown'}`));
        return;
      }
      this.#peer = msg.info;
      this.#promote();
      return;
    }

    this.#finish(new Error('expected-handshake'));
  }

  #promote(): void {
    this.#state = 'ready';
    if (this.#handshakeTimer) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
    this.#armIdleTimeout();
    const peer = this.#peer;
    if (peer !== null) this.#options.onReady?.(peer, this);
  }

  #finish(error: Error | null): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    if (this.#handshakeTimer) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
    this.#clearIdleTimeout();
    this.#decoder.reset();
    if (!this.socket.destroyed) this.socket.destroy();
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    this.#options.onClose?.(error);
  }
}

/** IPv4-mapped IPv6 (`::ffff:192.168.1.5`) is reported as plain IPv4. */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return '0.0.0.0';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

/** Stable per-peer id used to key connection pools. */
export function peerKey(nodeId: string, role: PeerRole): string {
  return `${nodeId}:${role}`;
}

/** Short digest used in log lines without leaking the full node id. */
export function shortId(nodeId: string): string {
  return createHash('sha256').update(nodeId).digest('hex').slice(0, 8);
}
