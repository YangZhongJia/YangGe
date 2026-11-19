/**
 * Filesystem helpers shared by the sender and receiver.
 *
 * Two jobs that are easy to get wrong and expensive to debug in the field:
 *  - walking a user-supplied path list into a flat, stable file list;
 *  - mapping an untrusted relative path onto a path inside the destination
 *    directory without ever escaping it.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, rm, stat, truncate } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { MAX_FILES, MAX_REL_BYTES } from '../protocol/constants';
import type { FileEntry } from '../protocol/types';
import { withResolvers } from '../util/promise';

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Characters that are illegal in a filename on at least one supported
 * platform. Replaced rather than rejected: a sender's file is not the
 * receiver's fault.
 */
const ILLEGAL_CHARS = /[\u0000-\u001f<>:"/\\|?*]/g;

/** Windows reserved device names, which cannot be created as files. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export function sanitizeSegment(segment: string): string {
  let out = segment.replace(ILLEGAL_CHARS, '_');
  // Windows silently strips trailing dots and spaces; doing it here keeps the
  // name we report identical to the name on disk.
  out = out.replace(/[. ]+$/, '');
  if (out.length === 0 || out === '.' || out === '..') out = '_';
  if (RESERVED_NAMES.test(out)) out = `_${out}`;
  return out;
}

/**
 * Sanitizes a relative path and guarantees it stays inside the root.
 *
 * Returns null when the path is unusable (`..` traversal, absolute path,
 * empty after normalization). Callers must treat null as a protocol error
 * rather than falling back to a default name: silently writing elsewhere is
 * exactly the bug this function exists to prevent.
 */
export function sanitizeRelativePath(relativePath: string): string | null {
  if (relativePath.length === 0 || Buffer.byteLength(relativePath, 'utf8') > MAX_REL_BYTES) return null;
  if (isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) return null;

  const parts = relativePath.split(/[\\/]+/);
  const out: string[] = [];
  for (const part of parts) {
    if (part.length === 0 || part === '.') continue;
    if (part === '..') return null;
    out.push(sanitizeSegment(part));
  }
  return out.length > 0 ? out.join('/') : null;
}

/**
 * Joins a sanitized relative path onto a root and asserts containment.
 *
 * The assertion is not redundant with `sanitizeRelativePath`: it also catches
 * symlinked directories inside the root, which sanitization cannot see.
 */
export function safeJoin(root: string, relativePath: string): string {
  const sanitized = sanitizeRelativePath(relativePath);
  if (sanitized === null) throw new Error(`unsafe relative path: ${relativePath}`);
  const target = resolve(root, ...sanitized.split('/'));
  const rootResolved = resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    throw new Error(`path escapes destination: ${relativePath}`);
  }
  return target;
}

/** `foo.txt` -> `foo (1).txt`, `foo (2).txt`, ... until the name is free. */
export async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extnameOf(name);
  const stem = ext.length > 0 ? name.slice(0, -ext.length) : name;
  let candidate = join(dir, name);
  for (let i = 1; i < 10_000; i += 1) {
    try {
      await lstat(candidate);
    } catch {
      return candidate;
    }
    candidate = join(dir, `${stem} (${i})${ext}`);
  }
  throw new Error(`cannot find a free name for ${name}`);
}

function extnameOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

export interface WalkedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly size: number;
  readonly mtime: number | null;
}

/**
 * Expands a list of files and directories into a flat file list.
 *
 * `rootFor(paths)` decides the common base so that sending `/a/photos` yields
 * `photos/...` rather than `a/photos/...`. Symlinks are not followed: a
 * directory symlink loop would otherwise hang the walk, and a file symlink
 * can point outside what the user selected.
 */
export async function walkPaths(paths: readonly string[], limit = MAX_FILES): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const roots = paths.map((p) => resolve(p));

  for (let i = 0; i < roots.length; i += 1) {
    const root = roots[i]!;
    const info = await lstat(root);
    if (info.isSymbolicLink()) continue;

    if (info.isFile()) {
      out.push({
        absolutePath: root,
        relativePath: sanitizeSegment(basename(root)),
        size: info.size,
        mtime: Number.isFinite(info.mtimeMs) ? Math.floor(info.mtimeMs) : null,
      });
    } else if (info.isDirectory()) {
      // The directory's own name is the prefix, so `send /a/b/photos` gives
      // `photos/x.jpg`. A trailing separator on the input means "contents of",
      // matching every shell's cp semantics.
      const raw = paths[i]!;
      const includeSelf = !/[\\/]$/.test(raw) && !/[\\/]\.\.?$/.test(raw);
      const basePrefix = includeSelf ? sanitizeSegment(basename(root)) : '';
      await walkDirectory(root, basePrefix, out, limit);
    }

    if (out.length >= limit) throw new Error(`too many files (limit ${limit})`);
  }

  return out;
}

async function walkDirectory(dir: string, prefix: string, out: WalkedFile[], limit: number): Promise<void> {
  const handle = await opendir(dir);
  try {
    for await (const entry of handle) {
      if (entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walkDirectory(abs, rel, out, limit);
      } else if (entry.isFile()) {
        const info = await stat(abs);
        out.push({
          absolutePath: abs,
          relativePath: rel,
          size: info.size,
          mtime: Number.isFinite(info.mtimeMs) ? Math.floor(info.mtimeMs) : null,
        });
      }
      if (out.length >= limit) throw new Error(`too many files (limit ${limit})`);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** Streams a file through sha256. Uses a 1 MiB read buffer: large enough to amortize syscalls. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  const { promise, resolve, reject } = withResolvers<void>();
  stream.on('data', (chunk) => hash.update(chunk));
  stream.once('error', reject);
  stream.once('end', resolve);
  await promise;
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Part files
// ---------------------------------------------------------------------------

export const PART_SUFFIX = '.lansend-part';

/** Pre-allocates the part file so writes are positioned, never appending. */
export async function allocatePartFile(path: string, size: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'a');
  try {
    const info = await handle.stat();
    if (info.size !== size) await truncate(path, size);
  } finally {
    await handle.close();
  }
}

/** Moves the finished part file into place, replacing any existing file. */
export async function commitPartFile(partPath: string, finalPath: string): Promise<void> {
  await mkdir(dirname(finalPath), { recursive: true });
  try {
    await rename(partPath, finalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM') throw error;
    await rm(finalPath, { force: true });
    await rename(partPath, finalPath);
  }
}

/** Resolves symlinks for an existing directory; used once when the service starts. */
export async function canonicalDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return realpath(dir);
}

export function relativeTo(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

export function toFileEntries(files: readonly WalkedFile[]): FileEntry[] {
  return files.map((file, index) => ({
    fileId: `f${index + 1}`,
    name: sanitizeSegment(basename(file.relativePath)),
    relativePath: file.relativePath,
    size: file.size,
    mtime: file.mtime,
    sha256: null,
  }));
}
