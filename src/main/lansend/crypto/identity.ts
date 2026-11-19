/**
 * Device identity and handshake signatures.
 *
 * Design: the node id *is* the hash of the public key, so a peer cannot
 * present one without the other. No PKI, no certificate chain — the same
 * trust model as "certificate fingerprint is the device", but with a single
 * Ed25519 key pair instead of an RSA cert.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { DeviceIdentity, PeerInfo } from '../protocol/types';

/** Clock skew tolerated on handshake signatures. */
export const SIGNATURE_WINDOW_MS = 60_000;

const HEX64 = /^[0-9a-f]{64}$/;

export interface StoredIdentity {
  readonly v: 1;
  readonly nodeId: string;
  readonly publicKey: string;
  readonly privateKey: string;
  readonly alias: string;
}

export function isValidNodeId(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

/** nodeId = sha256(SPKI DER), lowercase hex. */
export function nodeIdFromPublicKey(spkiDer: Buffer): string {
  return createHash('sha256').update(spkiDer).digest('hex');
}

export function publicKeyToSpkiDer(base64Spki: string): Buffer {
  return Buffer.from(base64Spki, 'base64');
}

function keyObjectFromSpki(base64Spki: string): KeyObject {
  return createPublicKey({ key: Buffer.from(base64Spki, 'base64'), format: 'der', type: 'spki' });
}

/** Creates a fresh identity. Only called when no identity file exists. */
export function generateIdentity(alias: string): StoredIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  return {
    v: 1,
    nodeId: nodeIdFromPublicKey(spki),
    publicKey: spki.toString('base64'),
    privateKey: pkcs8.toString('base64'),
    alias,
  };
}

/**
 * Loads or creates `<dataDir>/identity.json`.
 *
 * The write is atomic (temp + rename) so a crash during first launch cannot
 * leave a truncated identity, which would change the node id on next start.
 */
export async function loadOrCreateIdentity(dataDir: string, alias: string): Promise<StoredIdentity> {
  const path = join(dataDir, 'identity.json');
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredIdentity(parsed)) throw new Error('identity file is malformed');
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    const fresh = generateIdentity(alias);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(fresh, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
    return fresh;
  }
}

export function isStoredIdentity(value: unknown): value is StoredIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['v'] === 1 &&
    isValidNodeId(v['nodeId']) &&
    typeof v['publicKey'] === 'string' &&
    v['publicKey'].length > 0 &&
    typeof v['privateKey'] === 'string' &&
    v['privateKey'].length > 0 &&
    typeof v['alias'] === 'string'
  );
}

/**
 * The bytes a peer signs.
 *
 * - `role` stops a control hello from being replayed as a data hello.
 * - `transferId` (data links only) binds the connection to one transfer, so a
 *   peer cannot redirect a data link to another session mid-flight.
 */
export function handshakePayload(nodeId: string, ts: number, role: 'control' | 'data', transferId?: string): Buffer {
  const suffix = role === 'data' ? `\n${transferId ?? ''}` : '';
  return Buffer.from(`${nodeId}\n${ts}\n${role}${suffix}`, 'utf8');
}

export function signHandshake(identity: StoredIdentity, ts: number, role: 'control' | 'data', transferId?: string): string {
  const priv = createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return edSign(null, handshakePayload(identity.nodeId, ts, role, transferId), priv).toString('base64');
}

export interface HandshakeVerifyResult {
  readonly ok: boolean;
  readonly reason?: 'bad-node-id' | 'key-mismatch' | 'bad-signature' | 'stale-timestamp';
}

/**
 * Verifies a peer's handshake.
 *
 * Order matters: the key hash is checked before the signature so that a peer
 * cannot spend CPU on signatures for keys it does not own.
 */
export function verifyHandshake(params: {
  readonly nodeId: string;
  readonly publicKey: string;
  readonly ts: number;
  readonly role: 'control' | 'data';
  readonly transferId?: string;
  readonly sig: string;
  readonly now?: number;
}): HandshakeVerifyResult {
  const now = params.now ?? Date.now();
  if (!isValidNodeId(params.nodeId)) return { ok: false, reason: 'bad-node-id' };

  let spki: Buffer;
  try {
    spki = publicKeyToSpkiDer(params.publicKey);
  } catch {
    return { ok: false, reason: 'key-mismatch' };
  }
  if (nodeIdFromPublicKey(spki) !== params.nodeId) return { ok: false, reason: 'key-mismatch' };
  if (Math.abs(now - params.ts) > SIGNATURE_WINDOW_MS) return { ok: false, reason: 'stale-timestamp' };

  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(params.sig, 'base64');
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
  if (sigBuf.length !== 64) return { ok: false, reason: 'bad-signature' };

  try {
    const key = keyObjectFromSpki(params.publicKey);
    const ok = edVerify(null, handshakePayload(params.nodeId, params.ts, params.role, params.transferId), key, sigBuf);
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' };
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
}

/** Signature over an announcement: no role, because it is not a connection. */
export function announcePayload(nodeId: string, ts: number): Buffer {
  return Buffer.from(`${nodeId}\n${ts}`, 'utf8');
}

export function signAnnouncement(identity: StoredIdentity, ts: number): string {
  const priv = createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return edSign(null, announcePayload(identity.nodeId, ts), priv).toString('base64');
}

export function verifyAnnouncement(params: {
  readonly nodeId: string;
  readonly publicKey: string;
  readonly ts: number;
  readonly sig: string;
  readonly now?: number;
}): HandshakeVerifyResult {
  const now = params.now ?? Date.now();
  if (!isValidNodeId(params.nodeId)) return { ok: false, reason: 'bad-node-id' };
  let spki: Buffer;
  try {
    spki = publicKeyToSpkiDer(params.publicKey);
  } catch {
    return { ok: false, reason: 'key-mismatch' };
  }
  if (nodeIdFromPublicKey(spki) !== params.nodeId) return { ok: false, reason: 'key-mismatch' };
  if (Math.abs(now - params.ts) > SIGNATURE_WINDOW_MS) return { ok: false, reason: 'stale-timestamp' };
  try {
    const sigBuf = Buffer.from(params.sig, 'base64');
    if (sigBuf.length !== 64) return { ok: false, reason: 'bad-signature' };
    const key = keyObjectFromSpki(params.publicKey);
    const ok = edVerify(null, announcePayload(params.nodeId, params.ts), key, sigBuf);
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' };
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
}

/**
 * The wire form of a peer's info. `publicKey` is included because the receiver
 * needs it to verify the signature; it is not secret.
 */
export interface WirePeerInfo extends PeerInfo {
  readonly publicKey: string;
}

export function toWireInfo(identity: StoredIdentity, opts: { port: number; alias?: string; platform?: PeerInfo['platform']; deviceModel?: string; version?: string }): WirePeerInfo {
  return {
    nodeId: identity.nodeId,
    alias: opts.alias ?? identity.alias,
    platform: opts.platform ?? 'unknown',
    deviceModel: opts.deviceModel ?? 'unknown',
    version: opts.version ?? '0.1.0',
    port: opts.port,
    fingerprint: identity.nodeId,
    protocolVersions: [1],
    publicKey: identity.publicKey,
  };
}

export type { DeviceIdentity };
