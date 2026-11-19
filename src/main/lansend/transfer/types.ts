/**
 * The smallest writing surface the sender relies on.
 *
 * Keeping this structural instead of importing `node:net` means tests can use
 * an in-memory duplex, and the net layer stays free to wrap TLS or a proxy.
 * A real `net.Socket` satisfies every member; `on`/`off` are optional because
 * the mandatory contract only needs `once('drain')`, but when present they let
 * the sender abort a drain wait if the peer disappears without draining.
 */
export interface DuplexLike {
  write(chunk: Buffer): boolean;
  cork(): void;
  uncork(): void;
  once(event: 'drain', listener: () => void): void;
  destroy(error?: Error): void;
  readonly destroyed: boolean;
  pause?(): void;
  resume?(): void;
  on?(event: 'close', listener: () => void): void;
  off?(event: 'drain' | 'close', listener: () => void): void;
}
