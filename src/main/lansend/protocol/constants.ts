/**
 * Wire protocol constants.
 *
 * Everything here is part of the compatibility surface between peers: a peer
 * with a different value for any of these either refuses to talk (version) or
 * misbehaves subtly (timeouts). Keep them in one file so the protocol doc and
 * the implementation cannot drift.
 */

/** Bumped on any incompatible change to frames, DTOs or handshake order. */
export const PROTOCOL_VERSION = 1;

/**
 * A single TCP port carries both planes: long-lived control links and
 * short-lived data connections. The first frame on a connection decides which
 * one it is, so only one port has to be reachable / firewalled.
 */
export const DEFAULT_PORT = 53318;

/** UDP port for announcements. Same number as the TCP port by convention. */
export const DEFAULT_UDP_PORT = 53318;

/**
 * IPv4 multicast group. Inside 239.0.0.0/8 (administratively scoped), which
 * routers are allowed to keep on the local segment, unlike 224.0.0.x.
 */
export const MULTICAST_GROUP_V4 = '239.255.77.77';

/** IPv6 equivalent: transient, link-local scope. */
export const MULTICAST_GROUP_V6 = 'ff12::6c61:6e73';

/** Multicast TTL. 1 = never leaves the local link, which is the whole point. */
export const MULTICAST_TTL = 1;

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** Frame kinds. Byte 4 of every frame. */
export const FRAME_CONTROL = 1;
export const FRAME_DATA = 2;

/** u32be payload length + u8 kind. The length counts the kind byte too. */
export const FRAME_HEADER_BYTES = 5;

/** Control frames are JSON; a cap keeps a hostile peer from allocating GBs. */
export const MAX_CONTROL_FRAME_BYTES = 4 * 1024 * 1024;

/** Data frames carry raw file bytes, so they get a bigger ceiling. */
export const MAX_DATA_FRAME_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Transfer tuning
// ---------------------------------------------------------------------------

/**
 * Default chunk size. 1 MiB keeps the per-chunk bookkeeping (one JSON request,
 * one positioned write, one bitmap bit) at ~0.1% overhead at gigabit rates
 * while staying far below the point where a single lost connection wastes a
 * noticeable amount of work.
 */
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;

/**
 * Parallel data connections per transfer. One TCP stream saturates a 1 GbE
 * link on its own; the extra connections exist for 2.5/10 GbE and for Wi-Fi
 * links where per-stream throughput is limited by the radio scheduler.
 */
export const DEFAULT_CONNECTIONS = 4;

/**
 * Bytes per `stream-req`. Larger ranges amortize the per-range round trip;
 * smaller ranges bound the work lost when a connection dies. 4 MiB is ~35 ms
 * at 1 GbE, so a mid-range failure costs well under a second.
 */
export const DEFAULT_RANGE_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Periodic presence announcement. */
export const ANNOUNCE_INTERVAL_MS = 10_000;

/**
 * A new peer's announcement is repeated a few times because a single datagram
 * is easily lost, especially right after a device joins the network.
 */
export const ANNOUNCE_BURST_DELAYS_MS = [0, 250, 1200];

/** No announcement for this long marks the peer offline (3 missed intervals). */
export const PEER_OFFLINE_MS = 35_000;

/**
 * Suppresses the reply storm: a peer that announced itself is not answered
 * again within this window, so N nodes do not produce N^2 datagrams.
 */
export const ANNOUNCE_DEDUP_MS = 8_000;

/** Jitter added before replying, so a subnet scan does not get N replies at once. */
export const ANNOUNCE_REPLY_JITTER_MS = 400;

/** Per-host timeout during a subnet sweep. */
export const PROBE_TIMEOUT_MS = 1_500;

/** Upper bound on hosts probed by one subnet sweep (/24). */
export const MAX_SWEEP_HOSTS = 512;

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const IDLE_TIMEOUT_MS = 60_000;
export const CONNECT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Announcements must fit one datagram; anything bigger is a protocol error. */
export const UDP_MAX_PAYLOAD = 1400;

/** Hard caps so a hostile offer cannot exhaust memory. */
export const MAX_FILES = 8192;
export const MAX_REL_BYTES = 1024;
export const MAX_ALIAS_BYTES = 64;
export const MAX_MESSAGE_BYTES = 4096;

/** Consecutive failed PIN attempts from one address before the offer is refused. */
export const MAX_PIN_ATTEMPTS = 5;
