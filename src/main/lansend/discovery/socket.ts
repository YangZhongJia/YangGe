/**
 * UDP socket used by discovery: one IPv4 socket (the baseline) plus a
 * best-effort IPv6 socket on the same port.
 *
 * IPv4 gets all the attention because multicast over IPv4 works everywhere,
 * including old switches and consumer routers; IPv6 is a bonus for dual-stack
 * networks that block IPv4 multicast. A failure to open or join IPv6 must
 * never take discovery down, so every IPv6 step is wrapped.
 */

import { createSocket } from 'node:dgram';
import type { RemoteInfo, Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

import { MULTICAST_GROUP_V4, MULTICAST_GROUP_V6, MULTICAST_TTL, UDP_MAX_PAYLOAD } from '../protocol/constants';
import { listInterfaces } from './subnet';
import { withResolvers } from '../util/promise';

/** Datagrams above this are not ours; drop before parsing anything. */
const MAX_INBOUND_BYTES = 4096;
/** Ports tried past the preferred one before giving up (config drift / leftovers). */
const PORT_ATTEMPTS = 10;

export interface DiscoverySocketOptions {
  readonly port: number;
  readonly onMessage: (msg: Buffer, rinfo: RemoteInfo) => void;
  readonly onError?: (scope: string, error: Error) => void;
}

export interface DiscoverySocket {
  /** Actual bound port. For `port: 0` this is the ephemeral port the OS chose. */
  readonly port: number;
  send(buf: Buffer, host: string, port: number): void;
  close(): Promise<void>;
}

interface BoundSocket {
  readonly socket: Socket;
  readonly port: number;
}

async function bindOnce(socket: Socket, port: number, address = '0.0.0.0'): Promise<number> {
  const { promise, resolve, reject } = withResolvers<number>();
  const onError = (error: Error): void => {
    socket.removeListener('listening', onListening);
    reject(error);
  };
  const onListening = (): void => {
    socket.removeListener('error', onError);
    resolve(socket.address().port);
  };
  socket.once('error', onError);
  socket.once('listening', onListening);
  socket.bind({ port, address, exclusive: false });
  return promise;
}

/** Binds, walking port..port+10 on EADDRINUSE. */
async function bindWithRetry(
  makeSocket: () => Socket,
  port: number,
): Promise<BoundSocket> {
  const candidates = port === 0 ? [0] : Array.from({ length: PORT_ATTEMPTS + 1 }, (_, i) => port + i).filter((p) => p <= 65535);
  let lastError: unknown;
  for (const candidate of candidates) {
    const socket = makeSocket();
    try {
      const bound = await bindOnce(socket, candidate);
      return { socket, port: bound };
    } catch (error) {
      lastError = error;
      socket.close();
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('unable to bind UDP socket');
}

async function bindV6(port: number): Promise<BoundSocket> {
  const socket = createSocket({ type: 'udp6', reuseAddr: true });
  try {
    // `::` is the IPv6 wildcard. Passing the IPv4 wildcard here fails with
    // EINVAL on every platform, which used to surface as a noisy startup error.
    const bound = await bindOnce(socket, port, '::');
    return { socket, port: bound };
  } catch (error) {
    socket.close();
    throw error;
  }
}

function joinBestEffort(socket: Socket, group: string, iface: string, onError?: (scope: string, error: Error) => void): void {
  try {
    socket.addMembership(group, iface);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENODEV/EADDRINUSE just mean this interface cannot carry the group (VPN
    // adapters, down links, IPv6-less hosts). Not worth surfacing.
    if (code === 'ENODEV' || code === 'EADDRINUSE' || code === 'EINVAL' || code === 'EAFNOSUPPORT') return;
    onError?.('multicast-join', error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Opens the discovery socket. The returned port is the real one, which matters
 * for `port: 0` tests and for the "preferred port was taken" fallback.
 */
export async function createDiscoverySocket(options: DiscoverySocketOptions): Promise<DiscoverySocket> {
  const { onMessage, onError } = options;

  const v4 = await bindWithRetry(() => createSocket({ type: 'udp4', reuseAddr: true }), options.port);
  const v4socket = v4.socket;
  let closed = false;

  try {
    v4socket.setBroadcast(true);
    v4socket.setMulticastTTL(MULTICAST_TTL);
    // Essential for tests and for two instances on one machine: without it the
    // kernel drops our own group traffic before it reaches the peer socket.
    v4socket.setMulticastLoopback(true);
  } catch (error) {
    onError?.('socket-config', error instanceof Error ? error : new Error(String(error)));
  }

  const interfaces = listInterfaces();
  for (const iface of interfaces) joinBestEffort(v4socket, MULTICAST_GROUP_V4, iface.address, onError);
  // On a host with no non-internal IPv4 interface (CI containers, airplane
  // mode) loopback is the only way two local instances can meet.
  if (interfaces.length === 0) joinBestEffort(v4socket, MULTICAST_GROUP_V4, '127.0.0.1', onError);

  v4socket.on('message', (msg, rinfo) => {
    if (!Buffer.isBuffer(msg) || msg.length > MAX_INBOUND_BYTES) return;
    onMessage(msg, rinfo);
  });
  v4socket.on('error', (error) => onError?.('udp4', error));

  let v6: BoundSocket | null = null;
  try {
    v6 = await bindV6(v4.port);
    const v6socket = v6.socket;
    v6socket.setMulticastTTL(MULTICAST_TTL);
    v6socket.setMulticastLoopback(true);
    for (const addresses of Object.values(networkInterfaces())) {
      if (!addresses) continue;
      for (const info of addresses) {
        const family = info.family as string | number;
        if (family !== 'IPv6' && family !== 6) continue;
        if (info.internal) continue;
        joinBestEffort(v6socket, MULTICAST_GROUP_V6, info.address, onError);
      }
    }
    v6socket.on('message', (msg, rinfo) => {
      if (!Buffer.isBuffer(msg) || msg.length > MAX_INBOUND_BYTES) return;
      onMessage(msg, rinfo);
    });
    v6socket.on('error', (error) => onError?.('udp6', error));
  } catch (error) {
    // IPv4 is the contract; IPv6 is opportunistic.
    v6 = null;
    onError?.('udp6', error instanceof Error ? error : new Error(String(error)));
  }

  const closeSocket = (socket: Socket): Promise<void> => {
    const { promise, resolve } = withResolvers<void>();
    try {
      socket.close(() => resolve());
    } catch {
      // Already closed; the caller only cares that the handle is gone.
      resolve();
    }
    return promise;
  };

  return {
    port: v4.port,
    send(buf: Buffer, host: string, port: number): void {
      if (closed) return;
      // Anything larger would fragment at the IP layer or exceed the protocol
      // cap; silently dropping is correct because every send is advisory.
      if (buf.length > UDP_MAX_PAYLOAD) return;
      const family6 = host.includes(':');
      const socket = family6 ? v6?.socket : v4socket;
      if (!socket) return;
      try {
        socket.send(buf, 0, buf.length, port, host, (error) => {
          if (error) onError?.('send', error);
        });
      } catch (error) {
        onError?.('send', error instanceof Error ? error : new Error(String(error)));
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await closeSocket(v4socket);
      if (v6) await closeSocket(v6.socket);
    },
  };
}
