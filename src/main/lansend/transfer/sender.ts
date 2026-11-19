/**
 * Sender side of the data plane.
 *
 * One `stream-req` is served entirely on the connection that carried it:
 * `stream-ok`, exactly `length` bytes of DATA, then `stream-end`. The wire
 * format forbids interleaving, which is why `serve` never has to demultiplex.
 *
 * The receiver pulls, so backpressure is cheap: when a socket write returns
 * false the read stream is paused until `drain`. A sender that ignored this
 * sign would read the whole file into socket memory and lose to a slow peer.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { DEFAULT_CHUNK_SIZE } from '../protocol/constants';
import { encodeControlFrame, writeDataFrame } from '../protocol/frame';
import type { ControlMessage, StreamReqMessage } from '../protocol/types';
import type { DuplexLike } from './types';
import { withResolvers } from '../util/promise';

export interface SenderFileSource {
  readonly fileId: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly sha256: string | null;
}

/** What actually went on the wire for one range. */
export interface ServedRange {
  readonly bytes: number;
  readonly sha256: string | null;
}

export interface TransferSenderOptions {
  readonly files: ReadonlyMap<string, SenderFileSource>;
  readonly onError?: (error: Error) => void;
  /** Read buffer size. Defaults to the protocol chunk size. */
  readonly chunkSize?: number;
}

const EMPTY: ServedRange = { bytes: 0, sha256: null };

/**
 * Bytes held under one cork before flushing.
 *
 * 4 MiB keeps the writev list short (4 entries at the default 1 MiB read size)
 * while cutting syscalls by 4x. Larger batches mostly increase the amount of
 * data buffered ahead of a slow peer.
 */
const BATCH_BYTES = 4 * 1024 * 1024;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function sendControl(socket: DuplexLike, msg: ControlMessage): void {
  socket.write(encodeControlFrame(JSON.stringify(msg)));
}

/** Resolves false when the peer went away before the socket could drain. */
function waitForDrain(socket: DuplexLike): Promise<boolean> {
  if (socket.destroyed) return Promise.resolve(false);
  const { promise, resolve } = withResolvers<boolean>();
  let settled = false;
  const finish = (alive: boolean): void => {
    if (settled) return;
    settled = true;
    socket.off?.('drain', onDrain);
    socket.off?.('close', onClose);
    resolve(alive);
  };
  const onDrain = (): void => finish(true);
  const onClose = (): void => finish(false);
  socket.once('drain', onDrain);
  socket.on?.('close', onClose);
  return promise;
}

export class TransferSender {
  readonly #files: ReadonlyMap<string, SenderFileSource>;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #chunkSize: number;

  constructor(opts: TransferSenderOptions) {
    this.#files = opts.files;
    this.#onError = opts.onError;
    this.#chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  /**
   * Serves one request. Protocol-level failures (unknown file, bad offset,
   * size change) become a `stream-error` frame, not a rejection: the
   * connection stays usable and the receiver can retry or move on.
   *
   * The resolved count is the number of DATA bytes written, which the session
   * uses for progress accounting. Callers that only await completion can
   * ignore it — the frames are the actual contract.
   */
  async serve(socket: DuplexLike, req: StreamReqMessage): Promise<ServedRange> {
    try {
      return await this.#serve(socket, req);
    } catch (error) {
      this.#onError?.(asError(error));
      if (!socket.destroyed) sendControl(socket, { t: 'stream-error', fileId: req.fileId, reason: 'io-error' });
      return EMPTY;
    }
  }

  async #serve(socket: DuplexLike, req: StreamReqMessage): Promise<ServedRange> {
    if (socket.destroyed) return EMPTY;

    const file = this.#files.get(req.fileId);
    if (!file) {
      sendControl(socket, { t: 'stream-error', fileId: req.fileId, reason: 'not-found' });
      return EMPTY;
    }
    if (
      !Number.isSafeInteger(req.offset) ||
      req.offset < 0 ||
      req.offset > file.size ||
      !Number.isSafeInteger(req.length) ||
      req.length < 0
    ) {
      sendControl(socket, { t: 'stream-error', fileId: req.fileId, reason: 'bad-offset' });
      return EMPTY;
    }

    let info;
    try {
      info = await stat(file.absolutePath);
    } catch {
      sendControl(socket, { t: 'stream-error', fileId: req.fileId, reason: 'not-found' });
      return EMPTY;
    }
    if (!info.isFile() || info.size !== file.size) {
      sendControl(socket, { t: 'stream-error', fileId: req.fileId, reason: 'size-changed' });
      return EMPTY;
    }

    const length = Math.min(req.length, file.size - req.offset);
    const wholeFile = req.offset === 0 && length === file.size;
    sendControl(socket, { t: 'stream-ok', fileId: req.fileId, offset: req.offset, length });

    if (length === 0) {
      const sha256 = wholeFile ? createHash('sha256').digest('hex') : null;
      sendControl(socket, { t: 'stream-end', fileId: req.fileId, offset: req.offset, bytes: 0, sha256 });
      return { bytes: 0, sha256 };
    }

    const hash = wholeFile ? createHash('sha256') : null;
    const stream = createReadStream(file.absolutePath, {
      start: req.offset,
      end: req.offset + length - 1,
      highWaterMark: this.#chunkSize,
    });

    let sent = 0;
    try {
      // Batch frames into one writev.
      //
      // `writeDataFrame` already corks per frame, but that still costs one
      // syscall per MiB. Holding the cork across a group of frames turns N
      // syscalls into one; the socket's own buffer bounds the batch, so memory
      // stays flat when the peer is slow.
      let batched = 0;
      let corked = false;
      const openCork = (): void => {
        if (corked) return;
        corked = true;
        socket.cork();
      };
      const flushCork = (): void => {
        if (!corked) return;
        corked = false;
        socket.uncork();
      };

      for await (const chunk of stream) {
        if (socket.destroyed) {
          flushCork();
          stream.destroy();
          return { bytes: sent, sha256: null };
        }
        hash?.update(chunk);
        sent += chunk.length;
        batched += chunk.length;

        openCork();
        const ok = writeDataFrame(socket, chunk);

        // Flush on backpressure or once the batch reaches 4 MiB, whichever
        // comes first, so a fast link still gets one syscall per 4 MiB while a
        // slow one degrades to per-frame writes.
        if (!ok || batched >= BATCH_BYTES) {
          flushCork();
          batched = 0;
        }
        if (!ok) {
          stream.pause();
          const alive = await waitForDrain(socket);
          if (!alive) {
            stream.destroy();
            return { bytes: sent, sha256: null };
          }
          stream.resume();
        }
      }
      flushCork();
    } catch (error) {
      stream.destroy();
      if (socket.destroyed) return { bytes: sent, sha256: null };
      this.#onError?.(asError(error));
      sendControl(socket, { t: 'stream-error', fileId: req.fileId, reason: 'io-error' });
      return { bytes: sent, sha256: null };
    }

    if (socket.destroyed) return { bytes: sent, sha256: null };
    if (sent !== length) {
      sendControl(socket, { t: 'stream-error', fileId: req.fileId, reason: 'size-changed' });
      return { bytes: sent, sha256: null };
    }
    const sha256 = hash ? hash.digest('hex') : null;
    sendControl(socket, {
      t: 'stream-end',
      fileId: req.fileId,
      offset: req.offset,
      bytes: sent,
      sha256,
    });
    return { bytes: sent, sha256 };
  }
}
