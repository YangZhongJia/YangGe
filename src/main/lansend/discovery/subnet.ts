/**
 * Local interface enumeration and subnet sweep helpers.
 *
 * Discovery has two ways to find peers: the multicast/broadcast path, which is
 * cheap but sometimes blocked (AP isolation, Wi-Fi client isolation, old
 * switches), and a brute-force unicast sweep of the local /24, which always
 * works because it is indistinguishable from ordinary unicast traffic.
 *
 * Only the /24 that contains our own address is swept. Sweeping every /24 of a
 * /16 would send 65k datagrams per sweep, and a /24 is the only thing a
 * consumer LAN realistically uses.
 */

import { networkInterfaces } from 'node:os';

import { MAX_SWEEP_HOSTS } from '../protocol/constants';

export interface LocalInterface {
  readonly name: string;
  readonly address: string;
  readonly netmask: string;
  readonly broadcast: string;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function intToIpv4(value: number): string {
  const v = value >>> 0;
  return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
}

/** Prefix length of a dotted netmask, or null if the mask is not contiguous. */
function prefixLength(netmask: string): number | null {
  const mask = ipv4ToInt(netmask);
  if (mask === null) return null;
  let prefix = 0;
  let seenZero = false;
  for (let bit = 31; bit >= 0; bit--) {
    const on = ((mask >>> bit) & 1) === 1;
    if (on) {
      // A one after a zero would make the mask non-contiguous; OSes do not
      // produce those, but a caller-supplied mask might.
      if (seenZero) return null;
      prefix += 1;
    } else {
      seenZero = true;
    }
  }
  return prefix;
}

/** All IPv4, non-internal interfaces with their directed broadcast address. */
export function listInterfaces(): LocalInterface[] {
  const out: LocalInterface[] = [];
  const interfaces = networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses) continue;
    for (const info of addresses) {
      // Node reports `family` as a string since v18, but older typings still
      // allow the numeric form; accept both so this never silently drops all
      // interfaces.
      const family = info.family as string | number;
      if (family !== 'IPv4' && family !== 4) continue;
      if (info.internal) continue;
      const address = ipv4ToInt(info.address);
      const mask = ipv4ToInt(info.netmask);
      if (address === null || mask === null) continue;
      const broadcast = (address & mask) | (~mask >>> 0);
      out.push({
        name,
        address: info.address,
        netmask: info.netmask,
        broadcast: intToIpv4(broadcast),
      });
    }
  }
  return out;
}

/**
 * Hosts to probe for one interface: .1-.254 of the /24 containing `address`,
 * without our own address. Returns [] for networks smaller than /24, because
 * those are point-to-point links where a sweep is meaningless.
 */
export function subnetHosts(address: string, netmask: string): string[] {
  const prefix = prefixLength(netmask);
  if (prefix === null || prefix < 24) return [];
  const self = ipv4ToInt(address);
  if (self === null) return [];

  const base = self & 0xffffff00;
  const hosts: string[] = [];
  for (let host = 1; host <= 254; host++) {
    const candidate = (base | host) >>> 0;
    if (candidate === self) continue;
    hosts.push(intToIpv4(candidate));
    if (hosts.length >= MAX_SWEEP_HOSTS) break;
  }
  return hosts;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight, preserving result
 * order. Stops at the first rejection; a sweep relies on probe() never
 * rejecting.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
