/**
 * Public entry point.
 *
 * Consumers (the YangGe Electron main process, the CLI, tests) import only
 * from here. `./protocol/types.ts` is re-exported for typing IPC payloads
 * without pulling in the runtime.
 */

export { createLanSend, DEFAULT_TUNING } from './service';
export type { LanSend, LanSendOptions } from './service';

export type {
  ControlMessage,
  DiscoveredPeer,
  DeviceIdentity,
  FileEntry,
  OfferDecision,
  PeerInfo,
  SendOptions,
  ServiceEventMap,
  TransferOffer,
  TransferProgress,
  TransferState,
  TransferSummary,
  TransferTuning,
} from './protocol/types';

export {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CONNECTIONS,
  DEFAULT_PORT,
  DEFAULT_RANGE_BYTES,
  PROTOCOL_VERSION,
} from './protocol/constants';

export { hashFile, sanitizeRelativePath, safeJoin } from './util/files';
export { formatBytes, formatDuration } from './util/speed';
