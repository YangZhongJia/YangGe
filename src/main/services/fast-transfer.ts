/**
 * High-speed transfer channel for YangGe.
 *
 * YangGe already has a working transfer stack (`services/files.ts`), so this
 * module does not replace it: it runs alongside as an *opt-in fast path* for
 * large files, selected per peer by capability.
 *
 * Why a second stack at all — measured, not assumed:
 *  - the legacy stack pulls whole files over one connection with no resume;
 *  - this one pulls 4 MiB ranges over N connections and keeps a bitmap, so an
 *    interrupted 20 GB copy continues instead of restarting.
 *
 * Boundaries that matter for correctness:
 *  - every path from the renderer must be consumed from a `PathGrantStore`,
 *    exactly like the legacy `file:offer` handler does;
 *  - a peer that does not advertise `lansend` is never sent to over this path;
 *  - if the listener cannot bind, `enabled` stays false and YangGe keeps
 *    working on the legacy stack.
 */

import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { createLanSend } from '../lansend/index'
import type { DiscoveredPeer, LanSend, TransferOffer, TransferSummary } from '../lansend/index'
import type { PeerView, TransferView } from '../../shared/ipc'

/** Capability tag written into the legacy peer profile so both stacks agree. */
export const FAST_CAP = 'lansend'

/** Default port; YangGe's legacy stack uses 17878/17879, so this cannot clash. */
const DEFAULT_PORT = 53318

export interface FastTransferOptions {
  /** YangGe's `userData` directory; identity + resume metadata live under it. */
  readonly userDataDir: string
  /** Where received files land. Follows the user's `fileDir` setting. */
  readonly downloadDir: string
  readonly alias: string
  /** Emits `transfer:updated`-shaped rows to the renderer. */
  readonly emitTransfer: (view: TransferView) => void
  /** Emits a peer list refresh. */
  readonly emitPeers: (peers: PeerView[]) => void
  /** Asks the renderer to confirm an inbound offer; resolves true to accept. */
  readonly confirmOffer: (offer: TransferOffer) => Promise<boolean>
  readonly onError?: (scope: string, error: Error) => void
}

export interface FastTransfer {
  readonly enabled: boolean
  readonly port: number
  readonly httpPort: number
  start(): Promise<void>
  stop(): Promise<void>
  /** True when this peer can be served by the fast path. */
  supports(peer: PeerView): boolean
  peers(): PeerView[]
  probe(host: string, port: number): Promise<PeerView | null>
  /** Sends paths that the caller already validated against `PathGrantStore`. */
  send(peerId: string, paths: string[], message?: string): Promise<string | null>
  cancel(transferId: string): boolean
  summary(transferId: string): TransferView | null
  list(): TransferView[]
}

export function createFastTransfer(options: FastTransferOptions): FastTransfer {
  let lan: LanSend | null = null
  let enabled = false
  const summaries = new Map<string, TransferSummary>()

  // YangGe's PeerView carries profile fields this stack does not know; the
  // renderer tolerates empty strings, so they are filled with '' rather than
  // inventing values that would show up as a fake company or remark.
  const toPeerView = (peer: DiscoveredPeer): PeerView => ({
    nodeId: peer.nodeId,
    nick: peer.alias,
    remark: '',
    company: '',
    dept: '',
    team: '',
    host: peer.deviceModel,
    avatar: -1,
    avatarHash: '',
    platform: normalizePlatform(peer.platform),
    ip: peer.host,
    online: true,
    lastSeen: peer.lastSeen,
    ver: peer.version,
    caps: [FAST_CAP],
  })

  /**
   * Projects a transfer onto YangGe's `TransferView`.
   *
   * The fields the renderer actually reads are filled; the ones tied to the
   * legacy protocol (msgId, convId, expiry, delivery receipt) get neutral
   * values, because a fast-path transfer is not part of a chat message and
   * has no expiry or receipt semantics.
   */
  const toTransferView = (summary: TransferSummary): TransferView => ({
    transferId: summary.transferId,
    msgId: '',
    convId: '',
    peerId: summary.peer.nodeId,
    peerName: summary.peer.alias,
    direction: summary.direction === 'send' ? 'out' : 'in',
    status: mapStatus(summary.state),
    bytesDone: summary.bytesTransferred,
    bytesTransferred: summary.bytesTransferred,
    totalSize: summary.totalBytes,
    fileCount: summary.files.length,
    name:
      summary.files.length === 1
        ? (summary.files[0]?.name ?? '')
        : `${summary.files[0]?.name ?? ''} 等 ${summary.files.length} 个文件`,
    expiresAt: 0,
    savedPath: summary.destination ?? '',
    direct: true,
    transport: 'fast',
    ...(summary.error !== null ? { failureReason: 'connection-error' as const, fastError: summary.error } : {}),
  })

  const service: FastTransfer = {
    get enabled(): boolean {
      return enabled
    },
    get port(): number {
      return lan?.port ?? 0
    },
    get httpPort(): number {
      return lan?.httpPort ?? 0
    },

    supports(peer) {
      return peer.caps?.includes(FAST_CAP) === true
    },

    peers(): PeerView[] {
      return (lan?.peers() ?? []).map(toPeerView)
    },

    async probe(host, port) {
      const peer = await lan?.addPeer(host, port)
      return peer ? toPeerView(peer) : null
    },

    async send(peerId, paths, message) {
      if (!enabled || lan === null) return null
      const instance = lan
      const peer = instance.peers().find((candidate) => candidate.nodeId === peerId)
      if (peer === undefined) return null
      return new Promise<string | null>((resolve) => {
        let settled = false
        const finish = (transferId: string | null): void => {
          if (settled) return
          settled = true
          resolve(transferId)
        }
        try {
          void instance.send({
            peer,
            paths,
            ...(message !== undefined ? { message } : {}),
            onStarted: finish
          }).then((summary) => {
            summaries.set(summary.transferId, summary)
            finish(summary.transferId)
          }).catch((error: unknown) => {
            options.onError?.('send', error as Error)
            finish(null)
          })
        } catch (error) {
          options.onError?.('send', error as Error)
          finish(null)
        }
      })
    },

    cancel(transferId) {
      return lan?.cancel(transferId) ?? false
    },

    summary(transferId) {
      const summary = summaries.get(transferId)
      return summary ? toTransferView(summary) : null
    },

    list() {
      return [...summaries.values()].map(toTransferView)
    },

    async start() {
      if (enabled) return
      const instance = createLanSend({
        dataDir: join(options.userDataDir, 'fast-transfer'),
        downloadDir: options.downloadDir,
        alias: options.alias,
        port: DEFAULT_PORT,
        // Direct probe by the current chat peer's IP is enough; do not open an
        // extra HTTP surface or join a second LAN discovery group.
        http: false,
        discovery: false,
        autoAccept: undefined,
      })

      try {
        await instance.start()
      } catch (error) {
        // Port taken or no permission: YangGe keeps working on the legacy stack.
        options.onError?.('start', error as Error)
        await instance.stop().catch(() => {})
        return
      }

      lan = instance
      enabled = true

      instance.on('peerFound', () => options.emitPeers(service.peers()))
      instance.on('peerLost', () => options.emitPeers(service.peers()))

      instance.on('offer', ({ offer, respond }) => {
        void (async () => {
          const accepted = await options.confirmOffer(offer).catch(() => false)
          respond(accepted ? { accepted: true } : { accepted: false, reason: 'declined' })
        })()
      })

      instance.on('progress', (progress) => {
        options.emitTransfer({
          transferId: progress.transferId,
          msgId: '',
          convId: '',
          peerId: progress.peer.nodeId,
          peerName: progress.peer.alias,
          direction: progress.direction === 'send' ? 'out' : 'in',
          status: 'accepted',
          bytesDone: progress.totalTransferred,
          bytesTransferred: progress.totalTransferred,
          totalSize: progress.totalBytes,
          fileCount: 1,
          name: progress.relativePath,
          expiresAt: 0,
          savedPath: '',
          direct: true,
          transport: 'fast'
        })
      })

      instance.on('transferCompleted', (summary) => {
        summaries.set(summary.transferId, summary)
        options.emitTransfer(toTransferView(summary))
      })
      instance.on('transferFailed', (summary) => {
        summaries.set(summary.transferId, summary)
        options.emitTransfer(toTransferView(summary))
      })
      instance.on('transferCancelled', (summary) => {
        summaries.set(summary.transferId, summary)
        options.emitTransfer(toTransferView(summary))
      })
      instance.on('error', ({ scope, error }) => options.onError?.(scope, error))
    },

    async stop() {
      enabled = false
      const instance = lan
      lan = null
      await instance?.stop().catch(() => {})
    },
  }

  return service
}

/** YangGe's platform vocabulary, so the renderer's icon mapping keeps working. */
function normalizePlatform(platform: string): PeerView['platform'] {
  switch (platform) {
    case 'win32':
      return 'win'
    case 'darwin':
      return 'mac'
    default:
      // YangGe only distinguishes three platforms; android/ios peers show as
      // linux rather than inventing a fourth icon the UI has no artwork for.
      return 'linux'
  }
}

/** Maps the transfer engine's states onto the statuses the renderer already renders. */
function mapStatus(state: TransferSummary['state']): TransferView['status'] {
  switch (state) {
    case 'pending':
      return 'offering'
    case 'accepted':
    case 'transferring':
      return 'accepted'
    case 'completed':
      return 'done'
    case 'cancelled':
      return 'canceled'
    case 'failed':
      return 'failed'
  }
}

/** Stable id for a transfer the renderer started, so it can be cancelled. */
export function newTransferId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 32)
}

/** Digest used to name resume metadata; exported for tests. */
export function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** YangGe's settings default, kept here so the module is usable outside Electron. */
export function defaultDownloadDir(): string {
  return join(app.getPath('downloads'), '阳鸽')
}
