/** Public surface of the transfer data plane. */

export { ChunkBitmap } from './bitmap';
export { ResumeStore } from './resume';
export type { ResumeFileState, ResumeState, ResumeWarn } from './resume';
export { TransferSender } from './sender';
export type { SenderFileSource, ServedRange, TransferSenderOptions } from './sender';
export type { DuplexLike } from './types';
