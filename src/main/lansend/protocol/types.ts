/**
 * Wire DTOs and the public service types.
 *
 * Two audiences share this file:
 *  - the protocol codec (`codec.ts`), which validates untrusted JSON against
 *    these shapes;
 *  - the public API (`service.ts`), which exposes the `readonly` variants.
 *
 * Rules that keep the codec honest:
 *  - Every DTO that arrives from the network has a `decode*` function in
 *    `codec.ts` that returns `null` instead of throwing. Nothing untyped
 *    crosses into the transfer engine.
 *  - Field names on the wire are short (`t`, `v`, `id`) because they are
 *    repeated in every frame; the internal types spell them out.
 */



// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * A device's stable identity. `nodeId` is derived from the public key so the
 * two can never disagree: a peer that presents a different key for the same
 * nodeId is rejected.
 */
export interface DeviceIdentity {
  /** SHA-256 of the DER public key, lowercase hex, 64 chars. Stable across restarts. */
  readonly nodeId: string;
  /** Ed25519 public key, DER/SPKI, base64. */
  readonly publicKey: string;
  /** Ed25519 private key, DER/PKCS8, base64. Never leaves the device. */
  readonly privateKey: string;
  /** Human-readable, shown to peers. Not authenticated by itself. */
  readonly alias: string;
}

/** What a peer advertises about itself. Sent in `hello` and in announcements. */
export interface PeerInfo {
  readonly nodeId: string;
  readonly alias: string;
  /** OS family, purely cosmetic in the UI. */
  readonly platform: 'win32' | 'darwin' | 'linux' | 'android' | 'ios' | 'unknown';
  readonly deviceModel: string;
  /** App version, for capability negotiation. */
  readonly version: string;
  /** TCP port the peer's transfer server listens on. */
  readonly port: number;
  /** SHA-256 of the peer's public key. Equal to nodeId; kept for clarity at call sites. */
  readonly fingerprint: string;
  /** Protocol versions this peer speaks, newest first. */
  readonly protocolVersions: readonly number[];
}

/** A peer as seen by the discovery layer. */
export interface DiscoveredPeer extends PeerInfo {
  /** Last known address. Updated on every announcement. */
  readonly host: string;
  /** Epoch ms of the last announcement / successful probe. */
  readonly lastSeen: number;
  /** True for peers in the favorites list; they are probed first. */
  readonly favorite: boolean;
  /** How the peer was found. `multicast` is the cheap path. */
  readonly source: 'multicast' | 'broadcast' | 'sweep' | 'manual' | 'favorite';
}

// ---------------------------------------------------------------------------
// Transfer manifest
// ---------------------------------------------------------------------------

/** One file in an offer. Paths are always relative and POSIX-separated. */
export interface FileEntry {
  /** Unique within the transfer. */
  readonly fileId: string;
  /** Base name, already sanitized. */
  readonly name: string;
  /** Path relative to the transfer root, e.g. `photos/2024/a.jpg`. */
  readonly relativePath: string;
  readonly size: number;
  /** Epoch ms, or null when unknown. */
  readonly mtime: number | null;
  /** Whole-file SHA-256 (lowercase hex) when the sender chose to compute it. */
  readonly sha256: string | null;
}

export interface TransferOffer {
  readonly transferId: string;
  readonly from: PeerInfo;
  readonly files: readonly FileEntry[];
  readonly totalBytes: number;
  /** Optional message the sender attached. */
  readonly message: string | null;
  /** True when the receiver must supply a PIN. */
  readonly pinRequired: boolean;
}

export type OfferDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: string };

// ---------------------------------------------------------------------------
// Control messages (kind = FRAME_CONTROL)
// ---------------------------------------------------------------------------

export const CONTROL_TYPES = [
  'hello',
  'hello-ok',
  'ping',
  'pong',
  'offer',
  'offer-result',
  'progress',
  'file-done',
  'done',
  'cancel',
  'msg',
  'msg-ack',
  'stream-req',
  'stream-ok',
  'stream-ack',
  'stream-end',
  'stream-error',
  'err',
] as const;

export type ControlType = (typeof CONTROL_TYPES)[number];

/** `hello` is the first frame on every connection, both directions. */
export interface HelloMessage {
  readonly t: 'hello';
  readonly v: number;
  readonly info: PeerInfo & { readonly publicKey: string };
  /** Epoch ms the signature was made; rejected outside a ±60 s window. */
  readonly ts: number;
  /** Ed25519 signature over `${nodeId}\n${ts}\n${role}`. */
  readonly sig: string;
  /** What this connection is for. Signed, so it cannot be flipped in flight. */
  readonly role: 'control' | 'data';
  /** Data links only: the transfer this connection serves. Also signed. */
  readonly transferId?: string;
}

export interface HelloOkMessage {
  readonly t: 'hello-ok';
  readonly v: number;
  readonly info: PeerInfo & { readonly publicKey: string };
  readonly ts: number;
  readonly sig: string;
}

export interface PingMessage {
  readonly t: 'ping';
  readonly ts: number;
}

export interface PongMessage {
  readonly t: 'pong';
  readonly ts: number;
}

export interface OfferMessage {
  readonly t: 'offer';
  readonly transferId: string;
  readonly files: readonly FileEntry[];
  readonly totalBytes: number;
  readonly message: string | null;
  readonly pinRequired: boolean;
  /** SHA-256 (hex) of `pin` when `pinRequired`; the PIN itself never travels. */
  readonly pinHash: string | null;
}

export interface OfferResultMessage {
  readonly t: 'offer-result';
  readonly transferId: string;
  readonly accepted: boolean;
  readonly reason: string | null;
  /** Set when the receiver rejects because the PIN was missing or wrong. */
  readonly pinRequired: boolean;
}

export interface ProgressMessage {
  readonly t: 'progress';
  readonly transferId: string;
  readonly fileId: string;
  /** Bytes written for this file so far. */
  readonly offset: number;
  readonly size: number;
}

export interface FileDoneMessage {
  readonly t: 'file-done';
  readonly transferId: string;
  readonly fileId: string;
  /** SHA-256 of the file as written by the receiver; null when not verified. */
  readonly sha256: string | null;
  readonly bytes: number;
}

export interface DoneMessage {
  readonly t: 'done';
  readonly transferId: string;
  readonly ok: boolean;
  readonly reason: string | null;
}

export interface CancelMessage {
  readonly t: 'cancel';
  readonly transferId: string;
  readonly reason: string;
}

export interface MsgMessage {
  readonly t: 'msg';
  readonly msgId: string;
  readonly text: string;
  readonly ts: number;
}

export interface MsgAckMessage {
  readonly t: 'msg-ack';
  readonly msgId: string;
}

/** Data-plane: receiver asks the sender to stream a byte range. */
export interface StreamReqMessage {
  readonly t: 'stream-req';
  readonly transferId: string;
  readonly fileId: string;
  readonly offset: number;
  /** Number of bytes requested; clamped to the remaining file size by the sender. */
  readonly length: number;
}

export interface StreamOkMessage {
  readonly t: 'stream-ok';
  readonly fileId: string;
  readonly offset: number;
  readonly length: number;
}

/** Data-plane: how many bytes of the current range are durably on disk. */
export interface StreamAckMessage {
  readonly t: 'stream-ack';
  readonly offset: number;
}

export interface StreamEndMessage {
  readonly t: 'stream-end';
  readonly fileId: string;
  readonly offset: number;
  readonly bytes: number;
  /** Present only when the sender streamed the entire file and hashed it. */
  readonly sha256: string | null;
}

export interface StreamErrorMessage {
  readonly t: 'stream-error';
  readonly fileId: string;
  readonly reason: string;
}

export interface ErrMessage {
  readonly t: 'err';
  readonly reason: string;
}

export type ControlMessage =
  | HelloMessage
  | HelloOkMessage
  | PingMessage
  | PongMessage
  | OfferMessage
  | OfferResultMessage
  | ProgressMessage
  | FileDoneMessage
  | DoneMessage
  | CancelMessage
  | MsgMessage
  | MsgAckMessage
  | StreamReqMessage
  | StreamOkMessage
  | StreamAckMessage
  | StreamEndMessage
  | StreamErrorMessage
  | ErrMessage;

// ---------------------------------------------------------------------------
// Announcements (UDP)
// ---------------------------------------------------------------------------

/** Sent to the multicast group / broadcast address. Must fit one datagram. */
export interface Announcement {
  readonly t: 'announce';
  readonly v: number;
  readonly info: PeerInfo;
  readonly host: string;
  /** Epoch ms, for ordering and replay rejection. */
  readonly ts: number;
  /** Ed25519 signature over `${nodeId}\n${ts}`. */
  readonly sig: string;
}

/** Unicast reply to an announcement or a sweep probe. */
export interface AnnounceReply {
  readonly t: 'announce-reply';
  readonly v: number;
  readonly info: PeerInfo;
  readonly host: string;
  readonly ts: number;
  readonly sig: string;
}

export type UdpMessage = Announcement | AnnounceReply;

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface SendOptions {
  /** Target peer, with its resolved address. */
  readonly peer: DiscoveredPeer;
  /** Absolute paths; directories are walked recursively. */
  readonly paths: readonly string[];
  /** Optional text attached to the offer. */
  readonly message?: string;
  /** Called once the transfer id exists, before waiting for the peer's reply. */
  readonly onStarted?: (transferId: string) => void;
  /** PIN demanded by the receiver, when known. */
  readonly pin?: string;
  /** Overrides for tuning; see `TransferTuning`. */
  readonly tuning?: Partial<TransferTuning>;
}

export interface TransferTuning {
  /** Bitmap granularity in bytes. */
  readonly chunkSize: number;
  /** Bytes per `stream-req`. A multiple of `chunkSize`, except at EOF. */
  readonly rangeBytes: number;
  /** Parallel data connections. The only source of concurrency. */
  readonly connections: number;
  /** Hash files up to this size on the sender; 0 disables. */
  readonly hashMaxBytes: number;
  /** Retries per range before the transfer fails. */
  readonly maxRetries: number;
}

export interface TransferProgress {
  readonly transferId: string;
  readonly direction: 'send' | 'receive';
  readonly peer: PeerInfo;
  readonly fileId: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly size: number;
  readonly totalBytes: number;
  readonly totalTransferred: number;
  readonly speedBps: number;
  readonly etaMs: number | null;
}

export type TransferState = 'pending' | 'accepted' | 'transferring' | 'completed' | 'failed' | 'cancelled';

export interface TransferSummary {
  readonly transferId: string;
  readonly direction: 'send' | 'receive';
  readonly peer: PeerInfo;
  readonly state: TransferState;
  readonly files: readonly FileEntry[];
  readonly totalBytes: number;
  readonly bytesTransferred: number;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly error: string | null;
  /** Directory the files landed in (receive only). */
  readonly destination: string | null;
}

export type ServiceEventMap = {
  peerFound: DiscoveredPeer;
  peerLost: DiscoveredPeer;
  peerUpdated: DiscoveredPeer;
  /** An incoming offer; resolve the promise to accept or reject. */
  offer: { offer: TransferOffer; respond: (decision: OfferDecision) => void };
  progress: TransferProgress;
  transferCompleted: TransferSummary;
  transferFailed: TransferSummary & { error: string };
  transferCancelled: TransferSummary;
  message: { from: PeerInfo; text: string; ts: number };
  error: { scope: string; error: Error };
};
