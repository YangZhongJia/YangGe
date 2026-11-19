/**
 * The canonical runtime type guards for this package.
 *
 * Everything that crosses a trust boundary (a socket, a UDP datagram, a file
 * on disk) is validated here so the rest of the code can work with named
 * types instead of re-checking shapes at every call site.
 */

import { MAX_ALIAS_BYTES } from './constants';

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isInt(value: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function isStr(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  if (typeof value !== 'string') return false;
  if (!allowEmpty && value.length === 0) return false;
  return Buffer.byteLength(value, 'utf8') <= maxBytes;
}

/** A sha256 hex digest: lowercase, exactly 64 chars. */
export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** Base64 of a DER SPKI key is ~44-88 chars; the bound stops huge allocations. */
export function isBase64(value: unknown, maxBytes = 512): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxBytes * 2) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/** Base64 of an Ed25519 signature is always 64 bytes → 88 chars with padding. */
export function isSignature(value: unknown): value is string {
  return typeof value === 'string' && value.length === 88 && /^[A-Za-z0-9+/]{86}==$/.test(value);
}

export function isAlias(value: unknown): value is string {
  return isStr(value, MAX_ALIAS_BYTES);
}

/** Transfer ids and file ids end up in filenames, so the charset is restricted. */
export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
