/**
 * Decoders for untrusted wire data.
 *
 * Every function here returns `null` on anything unexpected instead of
 * throwing. That is deliberate: a malformed frame is a peer bug or an attack,
 * never a programming error in our own code, and it must not take down the
 * process. Callers translate `null` into a dropped datagram or a closed
 * connection.
 *
 * Validation is strict about *shape* and lenient about *content*: we check
 * types, bounds and required keys, but never assume a value is meaningful
 * (a file size of 0 is legal, an alias of "" is not).
 */

import {
  MAX_ALIAS_BYTES,
  MAX_CONTROL_FRAME_BYTES,
  MAX_FILES,
  MAX_MESSAGE_BYTES,
  MAX_REL_BYTES,
  PROTOCOL_VERSION,
  UDP_MAX_PAYLOAD,
} from './constants';
import { isBase64, isHex64, isInt, isRecord, isSafeId, isSignature, isStr } from './guards';
import type {
  Announcement,
  AnnounceReply,
  ControlMessage,
  ControlType,
  FileEntry,
  PeerInfo,
} from './types';

const PLATFORMS: Record<string, true> = {
  win32: true,
  darwin: true,
  linux: true,
  android: true,
  ios: true,
  unknown: true,
};

export function decodePeerInfo(value: unknown): (PeerInfo & { publicKey: string }) | null {
  if (!isRecord(value)) return null;
  const nodeId = value['nodeId'];
  const alias = value['alias'];
  const platform = value['platform'];
  const deviceModel = value['deviceModel'];
  const version = value['version'];
  const port = value['port'];
  const fingerprint = value['fingerprint'];
  const versions = value['protocolVersions'];
  const publicKey = value['publicKey'];

  if (!isHex64(nodeId)) return null;
  if (!isStr(alias, MAX_ALIAS_BYTES)) return null;
  if (typeof platform !== 'string' || PLATFORMS[platform] !== true) return null;
  if (!isStr(deviceModel, 128, true)) return null;
  if (!isStr(version, 32)) return null;
  if (!isInt(port, 1, 65_535)) return null;
  if (!isHex64(fingerprint)) return null;
  if (fingerprint !== nodeId) return null;
  if (!Array.isArray(versions) || versions.length === 0 || versions.length > 8) return null;
  if (!versions.every((v) => isInt(v, 1, 1000))) return null;
  if (!isBase64(publicKey, 128)) return null;

  return {
    nodeId,
    alias,
    platform: platform as PeerInfo['platform'],
    deviceModel,
    version,
    port,
    fingerprint,
    protocolVersions: versions as number[],
    publicKey,
  };
}

export function decodeFileEntry(value: unknown): FileEntry | null {
  if (!isRecord(value)) return null;
  const fileId = value['fileId'];
  const name = value['name'];
  const relativePath = value['relativePath'];
  const size = value['size'];
  const mtime = value['mtime'];
  const sha256 = value['sha256'];

  if (!isStr(fileId, 64)) return null;
  if (!isStr(name, MAX_REL_BYTES)) return null;
  if (!isStr(relativePath, MAX_REL_BYTES)) return null;
  if (!isInt(size, 0)) return null;
  if (mtime !== null && !isInt(mtime, 0)) return null;
  if (sha256 !== null && !isHex64(sha256)) return null;

  return { fileId, name, relativePath, size, mtime, sha256 };
}

function decodeFileList(value: unknown): FileEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_FILES) return null;
  const out: FileEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const entry = decodeFileEntry(raw);
    if (entry === null) return null;
    if (seen.has(entry.fileId)) return null;
    seen.add(entry.fileId);
    out.push(entry);
  }
  return out;
}

/**
 * Decodes one control frame payload.
 *
 * The returned union member is fully validated: no caller needs to re-check
 * fields. `t` is checked against the known set first so the switch below can
 * never see an unexpected value.
 */
export function decodeControl(payload: Buffer | string): ControlMessage | null {
  if (typeof payload !== 'string' && payload.length > MAX_CONTROL_FRAME_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  const t = raw['t'];
  if (typeof t !== 'string') return null;

  switch (t as ControlType) {
    case 'hello':
    case 'hello-ok': {
      const info = decodePeerInfo(raw['info']);
      if (info === null) return null;
      if (raw['v'] !== PROTOCOL_VERSION) return null;
      if (!isInt(raw['ts'], 0)) return null;
      if (!isSignature(raw['sig'])) return null;
      if (t === 'hello' && raw['role'] !== 'control' && raw['role'] !== 'data') return null;
      if (t === 'hello') {
        const role = raw['role'] as 'control' | 'data';
        const transferId = raw['transferId'];
        if (role === 'data') {
          if (!isSafeId(transferId)) return null;
        } else if (transferId !== undefined) {
          return null;
        }
        return {
          t: 'hello',
          v: raw['v'],
          info,
          ts: raw['ts'],
          sig: raw['sig'],
          role,
          ...(role === 'data' ? { transferId: transferId as string } : {}),
        };
      }
      return { t: 'hello-ok', v: raw['v'], info, ts: raw['ts'], sig: raw['sig'] };
    }
    case 'ping':
    case 'pong': {
      if (!isInt(raw['ts'], 0)) return null;
      return t === 'ping' ? { t: 'ping', ts: raw['ts'] } : { t: 'pong', ts: raw['ts'] };
    }
    case 'offer': {
      const files = decodeFileList(raw['files']);
      if (files === null) return null;
      if (!isStr(raw['transferId'], 64)) return null;
      if (!isInt(raw['totalBytes'], 0)) return null;
      const message = raw['message'];
      if (message !== null && !isStr(message, MAX_MESSAGE_BYTES, true)) return null;
      if (typeof raw['pinRequired'] !== 'boolean') return null;
      const pinHash = raw['pinHash'];
      if (raw['pinRequired']) {
        if (!isHex64(pinHash)) return null;
      } else if (pinHash !== null && !isHex64(pinHash)) {
        return null;
      }
      return {
        t: 'offer',
        transferId: raw['transferId'],
        files,
        totalBytes: raw['totalBytes'],
        message,
        pinRequired: raw['pinRequired'],
        pinHash: pinHash as string | null,
      };
    }
    case 'offer-result': {
      if (!isStr(raw['transferId'], 64)) return null;
      if (typeof raw['accepted'] !== 'boolean') return null;
      const reason = raw['reason'];
      if (reason !== null && !isStr(reason, 64)) return null;
      if (typeof raw['pinRequired'] !== 'boolean') return null;
      return { t: 'offer-result', transferId: raw['transferId'], accepted: raw['accepted'], reason, pinRequired: raw['pinRequired'] };
    }
    case 'progress': {
      if (!isStr(raw['transferId'], 64) || !isStr(raw['fileId'], 64)) return null;
      if (!isInt(raw['offset'], 0) || !isInt(raw['size'], 0)) return null;
      return { t: 'progress', transferId: raw['transferId'], fileId: raw['fileId'], offset: raw['offset'], size: raw['size'] };
    }
    case 'file-done': {
      if (!isStr(raw['transferId'], 64) || !isStr(raw['fileId'], 64)) return null;
      const sha256 = raw['sha256'];
      if (sha256 !== null && !isHex64(sha256)) return null;
      if (!isInt(raw['bytes'], 0)) return null;
      return { t: 'file-done', transferId: raw['transferId'], fileId: raw['fileId'], sha256, bytes: raw['bytes'] };
    }
    case 'done': {
      if (!isStr(raw['transferId'], 64)) return null;
      if (typeof raw['ok'] !== 'boolean') return null;
      const reason = raw['reason'];
      if (reason !== null && !isStr(reason, 128)) return null;
      return { t: 'done', transferId: raw['transferId'], ok: raw['ok'], reason };
    }
    case 'cancel': {
      if (!isStr(raw['transferId'], 64)) return null;
      if (!isStr(raw['reason'], 128)) return null;
      return { t: 'cancel', transferId: raw['transferId'], reason: raw['reason'] };
    }
    case 'msg': {
      if (!isStr(raw['msgId'], 64)) return null;
      if (!isStr(raw['text'], MAX_MESSAGE_BYTES, true)) return null;
      if (!isInt(raw['ts'], 0)) return null;
      return { t: 'msg', msgId: raw['msgId'], text: raw['text'], ts: raw['ts'] };
    }
    case 'msg-ack': {
      if (!isStr(raw['msgId'], 64)) return null;
      return { t: 'msg-ack', msgId: raw['msgId'] };
    }
    case 'stream-req': {
      if (!isStr(raw['transferId'], 64) || !isStr(raw['fileId'], 64)) return null;
      if (!isInt(raw['offset'], 0) || !isInt(raw['length'], 1)) return null;
      return {
        t: 'stream-req',
        transferId: raw['transferId'],
        fileId: raw['fileId'],
        offset: raw['offset'],
        length: raw['length'],
      };
    }
    case 'stream-ok': {
      if (!isStr(raw['fileId'], 64)) return null;
      if (!isInt(raw['offset'], 0) || !isInt(raw['length'], 0)) return null;
      return { t: 'stream-ok', fileId: raw['fileId'], offset: raw['offset'], length: raw['length'] };
    }
    case 'stream-ack': {
      if (!isInt(raw['offset'], 0)) return null;
      return { t: 'stream-ack', offset: raw['offset'] };
    }
    case 'stream-end': {
      if (!isStr(raw['fileId'], 64)) return null;
      if (!isInt(raw['offset'], 0) || !isInt(raw['bytes'], 0)) return null;
      const sha256 = raw['sha256'];
      if (sha256 !== null && !isHex64(sha256)) return null;
      return { t: 'stream-end', fileId: raw['fileId'], offset: raw['offset'], bytes: raw['bytes'], sha256 };
    }
    case 'stream-error': {
      if (!isStr(raw['fileId'], 64) || !isStr(raw['reason'], 128)) return null;
      return { t: 'stream-error', fileId: raw['fileId'], reason: raw['reason'] };
    }
    case 'err': {
      if (!isStr(raw['reason'], 128)) return null;
      return { t: 'err', reason: raw['reason'] };
    }
    default:
      return null;
  }
}

/**
 * Decodes a UDP datagram. The size cap is enforced before parsing so a hostile
 * peer cannot make us allocate for a multi-megabyte payload.
 */
export function decodeUdp(buf: Buffer): Announcement | AnnounceReply | null {
  if (buf.length === 0 || buf.length > UDP_MAX_PAYLOAD) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw['v'] !== PROTOCOL_VERSION) return null;
  if (!isInt(raw['ts'], 0)) return null;
  if (!isSignature(raw['sig'])) return null;
  if (!isStr(raw['host'], 64)) return null;
  const info = decodePeerInfo(raw['info']);
  if (info === null) return null;

  if (raw['t'] === 'announce') {
    return { t: 'announce', v: PROTOCOL_VERSION, info, host: raw['host'], ts: raw['ts'], sig: raw['sig'] };
  }
  if (raw['t'] === 'announce-reply') {
    return { t: 'announce-reply', v: PROTOCOL_VERSION, info, host: raw['host'], ts: raw['ts'], sig: raw['sig'] };
  }
  return null;
}

/** Encodes a control message for the wire. `undefined` fields are dropped. */
export function encodeControl(msg: ControlMessage): Buffer {
  return Buffer.from(JSON.stringify(msg), 'utf8');
}
