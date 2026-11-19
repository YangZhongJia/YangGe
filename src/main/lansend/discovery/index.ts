/**
 * Public surface of the discovery layer.
 *
 * `Discovery` is the only thing consumers normally need; the socket and subnet
 * helpers are exported because the CLI uses `probe`-style utilities and tests
 * exercise them directly.
 */

export { Discovery } from './discovery';
export type { DiscoveryOptions } from './discovery';
export { createDiscoverySocket } from './socket';
export type { DiscoverySocket, DiscoverySocketOptions } from './socket';
export { listInterfaces, mapLimit, subnetHosts } from './subnet';
export type { LocalInterface } from './subnet';
