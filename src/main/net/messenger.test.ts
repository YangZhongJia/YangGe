import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAPS,
  MSG_TYPES,
  UDP_MAX_PAYLOAD,
  type AckPayload,
  type Envelope,
  type MsgPayload,
  type Profile,
  type SharePayload,
  type Timings,
  type UpdateReqPayload
} from '../../shared/protocol'
import { makeEnvelope } from './codec'
import { UdpChannel } from './udp'
import { PeerRegistry } from './peer-registry'
import { Discovery } from './discovery'
import { Messenger, type DedupStore, type QueueStore } from './messenger'
import { TransferServer } from './transfer'
import type { GroupRepo } from '../store/group-repo'
import { AvatarStore, avatarHashOf } from '../services/avatar-store'
import { AvatarService } from '../services/avatars'

// 消息层回环集成：两套完整栈（udp+registry+discovery+messenger）在 127.0.0.1 对发。
// 存储用内存实现 —— vitest 不碰 native 模块；SQLite 实现由 npm run test:db 验证。

class MemQueue implements QueueStore {
  items: Array<{ msgId: string; peerId: string; envelopeJson: string; created: number }> = []
  enqueue(msgId: string, peerId: string, envelopeJson: string, created: number): void {
    this.items = this.items.filter((i) => i.msgId !== msgId)
    this.items.push({ msgId, peerId, envelopeJson, created })
  }
  listByPeer(peerId: string): Array<{ msgId: string; envelopeJson: string }> {
    return this.items
      .filter((i) => i.peerId === peerId)
      .sort((a, b) => a.created - b.created)
      .map((i) => ({ msgId: i.msgId, envelopeJson: i.envelopeJson }))
  }
  remove(msgId: string, peerId: string): void {
    this.items = this.items.filter((i) => !(i.msgId === msgId && i.peerId === peerId))
  }
  prune(ttlMs: number, maxPerPeer: number): Array<{ msgId: string; peerId: string }> {
    const cutoff = Date.now() - ttlMs
    const pruned = this.items
      .filter((i) => i.created < cutoff)
      .map((i) => ({ msgId: i.msgId, peerId: i.peerId }))
    this.items = this.items.filter((i) => i.created >= cutoff)
    void maxPerPeer
    return pruned
  }
}

class MemDedup implements DedupStore {
  private readonly seen = new Map<string, number>()
  has(msgId: string): boolean {
    return this.seen.has(msgId)
  }
  add(msgId: string, recvTs: number): void {
    this.seen.set(msgId, recvTs)
  }
  prune(ttlMs: number): void {
    const cutoff = Date.now() - ttlMs
    for (const [id, ts] of this.seen) if (ts < cutoff) this.seen.delete(id)
  }
}

class ClosedQueue implements QueueStore {
  enqueue(): void {
    throw new Error('The database connection is not open')
  }
  listByPeer(): Array<{ msgId: string; envelopeJson: string }> {
    throw new Error('The database connection is not open')
  }
  remove(): void {
    throw new Error('The database connection is not open')
  }
  prune(): Array<{ msgId: string; peerId: string }> {
    throw new Error('The database connection is not open')
  }
}

let nextPort = 43000 + Math.floor(Math.random() * 1000)

const FAST: Partial<Timings> = {
  presenceInterval: 100,
  offlineAfter: 400,
  sweepInterval: 50,
  entryReplyJitterBase: 1,
  entryReplyJitterMax: 1,
  ackRetrySchedule: [60, 120, 180]
}

function makeProfile(name: string, port: number): Profile {
  return {
    nodeId: `node-${name}`,
    nick: name,
    company: '',
    dept: '',
    team: '',
    avatar: -1,
    profileRev: 1,
    host: `${name}-host`,
    platform: 'linux',
    tcpPort: port + 1,
    ver: '0.0.0-test',
    caps: []
  }
}

interface Stack {
  udp: UdpChannel
  registry: PeerRegistry
  discovery: Discovery
  messenger: Messenger
  queue: MemQueue
  dedup: MemDedup
  profile: Profile
  port: number
  incoming: Envelope[]
}

const stacks: Stack[] = []
const tcpServers: TransferServer[] = []

async function makeStack(
  name: string,
  port: number,
  manualPeers: Array<{ host: string; port: number }> = []
): Promise<Stack> {
  const profile = makeProfile(name, port)
  const udp = new UdpChannel({ port, bindAddress: '127.0.0.1', broadcastTargets: [] })
  const registry = new PeerRegistry(profile.nodeId)
  const discovery = new Discovery({ udp, registry, profile, manualPeers, timings: FAST })
  const queue = new MemQueue()
  const dedup = new MemDedup()
  const messenger = new Messenger({
    udp,
    registry,
    selfId: profile.nodeId,
    queue,
    dedup,
    timings: FAST
  })
  const incoming: Envelope[] = []
  messenger.on('incoming', (env: Envelope) => incoming.push(env))
  await udp.start()
  const stack: Stack = { udp, registry, discovery, messenger, queue, dedup, profile, port, incoming }
  stacks.push(stack)
  return stack
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(cond: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (cond()) return
    await sleep(25)
  }
  throw new Error('waitFor 超时')
}

afterEach(async () => {
  for (const server of tcpServers.splice(0)) await server.stop()
  for (const stack of stacks.splice(0)) {
    stack.discovery.stop()
    await stack.udp.stop()
  }
})

async function startTcpReceiver(stack: Stack): Promise<void> {
  const server = new TransferServer(
    stack.profile.tcpPort,
    {
      resolve: () => null,
      receiveMessage: (env, ip) => stack.messenger.acceptTcpEnvelope(env, ip)
    },
    '127.0.0.1'
  )
  tcpServers.push(server)
  await server.start()
}

function textEnv(from: string, text: string): Envelope<MsgPayload> {
  return makeEnvelope<MsgPayload>(MSG_TYPES.msg, from, { kind: 'text', text })
}

function avatarWebp(size = 2048): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set(Buffer.from('RIFF'), 0)
  new DataView(bytes.buffer).setUint32(4, size - 8, true)
  bytes.set(Buffer.from('WEBP'), 8)
  bytes.set(Buffer.from('VP8 '), 12)
  new DataView(bytes.buffer).setUint32(16, size - 20, true)
  bytes[23] = 0x9d
  bytes[24] = 0x01
  bytes[25] = 0x2a
  bytes[26] = 192
  bytes[28] = 192
  return bytes
}

const emptyGroups = {
  get: () => undefined,
  list: () => []
} as unknown as GroupRepo

describe('messenger 回环集成', () => {
  it('屏幕控制跨 UDP/TCP 仅内存去重，错误来源不能抢占消息 ID 或修改联系人地址', async () => {
    nextPort += 20
    const a = await makeStack('alice', nextPort)
    const b = await makeStack('bob', nextPort + 5)
    a.registry.touch(b.profile.nodeId, '127.0.0.1', b.port, b.profile)
    b.registry.touch(a.profile.nodeId, '127.0.0.1', a.port, a.profile)
    const env = makeEnvelope(MSG_TYPES.screen, a.profile.nodeId, { op: 'request', sessionId: randomUUID() })
    expect(b.messenger.acceptTcpEnvelope(env, '127.0.0.2')).toBe(false)
    expect(b.messenger.acceptTcpEnvelope(env)).toBe(false)
    expect(b.registry.get(a.profile.nodeId)?.ip).toBe('127.0.0.1')
    await expect(a.messenger.sendReliable(b.profile.nodeId, env)).resolves.toBe(true)
    expect(b.messenger.acceptTcpEnvelope(env, '::ffff:127.0.0.1')).toBe(true)
    expect(b.incoming).toHaveLength(1)
    expect(b.dedup.has(env.id)).toBe(false)
    expect(a.queue.items).toEqual([])
    expect(b.queue.items).toEqual([])
    const unknown = makeEnvelope(MSG_TYPES.screen, 'unknown', { op: 'request', sessionId: randomUUID() })
    a.udp.send(unknown, '127.0.0.1', b.port)
    await sleep(40)
    expect(b.incoming).toHaveLength(1)
    expect(b.registry.get('unknown')).toBeUndefined()
  })

  it('取消屏幕邀请立即清除重试且不把在线联系人标成离线', async () => {
    nextPort += 20
    const a = await makeStack('alice', nextPort)
    const b = await makeStack('bob', nextPort + 5)
    a.registry.touch(b.profile.nodeId, '127.0.0.1', b.port, b.profile)
    const send = vi.spyOn(a.udp, 'sendBuffer')
    const abort = new AbortController()
    const env = makeEnvelope(MSG_TYPES.screen, a.profile.nodeId, { op: 'request', sessionId: randomUUID() })
    const pending = a.messenger.sendReliable(b.profile.nodeId, env, abort.signal)
    abort.abort()
    await expect(pending).resolves.toBe(false)
    const count = send.mock.calls.length
    await sleep(220)
    expect(send).toHaveBeenCalledTimes(count)
    expect(a.registry.get(b.profile.nodeId)?.online).toBe(true)
    expect(a.queue.items).toEqual([])
    await expect(a.messenger.sendReliable(b.profile.nodeId, env, abort.signal)).resolves.toBe(false)
    expect(send).toHaveBeenCalledTimes(count)
  })

  it('在线直达：ACK 确认，sendUserMessage 返回 sent', async () => {
    nextPort += 2
    const a = await makeStack('alice', nextPort)
    const b = await makeStack('bob', nextPort + 1, [{ host: '127.0.0.1', port: a.port }])
    a.discovery.start()
    b.discovery.start()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === true)

    const outcome = await a.messenger.sendUserMessage(
      b.profile.nodeId,
      textEnv(a.profile.nodeId, '你好，鲍勃')
    )
    expect(outcome).toBe('sent')
    expect(b.incoming).toHaveLength(1)
    const payload = b.incoming[0].payload as MsgPayload
    expect(payload.kind).toBe('text')
    if (payload.kind === 'text') expect(payload.text).toBe('你好，鲍勃')
    expect(a.queue.items).toHaveLength(0)
  })

  it('UDP ACK 必须来自本轮发送目标地址', async () => {
    nextPort += 20
    const a = await makeStack('alice', nextPort)
    const evil = await makeStack('evil', nextPort + 5)
    const peer = makeProfile('bob', nextPort + 9)
    a.registry.touch(peer.nodeId, '127.0.0.1', nextPort + 9, peer)

    const env = textEnv(a.profile.nodeId, '需要真实 ACK')
    const sending = a.messenger.sendReliable(peer.nodeId, env)
    await sleep(10)
    evil.udp.send(
      makeEnvelope<AckPayload>(MSG_TYPES.ack, peer.nodeId, { ackFor: env.id }),
      '127.0.0.1',
      a.port
    )

    await expect(sending).resolves.toBe(false)
  })

  it('超长文本通过 TCP 控制帧直达', async () => {
    nextPort += 20
    const a = await makeStack('alice', nextPort)
    const b = await makeStack('bob', nextPort + 5, [{ host: '127.0.0.1', port: a.port }])
    await startTcpReceiver(b)
    a.discovery.start()
    b.discovery.start()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === true)

    const longText = '这是一段超长文本'.repeat(150)
    const outcome = await a.messenger.sendUserMessage(
      b.profile.nodeId,
      textEnv(a.profile.nodeId, longText)
    )
    expect(outcome).toBe('sent')
    expect(b.incoming).toHaveLength(1)
    const payload = b.incoming[0].payload as MsgPayload
    expect(payload.kind).toBe('text')
    if (payload.kind === 'text') expect(payload.text).toBe(longText)
    expect(a.queue.items).toHaveLength(0)
  })

  it('共享文件柜列表超过 UDP 上限时经 TCP 控制帧直达（§8.2）', async () => {
    nextPort += 20
    const a = await makeStack('alice', nextPort)
    const b = await makeStack('bob', nextPort + 5, [{ host: '127.0.0.1', port: a.port }])
    await startTcpReceiver(b)
    a.discovery.start()
    b.discovery.start()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === true)

    // 200 条中文文件名远超 1200B 单包上限，必须走 TCP 兜底而不是被丢掉
    const entries = Array.from({ length: 200 }, (_, i) => ({
      name: `第${i}份设计稿最终版.psd`,
      size: 1024 * i,
      isDir: false,
      mtime: 1_780_000_000_000 + i
    }))
    const payload: SharePayload = {
      op: 'list-ok',
      reqId: 'req-1',
      path: '设计稿',
      perm: 'read',
      snapshotId: 'snap-1',
      offset: 0,
      total: entries.length,
      truncated: false,
      entries
    }
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeGreaterThan(UDP_MAX_PAYLOAD)

    const acked = await a.messenger.sendReliable(
      b.profile.nodeId,
      makeEnvelope<SharePayload>(MSG_TYPES.share, a.profile.nodeId, payload)
    )
    expect(acked).toBe(true)
    expect(b.incoming).toHaveLength(1)
    expect(b.incoming[0].type).toBe(MSG_TYPES.share)
    const got = b.incoming[0].payload as SharePayload
    expect(got.op).toBe('list-ok')
    if (got.op === 'list-ok') {
      expect(got.entries).toHaveLength(200)
      expect(got.entries[199].name).toBe('第199份设计稿最终版.psd')
    }
  })

  it('短文本 UDP 无 ACK 时自动降级为 TCP 控制帧', async () => {
    nextPort += 20
    const a = await makeStack('alice', nextPort)
    const peer = makeProfile('bob', nextPort + 8)
    const incoming: Envelope[] = []
    const server = new TransferServer(
      peer.tcpPort,
      {
        resolve: () => null,
        receiveMessage: (env) => {
          incoming.push(env)
          return true
        }
      },
      '127.0.0.1'
    )
    tcpServers.push(server)
    await server.start()
    a.registry.touch(peer.nodeId, '127.0.0.1', nextPort + 8, peer)

    const outcome = await a.messenger.sendUserMessage(
      peer.nodeId,
      textEnv(a.profile.nodeId, 'UOS UDP 兜底')
    )

    expect(outcome).toBe('sent')
    expect(incoming).toHaveLength(1)
    const payload = incoming[0].payload as MsgPayload
    expect(payload.kind).toBe('text')
    if (payload.kind === 'text') expect(payload.text).toBe('UOS UDP 兜底')
    expect(a.queue.items).toHaveLength(0)
  })

  it('重复消息：只入账一次，但每次都回 ACK', async () => {
    nextPort += 2
    const a = await makeStack('alice', nextPort)
    const b = await makeStack('bob', nextPort + 1, [{ host: '127.0.0.1', port: a.port }])
    a.discovery.start()
    b.discovery.start()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === true)

    const env = textEnv(a.profile.nodeId, '只该看到一次')
    const first = await a.messenger.sendUserMessage(b.profile.nodeId, env)
    expect(first).toBe('sent')
    // 模拟网络重复/补发重放：同 id 再发，对端应只入账一次且仍回 ACK
    const again = await a.messenger.sendUserMessage(b.profile.nodeId, env)
    expect(again).toBe('sent')
    expect(b.incoming).toHaveLength(1)
  })

  it('群扇出：同一信封并发发给两个成员，互不串线（等待表复合键）', async () => {
    nextPort += 4
    const a = await makeStack('alice', nextPort)
    const b = await makeStack('bob', nextPort + 1, [{ host: '127.0.0.1', port: a.port }])
    const c = await makeStack('carol', nextPort + 2, [{ host: '127.0.0.1', port: a.port }])
    a.discovery.start()
    b.discovery.start()
    c.discovery.start()
    await waitFor(
      () =>
        a.registry.get(b.profile.nodeId)?.online === true &&
        a.registry.get(c.profile.nodeId)?.online === true
    )

    const env = makeEnvelope<MsgPayload>(MSG_TYPES.msg, a.profile.nodeId, {
      kind: 'group-text',
      text: '群里好',
      groupId: 'g-test',
      groupRev: 1
    })
    const [r1, r2] = await Promise.all([
      a.messenger.sendUserMessage(b.profile.nodeId, env),
      a.messenger.sendUserMessage(c.profile.nodeId, env)
    ])
    expect(r1).toBe('sent')
    expect(r2).toBe('sent')
    expect(b.incoming).toHaveLength(1)
    expect(c.incoming).toHaveLength(1)
    expect(a.queue.items).toHaveLength(0)
  })

  it('update 请求走可靠控制报文 ACK 并投递', async () => {
    nextPort += 2
    const a = await makeStack('alice', nextPort)
    const b = await makeStack('bob', nextPort + 1, [{ host: '127.0.0.1', port: a.port }])
    a.discovery.start()
    b.discovery.start()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === true)

    const ok = await a.messenger.sendReliable(
      b.profile.nodeId,
      makeEnvelope<UpdateReqPayload>(MSG_TYPES.update, a.profile.nodeId, {
        op: 'req',
        platform: 'linux'
      })
    )

    expect(ok).toBe(true)
    expect(b.incoming).toHaveLength(1)
    expect(b.incoming[0]).toMatchObject({
      type: MSG_TYPES.update,
      payload: { op: 'req', platform: 'linux' }
    })
  })

  it('联系人头像通过 127.0.0.1 可靠请求并以 TCP 数据响应落入对端缓存', async () => {
    nextPort += 20
    const sourceRoot = await mkdtemp(join(tmpdir(), 'pantry-avatar-loop-source-'))
    const targetRoot = await mkdtemp(join(tmpdir(), 'pantry-avatar-loop-target-'))
    try {
      const a = await makeStack('avatar-source', nextPort)
      const b = await makeStack('avatar-target', nextPort + 5, [
        { host: '127.0.0.1', port: a.port }
      ])
      const bytes = avatarWebp()
      const hash = avatarHashOf(bytes)
      a.profile.avatarHash = hash
      a.profile.caps = [CAPS.avatarImages]
      b.profile.caps = [CAPS.avatarImages]
      const sourceStore = new AvatarStore(sourceRoot)
      const targetStore = new AvatarStore(targetRoot)
      expect(await sourceStore.import(hash, bytes)).toBe(true)

      await startTcpReceiver(a)
      await startTcpReceiver(b)
      new AvatarService({
        selfId: a.profile.nodeId,
        messenger: a.messenger,
        registry: a.registry,
        groupRepo: emptyGroups,
        store: sourceStore,
        getSelfProfile: () => a.profile
      })
      const targetAvatars = new AvatarService({
        selfId: b.profile.nodeId,
        messenger: b.messenger,
        registry: b.registry,
        groupRepo: emptyGroups,
        store: targetStore,
        getSelfProfile: () => b.profile
      })
      const ready = new Promise<string>((resolve) => targetAvatars.once('ready', resolve))

      a.discovery.start()
      b.discovery.start()

      await expect(ready).resolves.toBe(hash)
      expect(await targetStore.read(hash)).toEqual(Buffer.from(bytes))
    } finally {
      await rm(sourceRoot, { recursive: true, force: true })
      await rm(targetRoot, { recursive: true, force: true })
    }
  })

  it('来源缓存缺失时经 UDP 单发 miss 提示，请求方完整收到（决议 #249）', async () => {
    nextPort += 30
    const sourceRoot = await mkdtemp(join(tmpdir(), 'pantry-avatar-miss-source-'))
    const targetRoot = await mkdtemp(join(tmpdir(), 'pantry-avatar-miss-target-'))
    try {
      const a = await makeStack('miss-source', nextPort)
      const b = await makeStack('miss-target', nextPort + 5, [
        { host: '127.0.0.1', port: a.port }
      ])
      const bytes = avatarWebp()
      const hash = avatarHashOf(bytes)
      a.profile.avatarHash = hash // 声明了哈希但受管缓存里没有文件
      a.profile.caps = [CAPS.avatarImages]
      b.profile.caps = [CAPS.avatarImages]

      await startTcpReceiver(a)
      await startTcpReceiver(b)
      new AvatarService({
        selfId: a.profile.nodeId,
        messenger: a.messenger,
        registry: a.registry,
        groupRepo: emptyGroups,
        store: new AvatarStore(sourceRoot),
        getSelfProfile: () => a.profile
      })
      new AvatarService({
        selfId: b.profile.nodeId,
        messenger: b.messenger,
        registry: b.registry,
        groupRepo: emptyGroups,
        store: new AvatarStore(targetRoot),
        getSelfProfile: () => b.profile
      })

      a.discovery.start()
      b.discovery.start()

      await waitFor(() =>
        b.incoming.some(
          (env) =>
            env.type === MSG_TYPES.avatar &&
            (env.payload as { op?: string; hash?: string }).op === 'miss' &&
            (env.payload as { hash?: string }).hash === hash
        )
      )
    } finally {
      await rm(sourceRoot, { recursive: true, force: true })
      await rm(targetRoot, { recursive: true, force: true })
    }
  })

  it('离线入队 → 对方上线自动补发（含跨"重启"）', async () => {
    nextPort += 4
    const a = await makeStack('alice', nextPort)
    const b = await makeStack('bob', nextPort + 1, [{ host: '127.0.0.1', port: a.port }])
    a.discovery.start()
    b.discovery.start()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === true)

    // B 突然消失（不发 exit）
    b.discovery.stop()
    await b.udp.stop()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === false)

    const outcome = await a.messenger.sendUserMessage(
      b.profile.nodeId,
      textEnv(a.profile.nodeId, '你不在的时候发的')
    )
    expect(outcome).toBe('queued')
    expect(a.queue.items).toHaveLength(1)

    // B "重启"：同身份新栈、同端口
    const b2 = await makeStack('bob', b.port, [{ host: '127.0.0.1', port: a.port }])
    const sentStatuses: string[] = []
    a.messenger.on('status', (_id: string, status: string) => sentStatuses.push(status))
    b2.discovery.start() // entry → A 的 registry 翻在线 → 补发发车

    await waitFor(() => b2.incoming.length === 1)
    const payload = b2.incoming[0].payload as MsgPayload
    expect(payload.kind).toBe('text')
    if (payload.kind === 'text') expect(payload.text).toBe('你不在的时候发的')
    expect((b2.incoming[0].payload as { resend?: boolean }).resend).toBe(true)
    await waitFor(() => a.queue.items.length === 0)
    expect(sentStatuses).toContain('sent')
  })

  it('撤回发送中的消息会取消后续入队，避免原文离线补发', async () => {
    nextPort += 2
    const a = await makeStack('alice', nextPort)
    const env = textEnv(a.profile.nodeId, '这条会立刻撤回')

    const sending = a.messenger.sendUserMessage('node-missing', env)
    a.messenger.dropQueuedMessage(env.id, ['node-missing'])

    await expect(sending).resolves.toBe('queued')
    expect(a.queue.items).toHaveLength(0)
  })

  it('未知收件人快速入队，不等待 ACK 重试窗口', async () => {
    nextPort += 2
    const a = await makeStack('alice', nextPort)
    const env = textEnv(a.profile.nodeId, '从未见过的群成员')

    const outcome = await Promise.race([
      a.messenger.sendUserMessage('node-never-seen', env),
      sleep(50).then(() => 'timeout' as const)
    ])

    expect(outcome).toBe('queued')
    expect(a.queue.items).toHaveLength(1)
  })

  it('撤回非发送或补发中的消息不留下取消键', () => {
    nextPort += 2
    const udp = new UdpChannel({ port: nextPort, bindAddress: '127.0.0.1', broadcastTargets: [] })
    const messenger = new Messenger({
      udp,
      registry: new PeerRegistry('node-alice'),
      selfId: 'node-alice',
      queue: new MemQueue(),
      dedup: new MemDedup(),
      timings: FAST
    })

    messenger.dropQueuedMessage('msg-already-settled', ['node-bob'])

    const internals = messenger as unknown as { cancelledQueued: Set<string> }
    expect(internals.cancelledQueued.size).toBe(0)
  })

  it('退出期数据库已关闭时忽略晚到的补发触发', async () => {
    nextPort += 2
    const udp = new UdpChannel({ port: nextPort, bindAddress: '127.0.0.1', broadcastTargets: [] })
    const registry = new PeerRegistry('node-alice')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    new Messenger({
      udp,
      registry,
      selfId: 'node-alice',
      queue: new ClosedQueue(),
      dedup: new MemDedup(),
      timings: FAST
    })

    registry.touch('node-bob', '127.0.0.1', nextPort + 1, makeProfile('bob', nextPort + 1))
    await sleep(0)

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
