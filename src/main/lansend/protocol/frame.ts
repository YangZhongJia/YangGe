/**
 * Frame codec: `u32be length | u8 kind | payload`.
 *
 * Why a length prefix instead of newline-delimited JSON: data frames carry raw
 * file bytes, which may contain any byte sequence including newlines. A length
 * prefix also lets the reader know exactly how much to expect, so a frame can
 * be assembled once instead of growing a buffer incrementally.
 *
 * The decoder keeps a queue of the socket's own buffers and only copies when a
 * frame straddles a segment boundary. The naive alternative — concatenating
 * `pending + chunk` on every arrival — copies the whole partial frame for each
 * TCP segment: a 1 MiB frame arriving in 16 KiB pieces would copy ~8 MiB to
 * deliver 1 MiB, and the transfer speed collapses as the frame grows. That is
 * the single biggest throughput bug this design avoids.
 */

import {
  FRAME_CONTROL,
  FRAME_DATA,
  FRAME_HEADER_BYTES,
  MAX_CONTROL_FRAME_BYTES,
  MAX_DATA_FRAME_BYTES,
} from './constants';

export type DecodedFrame =
  | { readonly kind: 'control'; readonly payload: Buffer }
  | { readonly kind: 'data'; readonly payload: Buffer };

export type FrameError = 'bad-length' | 'oversize-control' | 'oversize-data' | 'unknown-kind' | 'empty-frame';

export class FrameDecodeError extends Error {
  readonly reason: FrameError;

  constructor(reason: FrameError, detail?: string) {
    super(`frame decode failed: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'FrameDecodeError';
    this.reason = reason;
  }
}

/** Shared scratch for the 5-byte header when it straddles segments. */
const HEADER_SCRATCH = Buffer.allocUnsafe(FRAME_HEADER_BYTES);

/**
 * Encodes a control payload (already-serialized JSON bytes) into a frame.
 *
 * Returns a single Buffer: control frames are small, so the copy is cheaper
 * than two syscalls.
 */
export function encodeControlFrame(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length === 0) throw new FrameDecodeError('empty-frame');
  if (body.length + 1 > MAX_CONTROL_FRAME_BYTES) throw new FrameDecodeError('oversize-control');
  const head = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  head.writeUInt32BE(body.length + 1, 0);
  head.writeUInt8(FRAME_CONTROL, 4);
  return Buffer.concat([head, body], FRAME_HEADER_BYTES + body.length);
}

/**
 * Writes a data frame with two socket writes instead of one concatenated
 * Buffer. `cork()`/`uncork()` make Node coalesce them into a single `writev`,
 * so the file bytes are never copied into a header-prefixed buffer. At 1 GiB/s
 * that saves a full memory copy of every byte transferred.
 */
export function writeDataFrame(socket: { cork(): void; write(b: Buffer): boolean; uncork(): void }, payload: Buffer): boolean {
  if (payload.length === 0) throw new FrameDecodeError('empty-frame');
  if (payload.length + 1 > MAX_DATA_FRAME_BYTES) throw new FrameDecodeError('oversize-data');
  const head = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  head.writeUInt32BE(payload.length + 1, 0);
  head.writeUInt8(FRAME_DATA, 4);
  socket.cork();
  try {
    socket.write(head);
    return socket.write(payload);
  } finally {
    socket.uncork();
  }
}

/**
 * Incremental frame decoder.
 *
 * Holds the segments that are not yet part of a complete frame. `push` returns
 * every frame that became complete, in order.
 */
export class FrameDecoder {
  /** Segments with unread bytes, oldest first. */
  #segments: Buffer[] = [];
  #pendingBytes = 0;
  #failed: FrameDecodeError | null = null;

  /** Bytes currently buffered but not yet emitted. */
  get buffered(): number {
    return this.#pendingBytes;
  }

  get failed(): FrameDecodeError | null {
    return this.#failed;
  }

  push(chunk: Buffer): DecodedFrame[] {
    if (this.#failed) throw this.#failed;
    if (chunk.length === 0) return [];

    this.#segments.push(chunk);
    this.#pendingBytes += chunk.length;

    const out: DecodedFrame[] = [];
    for (;;) {
      if (this.#pendingBytes < FRAME_HEADER_BYTES) break;

      const header = this.#peekHeader();
      const len = header.readUInt32BE(0);
      if (len < 1) {
        this.#failed = new FrameDecodeError('bad-length', 'zero');
        throw this.#failed;
      }
      const kindByte = header.readUInt8(4);
      const limit = kindByte === FRAME_DATA ? MAX_DATA_FRAME_BYTES : MAX_CONTROL_FRAME_BYTES;
      if (len > limit) {
        this.#failed = new FrameDecodeError(kindByte === FRAME_DATA ? 'oversize-data' : 'oversize-control', `len=${len}`);
        throw this.#failed;
      }

      const total = 4 + len;
      if (this.#pendingBytes < total) break;

      out.push(this.#takeFrame(kindByte, total, len));
    }

    return out;
  }

  /** Drops buffered bytes; used when a connection is torn down. */
  reset(): void {
    this.#segments = [];
    this.#pendingBytes = 0;
    this.#failed = null;
  }

  /** Reads the 5-byte header without consuming it. */
  #peekHeader(): Buffer {
    const first = this.#segments[0]!;
    if (first.length >= FRAME_HEADER_BYTES) return first;
    // Straddling header: the only case where a copy is unavoidable.
    let filled = 0;
    for (const segment of this.#segments) {
      const take = Math.min(segment.length, FRAME_HEADER_BYTES - filled);
      segment.copy(HEADER_SCRATCH, filled, 0, take);
      filled += take;
      if (filled === FRAME_HEADER_BYTES) break;
    }
    return HEADER_SCRATCH;
  }

  /**
   * Consumes one complete frame and returns its payload.
   *
   * When the whole frame lives in the first segment the payload is a
   * `subarray` view — zero copies, which is the common case because the sender
   * writes each data frame with a single `writev`.
   */
  #takeFrame(kindByte: number, total: number, len: number): DecodedFrame {
    const payloadLength = len - 1;
    const first = this.#segments[0]!;

    let payload: Buffer;
    if (first.length >= total) {
      payload = first.subarray(FRAME_HEADER_BYTES, total);
      this.#consume(total);
    } else {
      payload = Buffer.allocUnsafe(payloadLength);
      let filled = 0;
      let skip = FRAME_HEADER_BYTES;
      for (const segment of this.#segments) {
        if (skip >= segment.length) {
          skip -= segment.length;
          continue;
        }
        const take = Math.min(segment.length - skip, payloadLength - filled);
        segment.copy(payload, filled, skip, skip + take);
        filled += take;
        skip = 0;
        if (filled === payloadLength) break;
      }
      this.#consume(total);
    }

    if (kindByte === FRAME_DATA) return { kind: 'data', payload };
    if (kindByte === FRAME_CONTROL) return { kind: 'control', payload };
    this.#failed = new FrameDecodeError('unknown-kind', `kind=${kindByte}`);
    throw this.#failed;
  }

  /** Drops `bytes` from the front of the segment queue. */
  #consume(bytes: number): void {
    let left = bytes;
    while (left > 0) {
      const segment = this.#segments[0]!;
      if (segment.length <= left) {
        left -= segment.length;
        this.#segments.shift();
        continue;
      }
      this.#segments[0] = segment.subarray(left);
      left = 0;
    }
    this.#pendingBytes -= bytes;
  }
}
