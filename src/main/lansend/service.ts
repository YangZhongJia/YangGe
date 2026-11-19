/**
 * The public facade.
 *
 * Owns the process-wide singletons (identity, listener, discovery) and the
 * per-transfer sessions. Everything a consumer needs is here; everything else
 * is an implementation detail.
 *
 * Direction naming follows the data flow, not the initiator:
 *  - `send`   — we offer files and serve the peer's pulls;
 *  - `receive`— we accept an offer and pull the bytes.
 * The offer always travels over a control link the *sender* dials, and the
 * bytes always travel over data links the *receiver* dials.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { hostname, platform as osPlatform } from 'node:os';
import { dirname, join } from 'node:path';

import { loadOrCreateIdentity, toWireInfo, type StoredIdentity, type WirePeerInfo } from './crypto/identity';
import { Discovery } from './discovery/index';
import type { FramedConnection } from './net/connection';
import { dialPeer, TransferServer } from './net/server';
import { HttpTransport } from './net/http';
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CONNECTIONS,
  DEFAULT_PORT,
  DEFAULT_RANGE_BYTES,
  MAX_FILES,
  MAX_PIN_ATTEMPTS,
} from './protocol/constants';
import { decodeControl, encodeControl } from './protocol/codec';
import type {
  ControlMessage,
  DiscoveredPeer,
  FileEntry,
  OfferDecision,
  PeerInfo,
  SendOptions,
  ServiceEventMap,
  TransferOffer,
  TransferProgress,
  TransferSummary,
  TransferTuning,
} from './protocol/types';
import { FileReceiverWriter, partPathFor } from './transfer/writer';
import { ReceiveSession } from './transfer/session';
import { SendSession, type SendFileSource } from './transfer/send-session';
import { ChunkBitmap } from './transfer/bitmap';
import { ResumeStore, type ResumeState } from './transfer/resume';
import { TransferSender } from './transfer/sender';
import { hashFile, safeJoin, sanitizeRelativePath, uniquePath, walkPaths } from './util/files';
import { TypedEmitter } from './util/emitter';
import { withResolvers } from './util/promise';

export interface LanSendOptions {
  /** Holds `identity.json` and resume metadata. */
  readonly dataDir: string;
  /** Received files land here. */
  readonly downloadDir: string;
  readonly alias?: string;
  /** TCP port. 0 asks the OS for an ephemeral port (tests). */
  readonly port?: number;
  /** UDP port for discovery. Defaults to `port`; 0 disables announcements. */
  readonly udpPort?: number;
  readonly platform?: PeerInfo['platform'];
  readonly deviceModel?: string;
  readonly version?: string;
  /** Consulted synchronously for every incoming offer. Absent → `offer` event. */
  readonly autoAccept?: (offer: TransferOffer) => boolean;
  /** PIN the receiver demands; the sender passes the matching PIN. */
  readonly pin?: string;
  /** Defaults applied to every transfer; `send` may override per call. */
  readonly tuning?: Partial<TransferTuning>;
  /** Joins multicast discovery. Off means `addPeer` only. */
  readonly discovery?: boolean;
  /**
   * Also serve the HTTP transport (browser upload/download, iOS background).
   * `true` uses `port + 1`; a number picks the port explicitly.
   */
  readonly http?: boolean | number;
  readonly now?: () => number;
}

export const DEFAULT_TUNING: TransferTuning = {
  chunkSize: DEFAULT_CHUNK_SIZE,
  rangeBytes: DEFAULT_RANGE_BYTES,
  connections: DEFAULT_CONNECTIONS,
  // Hashing the source before offering costs a full read of every file. The
  // receiver still hashes what it writes, which catches transport corruption;
  // end-to-end verification against the sender's copy is opt-in because it
  // halves the achievable speed on a fast link.
  hashMaxBytes: 0,
  maxRetries: 3,
};

export interface LanSend {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly info: PeerInfo;
  readonly port: number;
  /** Port of the HTTP transport, or 0 when it is not running. */
  readonly httpPort: number;
  peers(): DiscoveredPeer[];
  addPeer(host: string, port: number): Promise<DiscoveredPeer | null>;
  send(options: SendOptions): Promise<TransferSummary>;
  sendMessage(peer: DiscoveredPeer, text: string): Promise<void>;
  /** Aborts an in-flight transfer. Returns false when the id is unknown. */
  cancel(transferId: string): boolean;
  on<K extends keyof ServiceEventMap>(event: K, listener: (payload: ServiceEventMap[K]) => void): () => void;
  once<K extends keyof ServiceEventMap>(event: K, listener: (payload: ServiceEventMap[K]) => void): () => void;
  off<K extends keyof ServiceEventMap>(event: K, listener: (payload: ServiceEventMap[K]) => void): void;
}

/** Internal record of one transfer in flight. */
interface ActiveTransfer {
  readonly transferId: string;
  readonly peer: PeerInfo;
  readonly startedAt: number;
  readonly files: readonly FileEntry[];
  readonly totalBytes: number;
  readonly control: FramedConnection;
  readonly direction: 'send' | 'receive';
  readonly session: SendSession | ReceiveSession;
  readonly summaryBase: TransferSummary;
}

export function createLanSend(options: LanSendOptions): LanSend {
  return new LanSendService(options);
}

class LanSendService implements LanSend {
  readonly #options: LanSendOptions;
  readonly #emitter = new TypedEmitter<ServiceEventMap>();
  readonly #now: () => number;

  #identity: StoredIdentity | null = null;
  #server: TransferServer | null = null;
  #discovery: Discovery | null = null;
  #http: HttpTransport | null = null;
  #httpPort = 0;
  /** Browser-uploaded transfers, keyed by transferId. */
  readonly #httpTargets = new Map<string, Map<string, { fileId: string; relativePath: string; size: number; partPath: string; finalPath: string }>>();
  readonly #sendSources = new Map<string, Map<string, { absolutePath: string; size: number; sha256: string | null }>>();
  readonly #httpTransfers = new Map<string, {
    readonly files: Map<string, { path: string; size: number; handle: import('node:fs/promises').FileHandle }>;
    readonly downloadDir: string;
  }>();
  #resume: ResumeStore | null = null;
  #port = 0;
  #started = false;
  #stopping = false;

  readonly #transfers = new Map<string, ActiveTransfer>();
  /** transferId -> getter for the last metadata write, so completion can await it. */
  readonly #pendingResumeWrites = new Map<string, () => Promise<void>>();
  /**
   * Transfers whose metadata must not be written again.
   *
   * The last range completion can fire a throttled save *after* the transfer
   * has been committed and its metadata deleted; without this flag that save
   * recreates the file and the next run tries to resume a finished transfer.
   */
  readonly #resumeSealed = new Set<string>();
  /**
   * Rejects the `send()` promise when the transfer dies outside its own
   * handler (control link closed, receiver vanished).
   */
  readonly #sendRejectors = new Map<string, (error: Error) => void>();
  /**
   * Peers learned through `addPeer` rather than discovery.
   *
   * Kept separate from the discovery table so a manual probe does not look like
   * a multicast sighting, while still being visible to `peers()` and `send()`.
   */
  readonly #manualPeers = new Map<string, DiscoveredPeer>();

  /** nodeId -> { failures, blockedUntil }. A PIN is a static secret, so an
   * unthrottled offer loop is an offline-speed brute force. */
  readonly #pinAttempts = new Map<string, { failures: number; blockedUntil: number }>();

  constructor(options: LanSendOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.#started) throw new Error('already started');
    this.#started = true;

    const alias = this.#options.alias ?? hostname();
    this.#identity = await loadOrCreateIdentity(this.#options.dataDir, alias);
    await mkdir(this.#options.downloadDir, { recursive: true });
    this.#resume = new ResumeStore(join(this.#options.downloadDir, '.lansend'));
    await this.#resume.prune(7 * 24 * 60 * 60 * 1000);

    const server = new TransferServer({
      identity: this.#identity,
      localInfo: () => this.#wireInfo(),
      preferredPort: this.#options.port ?? DEFAULT_PORT,
      router: {
        onControl: (conn, first) => this.#onControlLink(conn, first),
        onData: (conn, first) => this.#onDataLink(conn, first),
        onConnectionError: (scope, error) => this.#emitError(scope, error),
      },
    });
    this.#server = server;
    this.#port = await server.start();

    if (this.#options.http !== undefined && this.#options.http !== false) {
      // `port + 1` is convenient but wrong when the TCP port was ephemeral:
      // an arbitrary neighbour can already be taken by another process, and
      // the failure is invisible until a client tries to connect. Asking the
      // OS for a free port is the only safe default there.
      const requested =
        this.#options.http === true
          ? this.#options.port === 0 || this.#options.port === undefined
            ? 0
            : this.#port + 1
          : this.#options.http;
      const transport = new HttpTransport({
        info: () => this.#wireInfo(),
        onOffer: (request) => this.#onHttpOffer(request),
        onRange: (params) => this.#onHttpRange(params),
        onUpload: (params) => this.#onHttpUpload(params),
        onDone: (transferId, ok) => this.#onHttpDone(transferId, ok),
        onError: (scope, error) => this.#emitError(`http:${scope}`, error),
      });
      this.#http = transport;
      try {
        this.#httpPort = await transport.start(requested);
      } catch (error) {
        // The HTTP surface is optional; losing it must not stop the service.
        this.#http = null;
        this.#emitError('http:start', error as Error);
      }
    }

    if (this.#options.discovery !== false) {
      // Multicast only works when every peer joins the SAME group and port.
      // `udpPort: 0` therefore means "ephemeral, do not announce" — that is
      // what tests and `addPeer`-only setups pass.
      const udpPort = this.#options.udpPort ?? this.#options.port ?? DEFAULT_PORT;
      if (udpPort !== 0) {
        const discovery = new Discovery({
          identity: this.#identity,
          port: this.#port,
          udpPort,
          alias,
          onPeer: (peer) => this.#emitter.emit('peerFound', peer),
          onPeerLost: (peer) => this.#emitter.emit('peerLost', peer),
          onError: (scope, error) => this.#emitError(`discovery:${scope}`, error),
          now: this.#now,
        });
        this.#discovery = discovery;
        try {
          await discovery.start();
        } catch (error) {
          // Multicast is optional: a network that blocks it still works via
          // `addPeer` and manual addresses.
          this.#discovery = null;
          this.#emitError('discovery:start', error as Error);
        }
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.#started || this.#stopping) return;
    this.#stopping = true;
    // Flush resume metadata before tearing sessions down. A user who quits
    // mid-transfer expects the next start to continue, not to restart.
    const flushes: Promise<void>[] = [];
    for (const transfer of this.#transfers.values()) {
      if (transfer.direction !== 'receive') continue;
      flushes.push(
        this.#saveResume(
          transfer.transferId,
          transfer.peer.nodeId,
          transfer.files,
          transfer.session.bitmapsSnapshot(),
          this.#tuning().chunkSize,
        ),
      );
    }
    await Promise.allSettled(flushes);
    for (const transfer of [...this.#transfers.values()]) {
      transfer.session.cancel('shutdown');
    }
    this.#transfers.clear();
    for (const transfer of this.#httpTransfers.values()) {
      for (const file of transfer.files.values()) await file.handle.close().catch(() => {});
    }
    this.#httpTransfers.clear();
    await this.#http?.stop();
    this.#http = null;
    await this.#discovery?.stop();
    this.#discovery = null;
    await this.#server?.stop();
    this.#server = null;
    this.#emitter.removeAll();
    this.#started = false;
    this.#stopping = false;
  }

  get info(): PeerInfo {
    return this.#wireInfo();
  }

  get port(): number {
    return this.#port;
  }

  /** Port of the HTTP transport, or 0 when it is not running. */
  get httpPort(): number {
    return this.#httpPort;
  }

  peers(): DiscoveredPeer[] {
    const discovered = this.#discovery?.peers ?? new Map<string, DiscoveredPeer>();
    // Manual peers are merged in because `addPeer` must make a peer usable:
    // with discovery off (tests, locked-down networks) the discovered table is
    // empty, and `peers()` would otherwise report nothing after a successful
    // probe.
    const merged = new Map<string, DiscoveredPeer>();
    for (const [nodeId, peer] of discovered) merged.set(nodeId, peer);
    for (const [nodeId, peer] of this.#manualPeers) {
      if (!merged.has(nodeId)) merged.set(nodeId, peer);
    }
    return [...merged.values()].filter((peer) => peer.nodeId !== this.#identity?.nodeId);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on<K extends keyof ServiceEventMap>(event: K, listener: (payload: ServiceEventMap[K]) => void): () => void {
    return this.#emitter.on(event, listener);
  }

  once<K extends keyof ServiceEventMap>(event: K, listener: (payload: ServiceEventMap[K]) => void): () => void {
    return this.#emitter.once(event, listener);
  }

  off<K extends keyof ServiceEventMap>(event: K, listener: (payload: ServiceEventMap[K]) => void): void {
    this.#emitter.off(event, listener);
  }

  // -------------------------------------------------------------------------
  // Peers
  // -------------------------------------------------------------------------

  /**
   * Probes a host directly.
   *
   * UDP is tried first because it also feeds the peer table. When discovery is
   * disabled (tests, or a network that blocks multicast) a TCP `hello` is
   * enough to learn the peer's identity.
   */
  async addPeer(host: string, port: number): Promise<DiscoveredPeer | null> {
    const discovery = this.#discovery;
    if (discovery) {
      const probed = await discovery.probe(host);
      if (probed !== null) {
        this.#manualPeers.set(probed.nodeId, probed);
        return probed;
      }
    }
    const identity = this.#identity;
    if (identity === null) throw new Error('not started');

    const { promise, resolve } = withResolvers<DiscoveredPeer | null>();
    const conn = await dialPeer({
      host,
      port,
      identity,
      role: 'control',
      localInfo: this.#wireInfo(),
      onControl: () => {},
      onClose: () => {},
    }).catch(() => null);
    if (conn === null) {
      resolve(null);
      return promise;
    }
    const peer = conn.peer;
    conn.destroy('probe-done');
    if (peer === null) {
      resolve(null);
      return promise;
    }
    const discovered: DiscoveredPeer = {
      nodeId: peer.nodeId,
      alias: peer.alias,
      platform: peer.platform,
      deviceModel: peer.deviceModel,
      version: peer.version,
      port,
      fingerprint: peer.fingerprint,
      protocolVersions: peer.protocolVersions,
      host,
      lastSeen: this.#now(),
      favorite: false,
      source: 'manual',
    };
    this.#manualPeers.set(discovered.nodeId, discovered);
    resolve(discovered);
    return promise;
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  async send(options: SendOptions): Promise<TransferSummary> {
    const identity = this.#identity;
    if (identity === null) throw new Error('not started');

    const tuning = { ...DEFAULT_TUNING, ...this.#options.tuning, ...options.tuning };
    const walked = await walkPaths(options.paths, MAX_FILES);
    if (walked.length === 0) throw new Error('no-files');

    const files: FileEntry[] = [];
    const sources = new Map<string, SendFileSource>();
    for (let i = 0; i < walked.length; i += 1) {
      const file = walked[i]!;
      const fileId = `f${i + 1}`;
      const sha256 = tuning.hashMaxBytes > 0 && file.size <= tuning.hashMaxBytes
        ? await hashFile(file.absolutePath)
        : null;
      files.push({
        fileId,
        name: file.relativePath.split('/').pop() ?? file.relativePath,
        relativePath: file.relativePath,
        size: file.size,
        mtime: file.mtime,
        sha256,
      });
      sources.set(fileId, { fileId, absolutePath: file.absolutePath, size: file.size, sha256 });
    }

    const transferId = randomUUID().replace(/-/g, '').slice(0, 32);
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    const peer = options.peer;

    const control = await dialPeer({
      host: peer.host,
      port: peer.port,
      identity,
      role: 'control',
      localInfo: this.#wireInfo(),
      onControl: (msg) => this.#onSendControl(msg),
      onClose: (error) => this.#onSendControlClosed(transferId, error),
    });

    const summaryBase: TransferSummary = {
      transferId,
      direction: 'send',
      peer,
      state: 'pending',
      files,
      totalBytes,
      bytesTransferred: 0,
      startedAt: this.#now(),
      finishedAt: null,
      error: null,
      destination: null,
    };

    const sendServer = new TransferSender({
      files: sources,
      onError: (error: Error) => this.#emitError('sender', error),
    });

    const session = new SendSession({
      transferId,
      peer,
      files,
      totalBytes,
      tuning,
      bitmaps: new Map(files.map((f) => [f.fileId, ChunkBitmap.forSize(f.size, tuning.chunkSize)])),
      sources,
      server: sendServer,
      hooks: {
        now: this.#now,
        onProgress: (fileId: string, bytesDone: number, totalDone: number) => {
          this.#emitter.emit('progress', this.#progress(summaryBase, session, fileId, bytesDone, totalDone));
        },
        onFileDone: () => {},
        onComplete: () => {
          // The receiver's `done` frame is the authority; `onTransferControl`
          // resolves the promise. Nothing to do here.
        },
        onError: (error: Error) => {
          // Without this a session failure (e.g. the peer vanished mid-range)
          // leaves the send promise pending until the 60 s idle timeout.
          this.#failPendingSend(transferId, error.message);
        },
      },
    });

    const transfer: ActiveTransfer = {
      transferId,
      peer,
      startedAt: summaryBase.startedAt,
      files,
      totalBytes,
      control,
      direction: 'send',
      session,
      summaryBase,
    };
    this.#transfers.set(transferId, transfer);
    // The HTTP surface serves the same files by absolute path, so a browser can
    // pull the same transfer without a second copy of the bookkeeping.
    this.#sendSources.set(
      transferId,
      new Map([...sources].map(([fileId, source]) => [fileId, {
        absolutePath: source.absolutePath,
        size: source.size,
        sha256: source.sha256,
      }])),
    );

    const { promise, resolve, reject } = withResolvers<TransferSummary>();
    this.#sendRejectors.set(transferId, reject);
    options.onStarted?.(transferId);

    const finish = (summary: TransferSummary): void => {
      this.#transfers.delete(transferId);
      // `#sendSources` is kept: a browser may still be pulling the same files
      // over HTTP after the TCP transfer finished. Entries expire with
      // `stop()` and are bounded by the number of transfers in a session.
      this.#sendRejectors.delete(transferId);
      control.destroy('transfer-finished');
      resolve(summary);
    };
    const failWith = (error: string): void => {
      const summary: TransferSummary = {
        ...summaryBase,
        state: 'failed',
        bytesTransferred: session.transferred,
        finishedAt: this.#now(),
        error,
      };
      this.#transfers.delete(transferId);
      this.#sendRejectors.delete(transferId);
      control.destroy('transfer-failed');
      this.#emitter.emit('transferFailed', { ...summary, error });
      reject(new Error(error));
    };

    // The receiver answers with `offer-result` on the same control link; the
    // data links arrive on our listener and are matched by transferId.
    control.setControlHandler((msg) => {
      switch (msg.t) {
        case 'offer-result':
          if (msg.transferId !== transferId) return;
          if (!msg.accepted) {
            failWith(msg.reason ?? 'declined');
            return;
          }
          break;
        case 'file-done':
        case 'done':
        case 'cancel':
          if (msg.t === 'cancel' && msg.transferId !== transferId) return;
          if (msg.t === 'done' && msg.transferId !== transferId) return;
          if (msg.t === 'file-done' && msg.transferId !== transferId) return;
          session.onTransferControl(msg);
          if (msg.t === 'done') {
            if (msg.ok) {
              const summary: TransferSummary = {
                ...summaryBase,
                state: 'completed',
                bytesTransferred: session.transferred,
                finishedAt: this.#now(),
              };
              this.#emitter.emit('transferCompleted', summary);
              finish(summary);
            } else {
              failWith(msg.reason ?? 'receiver-failed');
            }
          }
          if (msg.t === 'cancel') failWith(`cancelled:${msg.reason}`);
          break;
        case 'err':
          failWith(msg.reason);
          break;
        default:
          return;
      }
    });

    // Send the offer only after the handler is installed: on loopback the
    // receiver can answer within the same tick, and a frame that arrives
    // before `setControlHandler` is dispatched to the dialer's placeholder and
    // lost — the send would then hang until the idle timeout.
    control.writeControl({
      t: 'offer',
      transferId,
      files,
      totalBytes,
      message: options.message ?? null,
      pinRequired: false,
      pinHash: options.pin !== undefined ? createHash('sha256').update(options.pin, 'utf8').digest('hex') : null,
    });

    return promise;
  }

  /**
   * Aborts a transfer in either direction.
   *
   * The peer is told through the control link when it is still open; a dead
   * link needs no notification because the peer already noticed.
   */
  cancel(transferId: string): boolean {
    const transfer = this.#transfers.get(transferId);
    if (transfer === undefined) return false;
    try {
      transfer.control.writeControl({ t: 'cancel', transferId, reason: 'user-cancelled' });
    } catch {
      // Best effort: the session teardown below is what actually stops work.
    }
    transfer.session.cancel('user-cancelled');
    this.#transfers.delete(transferId);
    this.#failPendingSend(transferId, 'cancelled');
    return true;
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  async sendMessage(peer: DiscoveredPeer, text: string): Promise<void> {
    const identity = this.#identity;
    if (identity === null) throw new Error('not started');

    const conn = await dialPeer({
      host: peer.host,
      port: peer.port,
      identity,
      role: 'control',
      localInfo: this.#wireInfo(),
      onControl: () => {},
      onClose: () => {},
    });
    const msgId = randomUUID().replace(/-/g, '').slice(0, 32);
    const { promise, resolve, reject } = withResolvers<void>();
    const timer = setTimeout(() => reject(new Error('msg-timeout')), 10_000);
    conn.setControlHandler((msg) => {
      if (msg.t !== 'msg-ack' || msg.msgId !== msgId) return;
      clearTimeout(timer);
      conn.destroy('msg-done');
      resolve();
    });
    conn.writeControl({ t: 'msg', msgId, text, ts: this.#now() });
    return promise;
  }

  // -------------------------------------------------------------------------
  // Inbound control links
  // -------------------------------------------------------------------------

  #onControlLink(conn: FramedConnection, first: ControlMessage): void {
    const peer = conn.peer;
    if (peer === null) {
      conn.destroy('no-peer');
      return;
    }

    switch (first.t) {
      case 'offer':
        void this.#onIncomingOffer(conn, peer, first);
        return;
      case 'msg':
        this.#emitter.emit('message', { from: peer, text: first.text, ts: first.ts });
        conn.writeControl({ t: 'msg-ack', msgId: first.msgId });
        return;
      default:
        conn.destroy('unexpected-control');
        return;
    }
  }

  async #onIncomingOffer(conn: FramedConnection, peer: WirePeerInfo, offer: Extract<ControlMessage, { t: 'offer' }>): Promise<void> {
    const requiredPin = this.#options.pin;
    if (requiredPin !== undefined) {
      const entry = this.#pinAttempts.get(peer.nodeId);
      if (entry !== undefined && entry.blockedUntil > this.#now()) {
        conn.writeControl({
          t: 'offer-result',
          transferId: offer.transferId,
          accepted: false,
          reason: 'too-many-attempts',
          pinRequired: true,
        });
        conn.destroy('pin-blocked');
        return;
      }
      const expected = createHash('sha256').update(requiredPin, 'utf8').digest('hex');
      if (offer.pinHash === null || offer.pinHash !== expected) {
        this.#recordPinFailure(peer.nodeId);
        conn.writeControl({
          t: 'offer-result',
          transferId: offer.transferId,
          accepted: false,
          reason: 'pin-required',
          pinRequired: true,
        });
        conn.destroy('pin-required');
        return;
      }
      this.#pinAttempts.delete(peer.nodeId);
    }

    const transferOffer: TransferOffer = {
      transferId: offer.transferId,
      from: peer,
      files: offer.files,
      totalBytes: offer.totalBytes,
      message: offer.message,
      pinRequired: offer.pinHash !== null,
    };

    const decision = await this.#decide(transferOffer);
    if (!decision.accepted) {
      conn.writeControl({
        t: 'offer-result',
        transferId: offer.transferId,
        accepted: false,
        reason: decision.reason,
        pinRequired: false,
      });
      conn.destroy('offer-declined');
      return;
    }

    const tuning = { ...DEFAULT_TUNING, ...this.#options.tuning };
    let targets: Map<string, { fileId: string; relativePath: string; size: number; partPath: string; finalPath: string }>;
    try {
      targets = await this.#planTargets(offer.files);
    } catch (error) {
      conn.writeControl({
        t: 'offer-result',
        transferId: offer.transferId,
        accepted: false,
        reason: (error as Error).message,
        pinRequired: false,
      });
      conn.destroy('plan-failed');
      return;
    }

    const writer = new FileReceiverWriter({
      targets,
      verifyHash: true,
    });
    await writer.prepare();

    const summaryBase: TransferSummary = {
      transferId: offer.transferId,
      direction: 'receive',
      peer,
      state: 'accepted',
      files: offer.files,
      totalBytes: offer.totalBytes,
      bytesTransferred: 0,
      startedAt: this.#now(),
      finishedAt: null,
      error: null,
      destination: this.#options.downloadDir,
    };

    // Resume: reuse the bitmap only when the stored metadata describes exactly
    // this sender and this file set. Anything else would splice two versions
    // of a file together, so a mismatch starts from zero.
    const bitmaps = new Map<string, ChunkBitmap>();
    const stored = await this.#loadResume(offer.transferId, offer.files, tuning.chunkSize, peer.nodeId);
    for (const file of offer.files) {
      const resumed = stored?.files.find((f) => f.fileId === file.fileId);
      let bitmap: ChunkBitmap;
      try {
        bitmap = resumed !== undefined
          ? ChunkBitmap.fromBase64(resumed.bitmap, Math.ceil(file.size / tuning.chunkSize), tuning.chunkSize)
          : ChunkBitmap.forSize(file.size, tuning.chunkSize);
      } catch {
        bitmap = ChunkBitmap.forSize(file.size, tuning.chunkSize);
      }
      bitmaps.set(file.fileId, bitmap);
    }
    const session = new ReceiveSession({
      transferId: offer.transferId,
      peer,
      files: offer.files,
      totalBytes: offer.totalBytes,
      tuning,
      bitmaps,
      writer,
      hooks: {
        now: this.#now,
        onProgress: (fileId: string, bytesDone: number, totalDone: number) => {
          this.#emitter.emit('progress', this.#progress(summaryBase, session, fileId, bytesDone, totalDone));
        },
        onFileDone: (fileId: string, bytes: number) => {
          conn.writeControl({ t: 'file-done', transferId: offer.transferId, fileId, sha256: null, bytes });
        },
        onComplete: () => {
          void this.#finishReceive(offer.transferId, conn, writer, summaryBase, session);
        },
        onError: (error) => {
          conn.writeControl({ t: 'done', transferId: offer.transferId, ok: false, reason: error.message });
          void writer.close();
          this.#transfers.delete(offer.transferId);
          const summary: TransferSummary = {
            ...summaryBase,
            state: 'failed',
            bytesTransferred: session.transferred,
            finishedAt: this.#now(),
            error: error.message,
          };
          this.#emitter.emit('transferFailed', { ...summary, error: error.message });
        },
      },
    });

    const transfer: ActiveTransfer = {
      transferId: offer.transferId,
      peer,
      startedAt: summaryBase.startedAt,
      files: offer.files,
      totalBytes: offer.totalBytes,
      control: conn,
      direction: 'receive',
      session,
      summaryBase,
    };
    this.#transfers.set(offer.transferId, transfer);

    conn.writeControl({
      t: 'offer-result',
      transferId: offer.transferId,
      accepted: true,
      reason: null,
      pinRequired: false,
    });
    conn.setControlHandler((msg) => {
      if (msg.t === 'cancel') {
        session.cancel(`peer:${msg.reason}`);
        return;
      }
      if (msg.t === 'err') {
        session.cancel(`peer:${msg.reason}`);
      }
    });

    // Persist the bitmap as ranges complete, throttled: writing on every range
    // would add a JSON encode + fsync per MiB, but only saving on a timer means
    // a short transfer that crashes has nothing to resume from.
    let lastSave = 0;
    // Tracks the in-flight save so completion can wait for it: deleting the
    // metadata while a save is still writing would resurrect the file and
    // leave a stale record claiming a finished transfer is resumable.
    let pendingSave: Promise<void> = Promise.resolve();
    const saveNow = (): void => {
      if (this.#resumeSealed.has(offer.transferId)) return;
      const now = this.#now();
      if (now - lastSave < 250) return;
      lastSave = now;
      pendingSave = this.#saveResume(offer.transferId, peer.nodeId, offer.files, bitmaps, tuning.chunkSize);
    };
    const resumeTimer = setInterval(saveNow, 5_000);
    resumeTimer.unref?.();

    await this.#openDataLinks(session, peer, offer.transferId, tuning.connections, saveNow);
    clearInterval(resumeTimer);
    this.#pendingResumeWrites.set(offer.transferId, () => pendingSave);
  }

  async #finishReceive(
    transferId: string,
    conn: FramedConnection,
    writer: FileReceiverWriter,
    summaryBase: TransferSummary,
    session: ReceiveSession,
  ): Promise<void> {
    try {
      await writer.commit();
    } catch (error) {
      conn.writeControl({ t: 'done', transferId, ok: false, reason: (error as Error).message });
      this.#transfers.delete(transferId);
      const summary: TransferSummary = {
        ...summaryBase,
        state: 'failed',
        bytesTransferred: session.transferred,
        finishedAt: this.#now(),
        error: (error as Error).message,
      };
      this.#emitter.emit('transferFailed', { ...summary, error: (error as Error).message });
      return;
    }
    await writer.close();
    conn.writeControl({ t: 'done', transferId, ok: true, reason: null });
    // Seal first so no later callback can recreate the file, then wait for the
    // last in-flight write before deleting it.
    this.#resumeSealed.add(transferId);
    await this.#pendingResumeWrites.get(transferId)?.().catch(() => {});
    this.#pendingResumeWrites.delete(transferId);
    await this.#resume?.remove(transferId).catch(() => {});
    this.#transfers.delete(transferId);
    const summary: TransferSummary = {
      ...summaryBase,
      state: 'completed',
      bytesTransferred: session.transferred,
      finishedAt: this.#now(),
    };
    this.#emitter.emit('transferCompleted', summary);
  }

  /** Opens the receiver's data links and hands them to the session. */
  async #openDataLinks(
    session: ReceiveSession,
    peer: PeerInfo,
    transferId: string,
    connections: number,
    onRangeDone: () => void,
  ): Promise<void> {
    const identity = this.#identity;
    if (identity === null) return;
    const host = (peer as Partial<DiscoveredPeer>).host ?? '127.0.0.1';

    const linkIndex = new Map<FramedConnection, number>();
    const dials: Promise<void>[] = [];
    for (let i = 0; i < connections; i += 1) {
      dials.push(
        (async () => {
          const conn = await dialPeer({
            host,
            port: peer.port,
            identity,
            role: 'data',
            transferId,
            localInfo: this.#wireInfo(),
            onControl: (msg) => {
              const index = linkIndex.get(conn);
              if (index !== undefined) session.onControl(index, msg);
            },
            onData: (payload) => {
              const index = linkIndex.get(conn);
              if (index === undefined) return;
              void session
                .onData(index, payload)
                .then(() => {
                  if (session.completedRange) onRangeDone();
                })
                .catch((error: Error) => {
                  session.cancel(error.message);
                });
            },
            onClose: () => {
              const index = linkIndex.get(conn);
              if (index !== undefined) session.onLinkLost(index);
            },
          });
          // Register the index before pumping: the peer's `stream-ok` can come
          // back on the same tick, and an unregistered index drops it.
          const index = session.addLink(conn.socket);
          linkIndex.set(conn, index);
          session.start(index);
        })(),
      );
    }
    await Promise.allSettled(dials);
  }

  // -------------------------------------------------------------------------
  // Inbound data links (peer pulls from us)
  // -------------------------------------------------------------------------

  #onDataLink(conn: FramedConnection, first: ControlMessage): void {
    const transferId = conn.transferId;
    if (transferId === null) {
      conn.destroy('missing-transfer-id');
      return;
    }
    const transfer = this.#transfers.get(transferId);
    if (!transfer || transfer.direction !== 'send' || !(transfer.session instanceof SendSession)) {
      conn.destroy('unknown-transfer');
      return;
    }
    const session = transfer.session;
    const index = session.addLink(conn.socket);

    conn.setControlHandler((msg) => {
      if (msg.t === 'stream-req') {
        void session.onStreamRequest(index, msg);
        return;
      }
      session.onControl(index, msg);
    });
    conn.socket.once('close', () => session.onLinkLost(index));

    if (first.t === 'stream-req') void session.onStreamRequest(index, first);
  }

  #onSendControl(msg: ControlMessage): void {
    if (!('transferId' in msg) || typeof msg.transferId !== 'string') return;
    const transfer = this.#transfers.get(msg.transferId);
    if (!transfer || !(transfer.session instanceof SendSession)) return;
    transfer.session.onTransferControl(msg);
  }

  /**
   * A dead control link fails the transfer.
   *
   * Without this the send promise never settles: the receiver can no longer
   * report `done`, so `send()` would hang until the process exits. The data
   * links are useless without the control link that carries the final verdict.
   */
  #onSendControlClosed(transferId: string, error: Error | null): void {
    const transfer = this.#transfers.get(transferId);
    if (!transfer) return;
    if (transfer.session.isFinished) return;
    const reason = error?.message ?? 'control-closed';
    transfer.session.cancel(reason);
    this.#transfers.delete(transferId);
    const summary: TransferSummary = {
      ...transfer.summaryBase,
      state: 'failed',
      bytesTransferred: transfer.session.transferred,
      finishedAt: this.#now(),
      error: reason,
    };
    this.#emitter.emit('transferFailed', { ...summary, error: reason });
    this.#failPendingSend(transferId, reason);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async #decide(offer: TransferOffer): Promise<OfferDecision> {
    if (this.#options.autoAccept !== undefined) {
      try {
        return this.#options.autoAccept(offer) ? { accepted: true } : { accepted: false, reason: 'declined' };
      } catch (error) {
        this.#emitError('autoAccept', error as Error);
        return { accepted: false, reason: 'declined' };
      }
    }
    const { promise, resolve } = withResolvers<OfferDecision>();
    this.#emitter.emit('offer', { offer, respond: resolve });
    return promise;
  }

  /**
   * Maps the offer's relative paths onto unique paths inside `downloadDir`.
   *
   * Uniqueness is resolved here, before any byte arrives, so the receiver
   * never has to rename a file mid-transfer and resume metadata stays valid.
   */
  async #loadResume(
    transferId: string,
    files: readonly FileEntry[],
    chunkSize: number,
    from: string,
  ): Promise<ResumeState | null> {
    const store = this.#resume;
    if (store === null) return null;
    const state = await store.load(transferId);
    if (state === null) return null;
    const manifest = files.map((f) => ({ fileId: f.fileId, size: f.size }));
    return ResumeStore.matches(state, { files: manifest, chunkSize, from }) ? state : null;
  }

  async #saveResume(
    transferId: string,
    from: string,
    files: readonly FileEntry[],
    bitmaps: ReadonlyMap<string, ChunkBitmap>,
    chunkSize: number,
  ): Promise<void> {
    const store = this.#resume;
    if (store === null) return;
    try {
      await store.save({
        v: 1,
        transferId,
        from,
        createdAt: this.#now(),
        files: files.map((file) => ({
          fileId: file.fileId,
          relativePath: file.relativePath,
          size: file.size,
          chunkSize,
          bitmap: bitmaps.get(file.fileId)?.toBase64() ?? '',
        })),
      });
    } catch (error) {
      this.#emitError('resume:save', error as Error);
    }
  }

  async #planTargets(files: readonly FileEntry[]): Promise<Map<string, { fileId: string; relativePath: string; size: number; partPath: string; finalPath: string }>> {
    const out = new Map<string, { fileId: string; relativePath: string; size: number; partPath: string; finalPath: string }>();
    const used = new Set<string>();
    for (const file of files) {
      const sanitized = sanitizeRelativePath(file.relativePath);
      if (sanitized === null) throw new Error('unsafe-path');
      let candidate = safeJoin(this.#options.downloadDir, sanitized);
      // Collisions come from two places: two files in this same offer, and a
      // file that already exists from an earlier transfer. Both must produce
      // `name (1).ext`, never an overwrite — the receiver cannot know whether
      // the user wanted the old copy replaced.
      if (used.has(candidate) || (await exists(candidate))) {
        const parts = sanitized.split('/');
        const dir = parts.length > 1 ? candidate.slice(0, candidate.length - parts[parts.length - 1]!.length - 1) : this.#options.downloadDir;
        candidate = await uniquePath(dir, parts[parts.length - 1] ?? 'file');
      }
      used.add(candidate);
      out.set(file.fileId, {
        fileId: file.fileId,
        relativePath: sanitized,
        size: file.size,
        partPath: partPathFor(candidate),
        finalPath: candidate,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // HTTP transport handlers
  // -------------------------------------------------------------------------

  /**
   * An offer arrived over HTTP.
   *
   * Same acceptance policy as the TCP path, but the response carries the
   * resume bitmaps: a browser (or `URLSession`) can then skip chunks the
   * receiver already has, which is what makes an interrupted browser upload
   * resumable instead of restarting.
   */
  async #onHttpOffer(request: {
    transferId: string;
    files: readonly FileEntry[];
    totalBytes: number;
    from: string;
  }): Promise<{ accepted: boolean; reason: string | null; bitmaps: Record<string, string>; chunkSize: number }> {
    const tuning = { ...DEFAULT_TUNING, ...this.#options.tuning };
    const offer: TransferOffer = {
      transferId: request.transferId,
      from: {
        nodeId: request.from,
        alias: request.from,
        platform: 'unknown',
        deviceModel: 'browser',
        version: 'http',
        port: this.#httpPort,
        fingerprint: request.from,
        protocolVersions: [1],
      },
      files: request.files,
      totalBytes: request.totalBytes,
      message: null,
      pinRequired: false,
    };

    const decision = await this.#decide(offer);
    if (!decision.accepted) {
      return { accepted: false, reason: decision.reason, bitmaps: {}, chunkSize: tuning.chunkSize };
    }

    const targets = await this.#planTargets(request.files);
    const files = new Map<string, { path: string; size: number; handle: import('node:fs/promises').FileHandle }>();
    const bitmaps: Record<string, string> = {};
    const { open } = await import('node:fs/promises');

    for (const file of request.files) {
      const target = targets.get(file.fileId);
      if (!target) continue;
      await mkdir(dirname(target.partPath), { recursive: true });
      const handle = await open(target.partPath, 'r+').catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        const created = await open(target.partPath, 'w+');
        await created.truncate(file.size);
        return created;
      });
      const info = await handle.stat();
      if (info.size !== file.size) await handle.truncate(file.size);
      files.set(file.fileId, { path: target.partPath, size: file.size, handle });
      bitmaps[file.fileId] = ChunkBitmap.forSize(file.size, tuning.chunkSize).toBase64();
    }

    this.#httpTransfers.set(request.transferId, {
      files,
      downloadDir: this.#options.downloadDir,
    });
    // Keep the final paths so `done` can commit them.
    this.#httpTargets.set(request.transferId, targets);

    return { accepted: true, reason: null, bitmaps, chunkSize: tuning.chunkSize };
  }

  /** A browser pulled a range from a transfer we are sending. */
  async #onHttpRange(params: {
    transferId: string;
    fileId: string;
    offset: number;
    length: number;
  }): Promise<{ path: string; size: number; sha256: string | null } | null> {
    // Deliberately independent of `#transfers`: the HTTP surface serves files
    // that were offered at any point in this session, including after the TCP
    // side finished or was declined.
    const source = this.#sendSources.get(params.transferId)?.get(params.fileId);
    if (!source) return null;
    return { path: source.absolutePath, size: source.size, sha256: source.sha256 };
  }

  /** A browser uploaded one chunk. */
  async #onHttpUpload(params: {
    transferId: string;
    fileId: string;
    offset: number;
    body: Buffer;
  }): Promise<void> {
    const transfer = this.#httpTransfers.get(params.transferId);
    if (!transfer) throw new Error('unknown-transfer');
    const file = transfer.files.get(params.fileId);
    if (!file) throw new Error('unknown-file');
    if (params.offset + params.body.length > file.size) throw new Error('offset-out-of-range');

    let written = 0;
    while (written < params.body.length) {
      const result = await file.handle.write(
        params.body,
        written,
        params.body.length - written,
        params.offset + written,
      );
      if (result.bytesWritten <= 0) throw new Error('short-write');
      written += result.bytesWritten;
    }
  }

  /** The browser finished; commit the part files. */
  async #onHttpDone(transferId: string, ok: boolean): Promise<void> {
    const transfer = this.#httpTransfers.get(transferId);
    const targets = this.#httpTargets.get(transferId);
    this.#httpTransfers.delete(transferId);
    this.#httpTargets.delete(transferId);
    if (!transfer) return;

    for (const file of transfer.files.values()) await file.handle.close().catch(() => {});

    if (!ok || !targets) {
      for (const target of targets?.values() ?? []) await rm(target.partPath, { force: true }).catch(() => {});
      return;
    }

    for (const target of targets.values()) {
      await mkdir(dirname(target.finalPath), { recursive: true });
      await rename(target.partPath, target.finalPath).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
        await rm(target.finalPath, { force: true });
        await rename(target.partPath, target.finalPath);
      });
    }
  }

  /** Rejects a pending `send()` promise; no-op when it already settled. */
  #failPendingSend(transferId: string, reason: string): void {
    const reject = this.#sendRejectors.get(transferId);
    if (reject === undefined) return;
    this.#sendRejectors.delete(transferId);
    reject(new Error(reason));
  }

  /** Effective tuning: defaults overlaid with the service-wide overrides. */
  #tuning(): TransferTuning {
    return { ...DEFAULT_TUNING, ...this.#options.tuning };
  }

  #progress(
    base: TransferSummary,
    session: SendSession | ReceiveSession,
    fileId: string,
    bytesDone: number,
    totalTransferred: number,
  ): TransferProgress {
    const file = base.files.find((f) => f.fileId === fileId);
    return {
      transferId: base.transferId,
      direction: base.direction,
      peer: base.peer,
      fileId,
      relativePath: file?.relativePath ?? fileId,
      bytes: bytesDone,
      size: file?.size ?? 0,
      totalBytes: base.totalBytes,
      totalTransferred,
      speedBps: session.bytesPerSecond,
      etaMs: session.etaMs,
    };
  }

  #wireInfo(): WirePeerInfo {
    const identity = this.#identity;
    if (identity === null) throw new Error('not started');
    return toWireInfo(identity, {
      port: this.#port || (this.#options.port ?? DEFAULT_PORT),
      ...(this.#options.alias !== undefined ? { alias: this.#options.alias } : {}),
      platform: this.#options.platform ?? platformName(),
      deviceModel: this.#options.deviceModel ?? hostname(),
      version: this.#options.version ?? '0.1.0',
    });
  }

  /**
   * Counts a wrong PIN and blocks the peer for a growing window.
   *
   * Blocking is per nodeId rather than per IP: an attacker on the LAN can
   * rotate addresses, but rotating a nodeId means generating a new key pair,
   * which the handshake forces them to prove they own.
   */
  #recordPinFailure(nodeId: string): void {
    const entry = this.#pinAttempts.get(nodeId) ?? { failures: 0, blockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= MAX_PIN_ATTEMPTS) {
      // 1 minute, doubling per excess failure, capped at one hour.
      const over = entry.failures - MAX_PIN_ATTEMPTS;
      entry.blockedUntil = this.#now() + Math.min(60 * 60 * 1000, 60_000 * 2 ** over);
    }
    this.#pinAttempts.set(nodeId, entry);
  }

  #emitError(scope: string, error: Error): void {
    this.#emitter.emit('error', { scope, error });
  }
}

/** True when a path exists (any type). Used to avoid overwriting received files. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function platformName(): PeerInfo['platform'] {
  switch (osPlatform()) {
    case 'win32':
      return 'win32';
    case 'darwin':
      return 'darwin';
    case 'linux':
      return 'linux';
    case 'android':
      return 'android';
    default:
      return 'unknown';
  }
}

export { encodeControl, decodeControl };
