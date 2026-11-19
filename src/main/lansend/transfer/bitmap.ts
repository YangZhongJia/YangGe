/**
 * Chunk reservation bitmap.
 *
 * One bit per `chunkSize` slice of a file. The bitmap is the resume format:
 * base64 of the packed bits lives in `.lansend/<transferId>.json`, so its
 * on-disk shape must stay stable across versions.
 *
 * Bits are packed LSB-first per byte. The last chunk of a file may be shorter
 * than `chunkSize`; callers that need a byte count must pass the file size to
 * `bytesFor` rather than multiplying by `chunkSize`.
 */

/** Popcount for a byte; the table is cheaper than branching in `completedChunks`. */
const POPCOUNT = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    let n = i;
    let count = 0;
    while (n !== 0) {
      count += n & 1;
      n >>= 1;
    }
    table[i] = count;
  }
  return table;
})();

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function requireIndex(index: number, chunkCount: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= chunkCount) {
    throw new RangeError(`chunk index ${index} out of range [0, ${chunkCount})`);
  }
}

export class ChunkBitmap {
  readonly chunkCount: number;
  readonly chunkSize: number;

  readonly #bits: Uint8Array;

  /**
   * `bits` is copied so a caller cannot mutate the bitmap behind its back.
   * A shorter array is zero-padded; a longer one is rejected because it means
   * the caller and the chunk count disagree about the file.
   */
  constructor(chunkCount: number, bits?: Uint8Array, chunkSize = 0) {
    if (!Number.isInteger(chunkCount) || chunkCount < 0) {
      throw new RangeError(`invalid chunkCount: ${chunkCount}`);
    }
    if (!Number.isInteger(chunkSize) || chunkSize < 0) {
      throw new RangeError(`invalid chunkSize: ${chunkSize}`);
    }
    this.chunkCount = chunkCount;
    this.chunkSize = chunkSize;

    const bytes = Math.ceil(chunkCount / 8);
    if (bits !== undefined && bits.length > bytes) {
      throw new RangeError(`bitmap has ${bits.length} bytes, expected ${bytes}`);
    }
    const packed = new Uint8Array(bytes);
    if (bits !== undefined) packed.set(bits);
    // Zero any bits past the last chunk so `toBase64` round-trips normalized.
    const tail = chunkCount % 8;
    if (tail !== 0 && bytes > 0) packed[bytes - 1] = packed[bytes - 1]! & ((1 << tail) - 1);
    this.#bits = packed;
  }

  static forSize(size: number, chunkSize: number): ChunkBitmap {
    if (!Number.isInteger(size) || size < 0) throw new RangeError(`invalid size: ${size}`);
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new RangeError(`invalid chunkSize: ${chunkSize}`);
    return new ChunkBitmap(Math.ceil(size / chunkSize), undefined, chunkSize);
  }

  has(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.chunkCount) return false;
    return (this.#bits[index >> 3]! & (1 << (index & 7))) !== 0;
  }

  set(index: number): void {
    requireIndex(index, this.chunkCount);
    this.#bits[index >> 3]! |= 1 << (index & 7);
  }

  clear(index: number): void {
    requireIndex(index, this.chunkCount);
    this.#bits[index >> 3]! &= ~(1 << (index & 7));
  }

  get complete(): boolean {
    if (this.chunkCount === 0) return true;
    const fullBytes = this.chunkCount >> 3;
    for (let i = 0; i < fullBytes; i += 1) {
      if (this.#bits[i] !== 0xff) return false;
    }
    const tail = this.chunkCount & 7;
    if (tail === 0) return true;
    return (this.#bits[fullBytes]! & ((1 << tail) - 1)) === (1 << tail) - 1;
  }

  get completedChunks(): number {
    const fullBytes = this.chunkCount >> 3;
    let count = 0;
    for (let i = 0; i < fullBytes; i += 1) count += POPCOUNT[this.#bits[i]!]!;
    const tail = this.chunkCount & 7;
    if (tail !== 0) count += POPCOUNT[this.#bits[fullBytes]! & ((1 << tail) - 1)]!;
    return count;
  }

  /**
   * Lowest contiguous run of missing chunks starting at or after `fromChunk`.
   *
   * The run is capped at `maxChunks` so a caller planning a wire range can ask
   * for "at most N chunks" without another scan. Bytes are not implied: the
   * start chunk may begin before `fromChunk` only when `fromChunk` is not on a
   * chunk boundary, which callers never do.
   */
  nextMissing(fromChunk = 0, maxChunks = Number.POSITIVE_INFINITY): { start: number; count: number } | null {
    const start = this.findMissing(Math.max(0, Math.trunc(fromChunk)));
    if (start === null) return null;
    const limit = Number.isFinite(maxChunks) ? Math.max(1, Math.trunc(maxChunks)) : this.chunkCount;
    let count = 0;
    while (start + count < this.chunkCount && count < limit && !this.has(start + count)) count += 1;
    return { start, count };
  }

  /** First missing chunk at or after `from`, or null when the tail is complete. */
  findMissing(from: number): number | null {
    let index = Math.max(0, Math.trunc(from));
    while (index < this.chunkCount) {
      const byte = this.#bits[index >> 3]!;
      if (byte === 0xff) {
        // Whole byte complete: jump to the next byte boundary.
        index = (index | 7) + 1;
        continue;
      }
      if ((byte & (1 << (index & 7))) === 0) return index;
      index += 1;
    }
    return null;
  }

  toBase64(): string {
    return Buffer.from(this.#bits).toString('base64');
  }

  /**
   * Parses persisted bits. Unlike the constructor this is strict: persisted
   * metadata comes from disk and a length mismatch means the file changed
   * under a stale resume record, which must never be silently padded.
   */
  static fromBase64(b64: string, chunkCount: number, chunkSize: number): ChunkBitmap {
    if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !BASE64.test(b64)) {
      throw new RangeError('invalid base64 bitmap');
    }
    const bytes = Buffer.from(b64, 'base64');
    const expected = Math.ceil(chunkCount / 8);
    if (bytes.length !== expected) {
      throw new RangeError(`bitmap has ${bytes.length} bytes, expected ${expected}`);
    }
    return new ChunkBitmap(chunkCount, bytes, chunkSize);
  }

  /**
   * Bytes covered by set bits. The final chunk contributes its real length,
   * not `chunkSize`, so `bytesFor(size)` never exceeds `size`.
   */
  bytesFor(size: number): number {
    if (this.chunkCount === 0 || size <= 0) return 0;
    const span = this.chunkSize > 0 ? this.chunkSize : Math.ceil(size / this.chunkCount);
    const done = this.completedChunks;
    if (done === 0) return 0;
    const last = this.chunkCount - 1;
    // `done * span` would over-count when the set tail chunk is short.
    const bytes = this.has(last)
      ? (done - 1) * span + Math.max(0, size - last * span)
      : done * span;
    return Math.min(bytes, size);
  }
}
