/**
 * Resume metadata: `<dest>/.lansend/<transferId>.json`.
 *
 * The file is written once per completed range by the session, so the write
 * path has to be atomic — a crash mid-write must leave either the previous
 * state or the new one, never a truncated JSON document. `write temp + rename`
 * gives that on every supported platform (rename replaces atomically on
 * POSIX; on Windows `fs.rename` also replaces an existing file).
 *
 * `transferId` comes from the network, so it is validated against a conservative
 * allowlist before it is ever joined onto a path. Anything else is rejected
 * rather than sanitized: a transfer id is ours to generate, not to fix up.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ResumeFileState {
  /** Unique within the transfer. */
  readonly fileId: string;
  readonly relativePath: string;
  readonly size: number;
  readonly chunkSize: number;
  /** Base64 of the packed chunk bits; see `ChunkBitmap.toBase64`. */
  readonly bitmap: string;
}

export interface ResumeState {
  readonly v: 1;
  readonly transferId: string;
  /** Sender nodeId. A different peer must never revive a bitmap. */
  readonly from: string;
  /** Epoch ms when the transfer was first accepted. */
  readonly createdAt: number;
  readonly files: readonly ResumeFileState[];
}

const TRANSFER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type ResumeWarn = (message: string, error?: unknown) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidBitmap(bitmap: string, size: number, chunkSize: number): boolean {
  if (bitmap.length % 4 !== 0 || !BASE64.test(bitmap)) return false;
  const bytes = Buffer.from(bitmap, 'base64');
  return bytes.length === Math.ceil(Math.ceil(size / chunkSize) / 8);
}

/**
 * Validates an untrusted metadata document.
 *
 * Returns null instead of throwing: `load` must survive a hand-edited or
 * half-written file, and callers treat null as "start from zero".
 */
function parseState(raw: unknown): ResumeState | null {
  if (!isRecord(raw) || raw.v !== 1) return null;
  if (typeof raw.transferId !== 'string' || !TRANSFER_ID.test(raw.transferId)) return null;
  if (typeof raw.from !== 'string' || raw.from.length === 0) return null;
  if (!isCount(raw.createdAt)) return null;
  if (!Array.isArray(raw.files)) return null;

  const files: ResumeFileState[] = [];
  const seen = new Set<string>();
  for (const entry of raw.files) {
    if (!isRecord(entry)) return null;
    if (typeof entry.fileId !== 'string' || entry.fileId.length === 0 || seen.has(entry.fileId)) return null;
    if (typeof entry.relativePath !== 'string' || entry.relativePath.length === 0) return null;
    if (!isCount(entry.size)) return null;
    if (!isCount(entry.chunkSize) || entry.chunkSize === 0) return null;
    if (typeof entry.bitmap !== 'string' || !isValidBitmap(entry.bitmap, entry.size, entry.chunkSize)) return null;
    seen.add(entry.fileId);
    files.push({
      fileId: entry.fileId,
      relativePath: entry.relativePath,
      size: entry.size,
      chunkSize: entry.chunkSize,
      bitmap: entry.bitmap,
    });
  }
  return { v: 1, transferId: raw.transferId, from: raw.from, createdAt: raw.createdAt, files };
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class ResumeStore {
  readonly dir: string;
  readonly #onWarn: ResumeWarn | undefined;

  constructor(dir: string, onWarn?: ResumeWarn) {
    this.dir = dir;
    this.#onWarn = onWarn;
  }

  /** Returns null for a missing, corrupt or mismatched record; never throws for bad content. */
  async load(transferId: string): Promise<ResumeState | null> {
    const file = this.#fileFor(transferId);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (!isEnoent(error)) this.#warn(`cannot read resume file ${file}`, error);
      return null;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      this.#warn(`corrupt resume file ${file}`, error);
      return null;
    }
    const state = parseState(raw);
    if (state === null) {
      this.#warn(`invalid resume file ${file}`);
      return null;
    }
    if (state.transferId !== transferId) {
      this.#warn(`resume file ${file} belongs to ${state.transferId}`);
      return null;
    }
    return state;
  }

  /** Writes `<transferId>.json.tmp`, then renames it into place. */
  async save(state: ResumeState): Promise<void> {
    const validated = parseState(state);
    if (validated === null) throw new RangeError('invalid resume state');
    const file = this.#fileFor(validated.transferId);
    const temp = `${file}.tmp`;
    await mkdir(this.dir, { recursive: true });
    try {
      await writeFile(temp, JSON.stringify(validated), 'utf8');
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async remove(transferId: string): Promise<void> {
    await rm(this.#fileFor(transferId), { force: true });
  }

  /**
   * Deletes metadata older than `maxAgeMs`. Age comes from `createdAt` so a
   * freshly copied directory does not look new; unparsable files fall back to
   * mtime and are only removed when old, never merely because they are broken.
   */
  async prune(maxAgeMs: number): Promise<number> {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new RangeError(`invalid maxAgeMs: ${maxAgeMs}`);
    let entries;
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return 0;
      throw error;
    }

    const now = Date.now();
    const cutoff = now - maxAgeMs;
    let removed = 0;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(this.dir, entry.name);
      const isTemp = entry.name.endsWith('.json.tmp');
      const isMeta = entry.name.endsWith('.json');
      if (!isTemp && !isMeta) continue;

      try {
        const info = await stat(path);
        let ageTime = info.mtimeMs;
        if (isMeta) {
          try {
            const state = parseState(JSON.parse(await readFile(path, 'utf8')));
            if (state !== null) ageTime = state.createdAt;
          } catch {
            // Keep the mtime fallback.
          }
        }
        if (ageTime < cutoff) {
          await rm(path, { force: true });
          if (isMeta) removed += 1;
        }
      } catch (error) {
        if (!isEnoent(error)) this.#warn(`cannot prune ${path}`, error);
      }
    }
    return removed;
  }

  /**
   * True when a stored bitmap can be reused for the incoming manifest.
   *
   * The check is deliberately exact: a changed size, chunk size or sender
   * invalidates every bit, because a bit addresses a byte offset in both the
   * old and new file only if those parameters are identical.
   */
  static matches(
    state: ResumeState,
    incoming: {
      files: readonly { fileId: string; size: number }[];
      chunkSize: number;
      from: string;
    },
  ): boolean {
    if (state.from !== incoming.from) return false;
    if (state.files.length !== incoming.files.length) return false;
    if (!Number.isSafeInteger(incoming.chunkSize) || incoming.chunkSize <= 0) return false;

    const incomingById = new Map<string, { fileId: string; size: number }>();
    for (const file of incoming.files) incomingById.set(file.fileId, { fileId: file.fileId, size: file.size });

    for (const file of state.files) {
      const match = incomingById.get(file.fileId);
      if (!match) return false;
      if (match.size !== file.size) return false;
      if (file.chunkSize !== incoming.chunkSize) return false;
    }
    return true;
  }

  #fileFor(transferId: string): string {
    if (typeof transferId !== 'string' || !TRANSFER_ID.test(transferId)) {
      throw new RangeError(`invalid transferId: ${String(transferId)}`);
    }
    return join(this.dir, `${transferId}.json`);
  }

  #warn(message: string, error?: unknown): void {
    this.#onWarn?.(message, error);
  }
}
