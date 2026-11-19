/**
 * Peer discovery.
 *
 * Three transports feed one peer table, cheapest first:
 *  1. IPv4 multicast announcements (one datagram reaches every listener);
 *  2. directed broadcast on each interface (survives switches that prune
 *     multicast but not broadcast);
 *  3. a unicast sweep of the local /24 (survives client isolation).
 *
 * Everything inbound is untrusted: a datagram must parse, match the protocol
 * version, carry a valid Ed25519 signature and a fresh timestamp before it can
 * create or refresh a peer.
 */

import {
  ANNOUNCE_BURST_DELAYS_MS,
  ANNOUNCE_DEDUP_MS,
  ANNOUNCE_INTERVAL_MS,
  ANNOUNCE_REPLY_JITTER_MS,
  MAX_SWEEP_HOSTS,
  MULTICAST_GROUP_V4,
  MULTICAST_GROUP_V6,
  PEER_OFFLINE_MS,
  PROBE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  UDP_MAX_PAYLOAD,
} from '../protocol/constants';
import type { DiscoveredPeer, PeerInfo } from '../protocol/types';
import { isValidNodeId, signAnnouncement, toWireInfo, verifyAnnouncement } from '../crypto/identity';
import type { StoredIdentity, WirePeerInfo } from '../crypto/identity';
import { createDiscoverySocket } from './socket';
import type { DiscoverySocket } from './socket';
import { listInterfaces, mapLimit, subnetHosts } from './subnet';
import { withResolvers } from '../util/promise';

/** Inbound datagrams above this are dropped before JSON.parse. */
const MAX_INBOUND_BYTES = 4096;
/** Token bucket: sustained datagrams per second from one address. */
const RATE_LIMIT_PER_SEC = 30;
/** Token bucket: maximum burst from one address. */
const RATE_LIMIT_BURST = 60;
/** Offline check cadence. */
const PRUNE_INTERVAL_MS = 5_000;
/** Minimum spacing between two automatic fallback sweeps. */
const AUTO_SWEEP_COOLDOWN_MS = 30_000;
/** Sweep concurrency; 64 keeps a /24 under ~10 s without flooding an AP. */
const SWEEP_CONCURRENCY = 64;

export interface DiscoveryOptions {
  readonly identity: StoredIdentity;
  /** TCP port advertised in announcements (where the transfer server listens). */
  readonly port: number;
  readonly udpPort: number;
  readonly alias?: string;
  readonly onPeer: (peer: DiscoveredPeer) => void;
  readonly onPeerLost?: (peer: DiscoveredPeer) => void;
  readonly onError?: (scope: string, error: Error) => void;
  /** Injectable clock, milliseconds. Tests use it to simulate offline peers. */
  readonly now?: () => number;
}

interface InboundMessage {
  readonly t: 'announce' | 'announce-reply';
  readonly info: WirePeerInfo;
  readonly host: string;
  readonly ts: number;
  readonly sig: string;
}

interface PendingProbe {
  readonly host: string;
  readonly resolvers: Array<(peer: DiscoveredPeer | null) => void>;
  readonly timer: NodeJS.Timeout;
}

interface TokenBucket {
  tokens: number;
  last: number;
}

function decodePeerInfo(value: object): WirePeerInfo | null {
  // Boundary: parsed JSON. Every field is type-checked before it is used, so
  // the Record view never leaks an unchecked value into a DTO.
  const raw = value as Record<string, unknown>;
  const nodeId = raw['nodeId'];
  const publicKey = raw['publicKey'];
  if (!isValidNodeId(nodeId)) return null;
  if (typeof publicKey !== 'string' || publicKey.length === 0) return null;

  const alias = raw['alias'];
  if (typeof alias !== 'string') return null;
  const port = raw['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return null;

  const platformRaw = raw['platform'];
  const platform: PeerInfo['platform'] =
    platformRaw === 'win32' || platformRaw === 'darwin' || platformRaw === 'linux' || platformRaw === 'android' || platformRaw === 'ios'
      ? platformRaw
      : 'unknown';

  const deviceModel = typeof raw['deviceModel'] === 'string' ? raw['deviceModel'] : 'unknown';
  const version = typeof raw['version'] === 'string' ? raw['version'] : '0.0.0';
  const fingerprint = typeof raw['fingerprint'] === 'string' && raw['fingerprint'].length > 0 ? raw['fingerprint'] : nodeId;
  const protocolVersionsRaw = raw['protocolVersions'];
  const protocolVersions = Array.isArray(protocolVersionsRaw)
    ? protocolVersionsRaw.filter((v): v is number => typeof v === 'number' && Number.isInteger(v))
    : [PROTOCOL_VERSION];

  return {
    nodeId,
    alias,
    platform,
    deviceModel,
    version,
    port,
    fingerprint,
    protocolVersions: protocolVersions.length > 0 ? protocolVersions : [PROTOCOL_VERSION],
    publicKey,
  };
}

function decodeMessage(text: string): InboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  // Boundary cast; all reads below are validated.
  const raw = parsed as Record<string, unknown>;

  const t = raw['t'];
  if (t !== 'announce' && t !== 'announce-reply') return null;
  if (raw['v'] !== PROTOCOL_VERSION) return null;

  const ts = raw['ts'];
  const sig = raw['sig'];
  const host = raw['host'];
  const infoRaw = raw['info'];
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  if (typeof sig !== 'string' || sig.length === 0) return null;
  if (typeof host !== 'string') return null;
  if (typeof infoRaw !== 'object' || infoRaw === null) return null;

  const info = decodePeerInfo(infoRaw);
  if (!info) return null;
  return { t, info, host, ts, sig };
}

export class Discovery {
  readonly #options: DiscoveryOptions;
  readonly #peers = new Map<string, DiscoveredPeer>();
  readonly #replyTimes = new Map<string, number>();
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #pendingProbes = new Map<string, PendingProbe>();
  readonly #timers = new Set<NodeJS.Timeout>();

  #socket: DiscoverySocket | null = null;
  #started = false;
  #interval: NodeJS.Timeout | undefined = undefined;
  #offlineTimer: NodeJS.Timeout | undefined = undefined;
  #fallbackTimer: NodeJS.Timeout | undefined = undefined;
  #lastAutoSweep = -Infinity;

  constructor(options: DiscoveryOptions) {
    this.#options = options;
  }

  /** Peers currently online, keyed by nodeId. */
  get peers(): ReadonlyMap<string, DiscoveredPeer> {
    return this.#peers;
  }

  /** Actual UDP port, useful when `udpPort: 0` was requested. */
  get boundPort(): number {
    return this.#socket?.port ?? this.#options.udpPort;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    try {
      this.#socket = await createDiscoverySocket({
        port: this.#options.udpPort,
        onMessage: (msg, rinfo) => this.#handle(msg, rinfo.address, rinfo.port),
        onError: (scope, error) => this.#report(scope, error),
      });
    } catch (error) {
      this.#started = false;
      throw error;
    }

    this.#interval = setInterval(() => this.#announce(), ANNOUNCE_INTERVAL_MS);
    this.#offlineTimer = setInterval(() => this.#prune(), PRUNE_INTERVAL_MS);

    for (const delay of ANNOUNCE_BURST_DELAYS_MS) {
      if (delay <= 0) {
        this.#announce();
        continue;
      }
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        this.#announce();
      }, delay);
      this.#timers.add(timer);
    }

    // A network with multicast blocked produces no peers at all; a single
    // unicast sweep after a short grace period usually fixes that.
    this.#scheduleFallback(2_000);
  }

  async stop(): Promise<void> {
    if (!this.#started && this.#socket === null) {
      this.#clearTimers();
      return;
    }
    this.#started = false;
    this.#clearTimers();
    this.#settlePending(null);
    this.#replyTimes.clear();
    this.#buckets.clear();
    this.#peers.clear();

    const socket = this.#socket;
    this.#socket = null;
    if (socket) await socket.close();
  }

  /** Forces an announcement burst right now (CLI "rescan" button). */
  announceNow(): void {
    if (!this.#started) return;
    this.#announce();
  }

  /**
   * Probes one host directly. `port` defaults to the configured UDP port and
   * only differs for tests / ad-hoc CLI use.
   */
  async probe(host: string, port?: number): Promise<DiscoveredPeer | null> {
    if (!this.#started || this.#socket === null) return null;
    const datagram = this.#buildDatagram('announce');
    if (!datagram) return null;

    const targetPort = port ?? this.#announcePort();
    const { promise, resolve } = withResolvers<DiscoveredPeer | null>();

    let pending = this.#pendingProbes.get(host);
    if (!pending) {
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        this.#settleProbe(host, null);
      }, PROBE_TIMEOUT_MS);
      this.#timers.add(timer);
      pending = { host, resolvers: [], timer };
      this.#pendingProbes.set(host, pending);
    }
    pending.resolvers.push(resolve);

    this.#socket.send(datagram, host, targetPort);
    return promise;
  }

  /** Sweeps the /24 of every local interface; never rejects. */
  async sweep(): Promise<DiscoveredPeer[]> {
    if (!this.#started || this.#socket === null) return [];

    const hosts: string[] = [];
    const seen = new Set<string>();
    for (const iface of listInterfaces()) {
      for (const host of subnetHosts(iface.address, iface.netmask)) {
        if (seen.has(host)) continue;
        if (hosts.length >= MAX_SWEEP_HOSTS) break;
        seen.add(host);
        hosts.push(host);
      }
      if (hosts.length >= MAX_SWEEP_HOSTS) break;
    }

    const found = new Map<string, DiscoveredPeer>();
    await mapLimit(hosts, SWEEP_CONCURRENCY, async (host) => {
      const peer = await this.probe(host);
      if (peer) found.set(peer.nodeId, peer);
    });
    return [...found.values()];
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /** Peers announce/bind on the configured port, or on the ephemeral one. */
  #announcePort(): number {
    return this.#options.udpPort !== 0 ? this.#options.udpPort : (this.#socket?.port ?? 0);
  }

  #buildDatagram(kind: 'announce' | 'announce-reply'): Buffer | null {
    const ts = this.#now();
    const info = toWireInfo(this.#options.identity, { port: this.#options.port, alias: this.#options.alias });
    const host = this.#localHost();
    const payload = {
      t: kind,
      v: PROTOCOL_VERSION,
      info,
      host,
      ts,
      sig: signAnnouncement(this.#options.identity, ts),
    };
    const datagram = Buffer.from(JSON.stringify(payload), 'utf8');
    if (datagram.length > UDP_MAX_PAYLOAD) {
      this.#report('announce', new Error(`announcement is ${datagram.length} bytes, over ${UDP_MAX_PAYLOAD}`));
      return null;
    }
    return datagram;
  }

  #announce(): void {
    if (!this.#started || this.#socket === null) return;
    const datagram = this.#buildDatagram('announce');
    if (!datagram) return;
    const port = this.#announcePort();

    this.#socket.send(datagram, MULTICAST_GROUP_V4, port);
    // Best-effort; the socket layer drops this when no IPv6 socket exists.
    this.#socket.send(datagram, MULTICAST_GROUP_V6, port);
    for (const iface of listInterfaces()) this.#socket.send(datagram, iface.broadcast, port);
  }

  #sendReply(host: string, port: number): void {
    if (!this.#started || this.#socket === null) return;
    const datagram = this.#buildDatagram('announce-reply');
    if (!datagram) return;
    this.#socket.send(datagram, host, port);
  }

  #localHost(): string {
    const interfaces = listInterfaces();
    return interfaces[0]?.address ?? '127.0.0.1';
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  #handle(msg: Buffer, host: string, port: number): void {
    if (!this.#started) return;
    if (msg.length > MAX_INBOUND_BYTES) return;
    if (!this.#allow(host)) return;

    const message = decodeMessage(msg.toString('utf8'));
    if (!message) return;
    if (message.info.nodeId === this.#options.identity.nodeId) return;

    const now = this.#now();
    const verdict = verifyAnnouncement({
      nodeId: message.info.nodeId,
      publicKey: message.info.publicKey,
      ts: message.ts,
      sig: message.sig,
      now,
    });
    if (!verdict.ok) return;

    const source: DiscoveredPeer['source'] = this.#pendingProbes.has(host)
      ? 'sweep'
      : (this.#peers.get(message.info.nodeId)?.source ?? 'multicast');
    const peer = this.#recordPeer(message.info, host, source);

    if (message.t === 'announce') {
      this.#scheduleReply(message.info.nodeId, host, port);
    } else {
      this.#settleProbe(host, peer);
    }
  }

  #recordPeer(info: PeerInfo, host: string, source: DiscoveredPeer['source']): DiscoveredPeer {
    const peer: DiscoveredPeer = {
      nodeId: info.nodeId,
      alias: info.alias,
      platform: info.platform,
      deviceModel: info.deviceModel,
      version: info.version,
      port: info.port,
      fingerprint: info.fingerprint,
      protocolVersions: info.protocolVersions,
      host,
      lastSeen: this.#now(),
      favorite: false,
      source,
    };

    const previous = this.#peers.get(peer.nodeId);
    this.#peers.set(peer.nodeId, peer);

    // A pure keepalive must not spam the UI; alias, address or TCP port
    // changes are real updates worth re-emitting.
    const changed =
      !previous ||
      previous.alias !== peer.alias ||
      previous.port !== peer.port ||
      previous.host !== peer.host;
    if (changed) {
      try {
        this.#options.onPeer(peer);
      } catch (error) {
        this.#report('onPeer', error instanceof Error ? error : new Error(String(error)));
      }
    }
    return peer;
  }

  #scheduleReply(nodeId: string, host: string, port: number): void {
    const now = this.#now();
    const last = this.#replyTimes.get(nodeId);
    if (last !== undefined && now - last < ANNOUNCE_DEDUP_MS) return;
    this.#replyTimes.set(nodeId, now);

    const delay = Math.random() * ANNOUNCE_REPLY_JITTER_MS;
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.#sendReply(host, port);
    }, delay);
    this.#timers.add(timer);
  }

  // -------------------------------------------------------------------------
  // Probes
  // -------------------------------------------------------------------------

  #settleProbe(host: string, peer: DiscoveredPeer | null): void {
    const pending = this.#pendingProbes.get(host);
    if (!pending) return;
    this.#pendingProbes.delete(host);
    clearTimeout(pending.timer);
    this.#timers.delete(pending.timer);
    for (const resolve of pending.resolvers) resolve(peer);
  }

  #settlePending(peer: DiscoveredPeer | null): void {
    for (const host of [...this.#pendingProbes.keys()]) this.#settleProbe(host, peer);
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  #prune(): void {
    if (!this.#started) return;
    const now = this.#now();
    for (const [nodeId, peer] of this.#peers) {
      if (now - peer.lastSeen <= PEER_OFFLINE_MS) continue;
      this.#peers.delete(nodeId);
      try {
        this.#options.onPeerLost?.(peer);
      } catch (error) {
        this.#report('onPeerLost', error instanceof Error ? error : new Error(String(error)));
      }
    }
    for (const [nodeId, at] of this.#replyTimes) {
      if (now - at > ANNOUNCE_DEDUP_MS) this.#replyTimes.delete(nodeId);
    }
    // Buckets are cheap, but an interface churn over days can leave tens of
    // thousands of idle entries.
    for (const [ip, bucket] of this.#buckets) {
      if (now - bucket.last > 60_000) this.#buckets.delete(ip);
    }
  }

  #allow(ip: string): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(ip);
    if (!bucket) {
      this.#buckets.set(ip, { tokens: RATE_LIMIT_BURST - 1, last: now });
      return true;
    }
    const elapsedSeconds = Math.max(0, now - bucket.last) / 1000;
    bucket.last = now;
    bucket.tokens = Math.min(RATE_LIMIT_BURST, bucket.tokens + elapsedSeconds * RATE_LIMIT_PER_SEC);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  #scheduleFallback(delay: number): void {
    this.#fallbackTimer = setTimeout(() => {
      this.#fallbackTimer = undefined;
      if (!this.#started) return;

      const now = this.#now();
      if (this.#peers.size === 0 && now - this.#lastAutoSweep >= AUTO_SWEEP_COOLDOWN_MS) {
        this.#lastAutoSweep = now;
        void this.sweep();
      }
      // Keep checking: a laptop that lost its Wi-Fi association will have an
      // empty table again, and the next sweep should not need a restart.
      this.#scheduleFallback(AUTO_SWEEP_COOLDOWN_MS);
    }, delay);
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    clearInterval(this.#interval);
    clearInterval(this.#offlineTimer);
    clearTimeout(this.#fallbackTimer);
    this.#interval = undefined;
    this.#offlineTimer = undefined;
    this.#fallbackTimer = undefined;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #report(scope: string, error: Error): void {
    try {
      this.#options.onError?.(scope, error);
    } catch {
      // An error handler that throws must not break discovery.
    }
  }
}
