/**
 * The transfer session: the state machine that turns an accepted offer into
 * bytes on disk (receiving) or bytes on the wire (sending).
 *
 * Both directions share one shape — a list of files, a set of data links, and
 * a scheduler that hands out ranges — so the retry policy lives in one place.
 * The difference is who dials: the receiver does, because it pulls.
 *
 * Transport is injected, so tests run the whole machine over an in-memory
 * duplex pair without a socket.
 */

import type { ControlMessage, FileEntry, PeerInfo, TransferTuning } from '../protocol/types';
import { SpeedMeter } from '../util/speed';
import type { ChunkBitmap } from './bitmap';

/** Minimal duplex the session needs. A real `net.Socket` satisfies it. */
export interface SessionSocket {
  write(chunk: Buffer): boolean;
  cork(): void;
  uncork(): void;
  once(event: 'drain', listener: () => void): void;
  destroy(error?: Error): void;
  readonly destroyed: boolean;
  pause?(): void;
  resume?(): void;
}

export type SessionDirection = 'send' | 'receive';

/** One `stream-req` in flight on a link. */
export interface RangeState {
  readonly fileId: string;
  readonly offset: number;
  readonly length: number;
  /** Bytes moved for this range so far. */
  moved: number;
  attempts: number;
}

export interface SessionHooks {
  readonly now: () => number;
  readonly onProgress: (fileId: string, bytesDone: number, totalBytesDone: number) => void;
  readonly onFileDone: (fileId: string, bytes: number, sha256: string | null) => void;
  readonly onComplete: () => void;
  readonly onError: (error: Error) => void;
}

/**
 * Per-link bookkeeping.
 *
 * `inFlight` is the entire concurrency control: the wire format forbids
 * interleaving, so a link carries at most one range. Parallelism comes from
 * the number of links.
 */
interface Link {
  socket: SessionSocket;
  inFlight: RangeState | null;
  dead: boolean;
}

/** Link states for the receive direction. */
type LinkPhase = 'idle' | 'awaiting-ok' | 'streaming';

interface ReceiveLink extends Link {
  phase: LinkPhase;
  /**
   * Serialises work on this link.
   *
   * DATA frames arrive as fast as the socket delivers them, and each write is
   * async. Without a per-link queue two frames compute their file offset from
   * the same `moved` counter and land on top of each other — the file ends up
   * the right length with the wrong bytes, which is the worst failure mode to
   * debug.
   */
  chain: Promise<void>;
}

export class TransferSessionBase {
  readonly transferId: string;
  readonly peer: PeerInfo;
  readonly files: readonly FileEntry[];
  readonly totalBytes: number;
  readonly tuning: TransferTuning;
  readonly direction: SessionDirection;

  protected readonly hooks: SessionHooks;
  protected readonly bitmaps = new Map<string, ChunkBitmap>();
  protected readonly speed: SpeedMeter;
  protected bytesDone = 0;
  protected finished = false;

  constructor(params: {
    transferId: string;
    peer: PeerInfo;
    files: readonly FileEntry[];
    totalBytes: number;
    tuning: TransferTuning;
    direction: SessionDirection;
    hooks: SessionHooks;
    bitmaps: ReadonlyMap<string, ChunkBitmap>;
  }) {
    this.transferId = params.transferId;
    this.peer = params.peer;
    this.files = params.files;
    this.totalBytes = params.totalBytes;
    this.tuning = params.tuning;
    this.direction = params.direction;
    this.hooks = params.hooks;
    this.speed = new SpeedMeter(params.hooks.now);
    for (const [fileId, bitmap] of params.bitmaps) this.bitmaps.set(fileId, bitmap);
  }

  get transferred(): number {
    return this.bytesDone;
  }

  get bytesPerSecond(): number {
    return this.speed.bytesPerSecond;
  }

  get etaMs(): number | null {
    return this.speed.etaMs(Math.max(0, this.totalBytes - this.bytesDone));
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Immutable view of the bitmaps, for persisting progress on shutdown. */
  bitmapsSnapshot(): ReadonlyMap<string, ChunkBitmap> {
    return new Map(this.bitmaps);
  }

  protected recordBytes(bytes: number): void {
    if (bytes <= 0) return;
    this.bytesDone += bytes;
    this.speed.add(bytes);
  }

  protected fileBytesDone(fileId: string): number {
    const bitmap = this.bitmaps.get(fileId);
    const file = this.fileById(fileId);
    if (!bitmap || !file) return 0;
    return bitmap.bytesFor(file.size);
  }

  protected fileById(fileId: string): FileEntry | undefined {
    return this.files.find((f) => f.fileId === fileId);
  }

  protected emitProgress(fileId: string): void {
    this.hooks.onProgress(fileId, this.fileBytesDone(fileId), this.bytesDone);
  }

  protected fail(error: Error): void {
    if (this.finished) return;
    this.finished = true;
    this.hooks.onError(error);
  }

  protected succeed(): void {
    if (this.finished) return;
    this.finished = true;
    this.hooks.onComplete();
  }

  protected allComplete(): boolean {
    for (const file of this.files) {
      const bitmap = this.bitmaps.get(file.fileId);
      if (!bitmap || !bitmap.complete) return false;
    }
    return true;
  }

  /**
   * Chunks currently claimed by a link.
   *
   * Without this, every link starts from the same empty bitmap and all of them
   * pull the whole file — four connections would write the same bytes four
   * times over and the result would be four times too long.
   */
  protected busyChunks(): Set<number> {
    const chunkSize = this.tuning.chunkSize;
    const busy = new Set<number>();
    for (const link of this.links()) {
      const range = link.inFlight;
      if (!range) continue;
      const first = Math.floor(range.offset / chunkSize);
      const last = Math.floor((range.offset + range.length - 1) / chunkSize);
      for (let i = first; i <= last; i += 1) busy.add(i);
    }
    return busy;
  }

  /**
   * Picks the next range: the first file with an unclaimed missing chunk,
   * starting there, capped at `rangeBytes`, and stopping before any chunk that
   * is already complete or claimed by another link.
   */
  protected pickRange(): RangeState | null {
    const chunkSize = this.tuning.chunkSize;
    const busy = this.busyChunks();

    for (const file of this.files) {
      const bitmap = this.bitmaps.get(file.fileId);
      if (!bitmap || bitmap.complete) continue;

      // Skip forward past chunks that are done or in flight elsewhere.
      let firstMissing = bitmap.findMissing(0);
      while (firstMissing !== null && busy.has(firstMissing)) firstMissing = bitmap.findMissing(firstMissing + 1);
      if (firstMissing === null) continue;

      const offset = firstMissing * chunkSize;
      const remaining = file.size - offset;
      if (remaining <= 0) {
        // A zero-byte tail means the bitmap disagrees with the size; marking
        // it prevents an infinite loop.
        bitmap.set(firstMissing);
        continue;
      }

      let length = Math.min(this.tuning.rangeBytes, remaining);
      const maxChunks = Math.max(1, Math.floor(length / chunkSize));
      for (let i = 1; i < maxChunks; i += 1) {
        if (busy.has(firstMissing + i) || bitmap.has(firstMissing + i)) {
          length = i * chunkSize;
          break;
        }
      }
      return { fileId: file.fileId, offset, length, moved: 0, attempts: 0 };
    }
    return null;
  }

  /** Marks every chunk fully covered by a completed range. */
  protected markRangeComplete(range: RangeState): void {
    const bitmap = this.bitmaps.get(range.fileId);
    const file = this.fileById(range.fileId);
    if (!bitmap || !file) return;
    const chunkSize = this.tuning.chunkSize;
    const end = range.offset + range.length;
    for (let offset = range.offset; offset < end; offset += chunkSize) {
      const index = Math.floor(offset / chunkSize);
      const chunkEnd = Math.min(end, (index + 1) * chunkSize);
      const fileEnd = Math.min(file.size, (index + 1) * chunkSize);
      if (chunkEnd >= fileEnd) bitmap.set(index);
    }
  }

  /** Marks a link unusable and drops its range so another link picks it up. */
  protected markDead(index: number): void {
    const link = this.links()[index];
    if (!link || link.dead) return;
    link.dead = true;
    link.inFlight = null;
    if (!link.socket.destroyed) link.socket.destroy();
  }

  /** Overridden by subclasses; declared here so `cancel` can iterate links. */
  protected links(): readonly Link[] {
    return [];
  }

  cancel(reason: string): void {
    if (this.finished) return;
    this.finished = true;
    const links = this.links();
    for (let i = 0; i < links.length; i += 1) this.markDead(i);
    this.hooks.onError(new Error(reason));
  }
}

// ---------------------------------------------------------------------------
// Receive side
// ---------------------------------------------------------------------------

/**
 * Drives the pull: for each link, request a range, consume the DATA frames,
 * write them to the part file, verify, mark, repeat.
 */
export class ReceiveSession extends TransferSessionBase {
  readonly #links: ReceiveLink[] = [];
  readonly #writer: ReceiverWriter;
  readonly #expectedHashes = new Map<string, string>();
  #completedRange = false;

  constructor(params: {
    transferId: string;
    peer: PeerInfo;
    files: readonly FileEntry[];
    totalBytes: number;
    tuning: TransferTuning;
    hooks: SessionHooks;
    bitmaps: ReadonlyMap<string, ChunkBitmap>;
    writer: ReceiverWriter;
  }) {
    super({ ...params, direction: 'receive' });
    this.#writer = params.writer;
  }

  override links(): readonly Link[] {
    return this.#links;
  }

  /** Whole-file digests the sender announced, keyed by fileId. */
  get expectedHashes(): ReadonlyMap<string, string> {
    return this.#expectedHashes;
  }

  /**
   * Set when the most recent `onData` finished a range.
   *
   * The service uses it to persist resume metadata at range granularity
   * instead of only on a timer, which would leave a crashed short transfer
   * with nothing to resume from.
   */
  get completedRange(): boolean {
    return this.#completedRange;
  }

  /**
   * Adds a data link.
   *
   * Pumping is a separate call on purpose: the caller must have wired the
   * link's frame handlers to `index` before the first `stream-req` goes out,
   * or the peer's immediate `stream-ok` can arrive before `index` is known and
   * be dropped — after which the first DATA frame looks like a violation.
   */
  addLink(socket: SessionSocket): number {
    const index = this.#links.length;
    this.#links.push({ socket, inFlight: null, dead: false, phase: 'idle', chain: Promise.resolve() });
    return index;
  }

  /** Starts pulling on a link added by `addLink`. Safe to call twice. */
  start(index: number): void {
    this.#pump(index);
  }

  /** Called by the transport when a DATA frame arrives on `index`. */
  onData(index: number, payload: Buffer): Promise<void> {
    const link = this.#links[index];
    if (!link) return Promise.reject(new Error('unexpected-data'));
    const next = link.chain.then(() => this.#consume(index, payload));
    // Keep the chain alive after a failure so the error surfaces once and the
    // link can still be torn down cleanly.
    link.chain = next.catch(() => {});
    return next;
  }

  async #consume(index: number, payload: Buffer): Promise<void> {
    this.#completedRange = false;
    const link = this.#links[index];
    const range = link?.inFlight;
    if (!link || !range || link.phase !== 'streaming') throw new Error('unexpected-data');

    // A frame may overrun the range: the sender is buggy or hostile. Write only
    // what belongs to the range, then fail the link so the range is retried.
    const room = range.length - range.moved;
    const take = Math.min(room, payload.length);
    if (take > 0) {
      await this.#writer.write(index, range, payload.subarray(0, take));
      range.moved += take;
      this.recordBytes(take);
      this.emitProgress(range.fileId);
    }
    if (take < payload.length) {
      await this.#abandon(index);
      throw new Error('range-overrun');
    }
    // Mark chunks as their last byte lands, not when the whole range does.
    // A 4 MiB range on a 1 MiB grid would otherwise lose up to 4 MiB of
    // confirmed progress on a crash, and a transfer killed early would have
    // nothing at all to resume from.
    this.#markCompletedChunks(range);
    if (range.moved === range.length) await this.#finishRange(index);
  }

  /** Marks every chunk of `range` whose final byte has been written. */
  #markCompletedChunks(range: RangeState): void {
    const bitmap = this.bitmaps.get(range.fileId);
    const file = this.fileById(range.fileId);
    if (!bitmap || !file) return;
    const chunkSize = this.tuning.chunkSize;
    const written = range.offset + range.moved;
    const first = Math.floor(range.offset / chunkSize);
    const last = Math.floor((written - 1) / chunkSize);
    for (let index = first; index <= last; index += 1) {
      const chunkEnd = Math.min((index + 1) * chunkSize, file.size);
      if (chunkEnd <= written) bitmap.set(index);
    }
  }

  /** Called by the transport for every control frame on a data link. */
  onControl(index: number, msg: ControlMessage): void {
    const link = this.#links[index];
    if (!link || link.dead) return;

    switch (msg.t) {
      case 'stream-ok': {
        const range = link.inFlight;
        if (!range || link.phase !== 'awaiting-ok') return;
        // The sender clamps to EOF; accept a shorter range but never a longer
        // one, and never a different file.
        if (msg.fileId !== range.fileId || msg.offset !== range.offset) {
          this.fail(new Error('stream-ok-mismatch'));
          return;
        }
        const clamped = { ...range, length: Math.min(range.length, msg.length) };
        link.inFlight = clamped;
        link.phase = 'streaming';
        const next = link.chain.then(async () => {
          await this.#writer.begin(index, clamped);
          if (clamped.length === 0) await this.#finishRange(index);
        });
        link.chain = next.catch((error: Error) => this.fail(error));
        return;
      }
      case 'stream-end': {
        // A hash is only meaningful for a whole-file range; remember it and
        // verify once, after every chunk has landed, because parallel links
        // mean the file is not readable in one piece before then.
        const range = link.inFlight;
        if (!range) return;
        const size = this.fileById(range.fileId)?.size ?? 0;
        if (msg.sha256 !== null && msg.offset === 0 && msg.bytes === size) {
          this.#expectedHashes.set(range.fileId, msg.sha256);
        }
        return;
      }
      case 'stream-error': {
        const range = link.inFlight;
        if (!range) return;
        range.attempts += 1;
        if (range.attempts > this.tuning.maxRetries) {
          this.fail(new Error(`stream-error:${msg.reason}`));
          return;
        }
        // Requeue: drop the partial write and let any link pick it up again.
        void this.#abandon(index).then(() => this.#pump(index), (error: Error) => this.fail(error));
        return;
      }
      case 'err': {
        this.fail(new Error(msg.reason));
        return;
      }
      default:
        return;
    }
  }

  /** Called when a link dies; its range is retried on the remaining links. */
  onLinkLost(index: number): void {
    const link = this.#links[index];
    if (!link || link.dead) return;
    link.dead = true;
    link.inFlight = null;
    // Redistribute work to the surviving links.
    for (let i = 0; i < this.#links.length; i += 1) this.#pump(i);
  }

  async #finishRange(index: number): Promise<void> {
    const link = this.#links[index];
    const range = link?.inFlight;
    if (!link || !range) return;
    this.#completedRange = true;

    const written = await this.#writer.end(index);
    if (written !== range.length) {
      this.fail(new Error('short-write'));
      return;
    }
    this.markRangeComplete(range);
    link.inFlight = null;
    link.phase = 'idle';

    const bitmap = this.bitmaps.get(range.fileId);
    if (bitmap?.complete) {
      const file = this.fileById(range.fileId);
      this.hooks.onFileDone(range.fileId, file?.size ?? 0, null);
    }
    this.emitProgress(range.fileId);

    if (this.allComplete()) {
      this.succeed();
      return;
    }
    this.#pump(index);
  }

  async #abandon(index: number): Promise<void> {
    const link = this.#links[index];
    if (!link) return;
    link.inFlight = null;
    link.phase = 'idle';
    await this.#writer.abandon(index);
  }

  /** Requests the next range on `index`, or finishes when there is nothing left. */
  #pump(index: number): void {
    const link = this.#links[index];
    if (!link || link.dead || this.finished) return;
    if (link.inFlight !== null) return;

    const range = this.pickRange();
    if (range === null) {
      // Nothing left for this link; completion is decided by the last one out.
      if (this.allComplete()) this.succeed();
      return;
    }
    link.inFlight = range;
    link.phase = 'awaiting-ok';
    this.#sendControl(index, {
      t: 'stream-req',
      transferId: this.transferId,
      fileId: range.fileId,
      offset: range.offset,
      length: range.length,
    });
  }

  #sendControl(index: number, msg: ControlMessage): void {
    const link = this.#links[index];
    if (!link || link.dead) return;
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

/**
 * Disk side of a receive session.
 *
 * Kept as an interface so the session can be tested without a filesystem, and
 * so the production implementation (`src/transfer/receiver.ts`) stays the only
 * place that knows about part files.
 */
export interface ReceiverWriter {
  begin(index: number, range: { fileId: string; offset: number; length: number }): Promise<void>;
  write(index: number, range: RangeState, payload: Buffer): Promise<void>;
  /** Flushes and returns the byte count written for the current range. */
  end(index: number): Promise<number>;
  abandon(index: number): Promise<void>;
  verify(fileId: string, sha256: string): Promise<void>;
  close(): Promise<void>;
}
