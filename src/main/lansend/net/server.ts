/**
 * The TCP listener that every peer runs, plus the outbound dialer.
 *
 * One port serves both planes. An inbound connection is routed by the role it
 * declares in its signed `hello`:
 *  - `control` → the peer is offering us files (or answering an offer);
 *  - `data` → the peer is pulling bytes from us.
 *
 * Because the role is inside the signature, a connection cannot be replayed
 * from one plane into the other.
 */

import { connect, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

import type { StoredIdentity, WirePeerInfo } from '../crypto/identity';
import { CONNECT_TIMEOUT_MS, DEFAULT_PORT } from '../protocol/constants';
import { FramedConnection, type PeerRole } from './connection';
import type { ControlMessage } from '../protocol/types';
import { withResolvers } from '../util/promise';

export type ControlHandler = (conn: FramedConnection, first: ControlMessage) => void;
export type DataHandler = (conn: FramedConnection, first: ControlMessage) => void;

export interface ConnectionRouter {
  /** A peer completed a control handshake; `first` is the peer's `hello`. */
  onControl: ControlHandler;
  /** A peer completed a data handshake and wants to pull bytes. */
  onData: DataHandler;
  /** A connection died or misbehaved; `scope` is for logging. */
  onConnectionError: (scope: string, error: Error) => void;
}

export interface ServerOptions {
  readonly identity: StoredIdentity;
  readonly localInfo: () => WirePeerInfo;
  readonly router: ConnectionRouter;
  readonly preferredPort?: number;
  /** Ports to try after the preferred one is taken. */
  readonly portSearchRange?: number;
  readonly host?: string;
}

/**
 * Accepts connections and routes each one after its handshake completes.
 *
 * The first control frame is held until the handshake succeeds, so a router
 * handler always sees an authenticated `conn.peer`.
 */
export class TransferServer {
  readonly #options: ServerOptions;
  #server: Server | null = null;
  #port = 0;
  #connections = new Set<FramedConnection>();
  /** Suppresses error reporting while shutting down: a closed socket is expected then. */
  #stopping = false;

  constructor(options: ServerOptions) {
    this.#options = options;
  }

  get port(): number {
    return this.#port;
  }

  get listening(): boolean {
    return this.#server?.listening === true;
  }

  /**
   * Binds and starts accepting. `preferredPort: 0` asks the OS for an
   * ephemeral port, which is what tests use.
   *
   * A taken port is not fatal: we walk forward a few ports because another
   * instance (or a socket in TIME_WAIT) is common on a desktop.
   */
  async start(): Promise<number> {
    if (this.#server !== null) throw new Error('server already started');

    const preferred = this.#options.preferredPort ?? DEFAULT_PORT;
    const range = preferred === 0 ? 1 : (this.#options.portSearchRange ?? 10);

    let lastError: Error | null = null;
    for (let offset = 0; offset < range; offset += 1) {
      const port = preferred === 0 ? 0 : preferred + offset;
      const server = createServer((socket) => this.#accept(socket));
      const bound = await listen(server, port, this.#options.host, (error) => {
        lastError = error;
      });
      if (bound !== null) {
        this.#server = server;
        this.#port = bound;
        server.on('error', (error) => this.#options.router.onConnectionError('server', error));
        return bound;
      }
      server.close();
    }
    throw lastError ?? new Error('cannot bind any port');
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    for (const conn of this.#connections) conn.destroy('server-stop');
    this.#connections.clear();
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    const { promise, resolve } = withResolvers<void>();
    server.close(() => resolve());
    await promise;
  }

  #accept(socket: Socket): void {
    let routed = false;
    const conn = new FramedConnection({
      socket,
      identity: this.#options.identity,
      role: null,
      expectRole: 'any',
      localInfo: this.#options.localInfo(),
      onControl: (msg, c) => {
        // Only the first frame is routed; the router installs its own handler
        // via `setControlHandler` before returning.
        if (routed) {
          this.#options.router.onConnectionError('unrouted-control', new Error(`unhandled ${msg.t}`));
          c.destroy('unrouted-control');
          return;
        }
        routed = true;
        if (c.role === 'control') this.#options.router.onControl(c, msg);
        else if (c.role === 'data') this.#options.router.onData(c, msg);
        else c.destroy('unknown-role');
      },
      onClose: (error) => {
        this.#connections.delete(conn);
        if (error !== null && !this.#stopping) this.#options.router.onConnectionError('connection', error);
      },
    });
    this.#connections.add(conn);
  }
}

/** Resolves with the bound port, or null when the port is unavailable. */
function listen(server: Server, port: number, host: string | undefined, onError: (e: Error) => void): Promise<number | null> {
  const { promise, resolve } = withResolvers<number | null>();
  const handleError = (error: Error): void => {
    server.removeListener('listening', handleListening);
    onError(error);
    resolve(null);
  };
  const handleListening = (): void => {
    server.removeListener('error', handleError);
    const address = server.address();
    resolve(address !== null && typeof address !== 'string' ? address.port : null);
  };
  server.once('error', handleError);
  server.once('listening', handleListening);
  server.listen({ port, host, exclusive: true });
  return promise;
}

export interface DialOptions {
  readonly host: string;
  readonly port: number;
  readonly identity: StoredIdentity;
  readonly role: PeerRole;
  readonly transferId?: string;
  readonly localInfo: WirePeerInfo;
  readonly onControl: (msg: ControlMessage, conn: FramedConnection) => void;
  readonly onData?: (payload: Buffer, conn: FramedConnection) => void;
  readonly onClose?: (error: Error | null) => void;
  readonly timeoutMs?: number;
}

/**
 * Dials a peer and completes a handshake with the given role.
 *
 * Resolves once the peer's `hello-ok` has been verified, so the caller can
 * write business frames immediately. No retries: the caller knows whether a
 * refusal is transient or fatal.
 */
export function dialPeer(options: DialOptions): Promise<FramedConnection> {
  const { promise, resolve, reject } = withResolvers<FramedConnection>();
  const socket = connect({ host: options.host, port: options.port });
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;

  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    socket.destroy();
    reject(new Error('connect-timeout'));
  }, timeoutMs);
  timer.unref?.();

  socket.once('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  });

  socket.once('connect', () => {
    socket.removeAllListeners('error');
    const conn = new FramedConnection({
      socket,
      identity: options.identity,
      role: options.role,
      expectRole: options.role,
      ...(options.transferId !== undefined ? { transferId: options.transferId } : {}),
      localInfo: options.localInfo,
      onControl: options.onControl,
      onData: options.onData,
      onReady: (_peer, c) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(c);
      },
      onClose: (error) => {
        options.onClose?.(error);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error ?? new Error('closed-before-handshake'));
      },
    });
    conn.sendHello();
  });

  return promise;
}
