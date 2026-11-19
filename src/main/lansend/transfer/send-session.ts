/**
 * Send-side session: answers `stream-req` from a peer that is pulling.
 *
 * Unlike the receive side there is no scheduler here — the peer decides what
 * to pull and in which order. Our job is to serve each request exactly and to
 * know when the transfer is finished, which we infer from the receiver's
 * `done` frame rather than from our own bookkeeping: the receiver is the only
 * party that knows what actually landed on disk.
 */

import type { ControlMessage, FileEntry, PeerInfo, StreamReqMessage, TransferTuning } from '../protocol/types';
import type { ChunkBitmap } from './bitmap';
import { TransferSessionBase, type SessionHooks, type SessionSocket } from './session';

/** What the sender needs to know about one file to serve it. */
export interface SendFileSource {
  readonly fileId: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly sha256: string | null;
}

/**
 * Serves a single range. Injected so the session is testable without a disk.
 *
 * The implementation owns the whole exchange — `stream-ok`, the DATA frames,
 * `stream-end` — because the wire format forbids interleaving and splitting
 * that sequence across two objects invites a frame landing in the wrong order.
 */
export interface RangeServer {
  serve(socket: SessionSocket, req: StreamReqMessage): Promise<{ readonly bytes: number; readonly sha256: string | null }>;
}

export class SendSession extends TransferSessionBase {
  readonly #sources: ReadonlyMap<string, SendFileSource>;
  readonly #server: RangeServer;
  readonly #links: Array<{ socket: SessionSocket; inFlight: null; dead: boolean }> = [];
  #onServeError: (error: Error) => void;

  constructor(params: {
    transferId: string;
    peer: PeerInfo;
    files: readonly FileEntry[];
    totalBytes: number;
    tuning: TransferTuning;
    hooks: SessionHooks;
    bitmaps: ReadonlyMap<string, ChunkBitmap>;
    sources: ReadonlyMap<string, SendFileSource>;
    server: RangeServer;
    onServeError?: (error: Error) => void;
  }) {
    super({ ...params, direction: 'send' });
    this.#sources = params.sources;
    this.#server = params.server;
    this.#onServeError = params.onServeError ?? (() => {});
  }

  override links(): readonly { socket: SessionSocket; inFlight: null; dead: boolean }[] {
    return this.#links;
  }

  addLink(socket: SessionSocket): number {
    const index = this.#links.length;
    this.#links.push({ socket, inFlight: null, dead: false });
    return index;
  }

  /**
   * Handles a `stream-req`. The range is served asynchronously; the caller
   * (the data-connection handler) must not read further control frames until
   * this resolves, because the wire format forbids interleaving.
   */
  async onStreamRequest(index: number, msg: Extract<ControlMessage, { t: 'stream-req' }>): Promise<void> {
    const link = this.#links[index];
    if (!link || link.dead || this.finished) return;

    const source = this.#sources.get(msg.fileId);
    if (!source) {
      this.#write(index, { t: 'stream-error', fileId: msg.fileId, reason: 'not-found' });
      return;
    }
    if (msg.offset > source.size) {
      this.#write(index, { t: 'stream-error', fileId: msg.fileId, reason: 'bad-offset' });
      return;
    }

    try {
      // The served count comes from the server, not from the request: it is
      // clamped to EOF and it is zero when the range failed, so crediting the
      // requested length would over-report progress.
      const served = await this.#server.serve(link.socket, msg);
      if (served.bytes <= 0) {
        // The server already told the peer why (size-changed, not-found, ...).
        // A zero-byte serve means the range failed, so the transfer cannot
        // complete; failing here turns a silent 60 s idle timeout into an
        // immediate, explanatory error.
        this.fail(new Error('range-failed'));
        return;
      }
      this.recordBytes(served.bytes);
      this.#markServed(msg.fileId, msg.offset, served.bytes);
      this.emitProgress(msg.fileId);
    } catch (error) {
      // The range server already wrote a `stream-error` for protocol-level
      // problems; anything that escapes is IO, and only kills this link.
      this.#onServeError(error as Error);
      if (link.socket.destroyed) this.#links[index] = { socket: link.socket, inFlight: null, dead: true };
    }
  }

  /** Handles control frames that arrive on a data link after the request. */
  onControl(index: number, msg: ControlMessage): void {
    const link = this.#links[index];
    if (!link || link.dead) return;
    switch (msg.t) {
      case 'stream-ack':
        // Informational: the receiver reports how much is durably on disk.
        return;
      case 'err':
        this.fail(new Error(msg.reason));
        return;
      default:
        return;
    }
  }

  /** Handles a control-link frame for this transfer. */
  onTransferControl(msg: ControlMessage): void {
    switch (msg.t) {
      case 'done':
        if (msg.transferId !== this.transferId) return;
        if (msg.ok) this.succeed();
        else this.fail(new Error(msg.reason ?? 'receiver-failed'));
        return;
      case 'cancel':
        if (msg.transferId !== this.transferId) return;
        this.fail(new Error(`cancelled:${msg.reason}`));
        return;
      case 'file-done': {
        if (msg.transferId !== this.transferId) return;
        const file = this.fileById(msg.fileId);
        if (file) this.hooks.onFileDone(msg.fileId, msg.bytes, msg.sha256);
        return;
      }
      default:
        return;
    }
  }

  onLinkLost(index: number): void {
    const link = this.#links[index];
    if (!link) return;
    link.dead = true;
  }

  #markServed(fileId: string, offset: number, bytes: number): void {
    const bitmap = this.bitmaps.get(fileId);
    const file = this.fileById(fileId);
    if (!bitmap || !file) return;
    const chunkSize = this.tuning.chunkSize;
    const end = offset + bytes;
    for (let at = offset; at < end; at += chunkSize) {
      const index = Math.floor(at / chunkSize);
      const chunkEnd = Math.min(end, (index + 1) * chunkSize);
      const fileEnd = Math.min(file.size, (index + 1) * chunkSize);
      if (chunkEnd >= fileEnd) bitmap.set(index);
    }
  }

  #write(index: number, msg: ControlMessage): void {
    const link = this.#links[index];
    if (!link || link.dead || link.socket.destroyed) return;
    const payload = Buffer.from(JSON.stringify(msg), 'utf8');
    const head = Buffer.allocUnsafe(5);
    head.writeUInt32BE(payload.length + 1, 0);
    head.writeUInt8(1, 4);
    link.socket.cork();
    try {
      link.socket.write(head);
      link.socket.write(payload);
    } finally {
      link.socket.uncork();
    }
  }
}

export type { SessionHooks };
