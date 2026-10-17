import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DISCOVERY_PROBE_CAP,
  MSG_TYPES,
  type PeersPayload,
  type Profile,
  type ProfilePayload,
  type ScanRangeSummary,
  type Timings
} from '../../shared/protocol'
import { makeEnvelope } from './codec'
import { UdpChannel } from './udp'
import { PeerRegistry } from './peer-registry'
import { Discovery, type ManualPeer } from './discovery'
import { RangeSync } from './range-sync'

// 回环集成测试：两套完整网络栈在 127.0.0.1 对发。
// broadcastTargets 置空 —— 测试永不向真实局域网发包。

let nextPort = 41000 + Math.floor(Math.random() * 1000)

function makeProfile(name: string, port: number): Profile {
  return {
    nodeId: `node-${name}`,
    nick: name,
    company: '测试公司',
    dept: '测试部',
    team: '',
    avatar: -1,
    profileRev: 1,
    host: `${name}-host`,
    platform: 'linux',
    tcpPort: port + 1,
    ver: '0.0.0-test',
    caps: [DISCOVERY_PROBE_CAP]
  }
}

interface Stack {
  udp: UdpChannel
  registry: PeerRegistry
  discovery: Discovery
  rangeSync: RangeSync
  profile: Profile
  port: number
  scanRanges: ScanRangeSummary[]
  ignoredRanges: Set<string>
}

const FAST: Partial<Timings> = {
  presenceInterval: 100,
  offlineAfter: 400,
  sweepInterval: 50,
  entryReplyJitterBase: 1, // 测试中应答不抖动
  entryReplyJitterMax: 1,
  gossipInterval: 150,
  directedReplyInterval: 10,
  profileProbeInterval: 20,
  probeTimeout: 100,
  legacyProbeTimeout: 250,
  aliveDedupWindow: 100
}

const stacks: Stack[] = []

async function makeStack(name: string, manualPeers: ManualPeer[] = []): Promise<Stack> {
  nextPort += 2
  const port = nextPort
  const profile = makeProfile(name, port)
  const udp = new UdpChannel({ port, bindAddress: '127.0.0.1', broadcastTargets: [] })
  const registry = new PeerRegistry(profile.nodeId)
  const discovery = new Discovery({ udp, registry, profile, manualPeers, timings: FAST })
  const scanRanges: ScanRangeSummary[] = []
  const ignoredRanges = new Set<string>()
  const rangeSync = new RangeSync({
    udp,
    registry,
    selfId: profile.nodeId,
    getRanges: () => scanRanges,
    acceptRanges: (_from, ranges) => {
      for (const range of ranges) {
        if (ignoredRanges.has(range.cidr)) continue
        if (scanRanges.some((item) => item.cidr === range.cidr)) continue
        scanRanges.push(range)
      }
    },
    timings: {
      ...FAST,
      scanRangeShareInitialMin: 1,
      scanRangeShareInitialMax: 1,
      scanRangeShareInterval: 1_000
    }
  })
  await udp.start()
  const stack: Stack = { udp, registry, discovery, rangeSync, profile, port, scanRanges, ignoredRanges }
  stacks.push(stack)
  return stack
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(cond: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (cond()) return
    await sleep(25)
  }
  throw new Error('waitFor 超时')
}

afterEach(async () => {
  vi.useRealTimers()
  for (const stack of stacks.splice(0)) {
    stack.rangeSync.stop()
    stack.discovery.stop()
    await stack.udp.stop()
  }
})

describe('discovery scanHosts', () => {
  it('扫描大量地址时只保留一个活跃定时器并按间隔推进', () => {
    vi.useFakeTimers()
    const sent: Array<{ host: string; port: number }> = []
    const udp = {
      on: vi.fn(),
      send: vi.fn((_env: unknown, host: string, port: number) => {
        sent.push({ host, port })
      }),
      broadcast: vi.fn()
    }
    const profile = makeProfile('scanner', 47888)
    const discovery = new Discovery({
      udp: udp as unknown as UdpChannel,
      registry: new PeerRegistry(profile.nodeId),
      profile
    })
    const hosts = Array.from({ length: 100 }, (_item, index) => `127.0.0.${index + 1}`)

    expect(discovery.scanHosts(hosts, 17878, 8)).toBe(100)
    expect(vi.getTimerCount()).toBe(1)
    expect(sent).toHaveLength(0)

    vi.runOnlyPendingTimers()
    expect(sent.map((item) => item.host)).toEqual(['127.0.0.1'])
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(7)
    expect(sent).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(1)
    expect(sent.map((item) => item.host)).toEqual(['127.0.0.1', '127.0.0.2'])
    expect(vi.getTimerCount()).toBe(1)

    vi.runAllTimers()
    expect(sent).toHaveLength(100)
    expect(sent[99]).toEqual({ host: '127.0.0.100', port: 17878 })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('discovery 回环集成', () => {
  it.each([MSG_TYPES.entry, MSG_TYPES.alive, MSG_TYPES.profile])(
    '%s 收到同版本公司变更后立即通知资料投影，无需改名或发消息', async (type) => {
      const a = await makeStack('alice')
      const b = await makeStack('bob')
      b.discovery.probe('127.0.0.1', a.port)
      await waitFor(() => a.registry.onlineCount() === 1 && b.registry.onlineCount() === 1)
      let projected = { ...a.registry.get(b.profile.nodeId)!.profile }
      a.registry.on('updated', () => { projected = { ...a.registry.get(b.profile.nodeId)!.profile } })

      b.profile.company = '新公司'
      b.udp.send(makeEnvelope<ProfilePayload>(type, b.profile.nodeId, { profile: b.profile }), '127.0.0.1', a.port)
      await waitFor(() => projected.company === '新公司')
      expect(projected).toMatchObject({ nick: 'bob', company: '新公司', profileRev: 1 })
    }
  )

  it('手动节点互相发现，graceful 退出立刻离线', async () => {
    const a = await makeStack('alice')
    const b = await makeStack('bob', [{ host: '127.0.0.1', port: a.port }])

    a.discovery.start()
    b.discovery.start() // B 向 A 单播 entry → A 回 alive → 双向入表

    await waitFor(
      () =>
        a.registry.get(b.profile.nodeId)?.online === true &&
        b.registry.get(a.profile.nodeId)?.online === true
    )
    expect(a.registry.get(b.profile.nodeId)?.profile.nick).toBe('bob')
    expect(b.registry.get(a.profile.nodeId)?.profile.nick).toBe('alice')

    b.discovery.stop() // exit 单播 → A 立刻标灰，不等心跳超时
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === false)
  })

  it('异常掉线（不发 exit）靠心跳超时判离线', async () => {
    const a = await makeStack('alice')
    const b = await makeStack('bob', [{ host: '127.0.0.1', port: a.port }])
    a.discovery.start()
    b.discovery.start()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === true)

    await b.udp.stop() // 模拟崩溃/拔网线：没有 exit，心跳也停了

    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === false, 3000)
  })

  it('gossip：互不相识的两端经桥节点互见；投毒条目不入表', async () => {
    const bridge = await makeStack('bridge')
    const a = await makeStack('alice', [{ host: '127.0.0.1', port: bridge.port }])
    const c = await makeStack('carol', [{ host: '127.0.0.1', port: bridge.port }])
    bridge.discovery.start()
    a.discovery.start()
    c.discovery.start()

    // a、c 都只认识 bridge；"结识即交换"+周期 gossip 应让 a/c 互见（§6.3 三板斧之三）
    await waitFor(
      () =>
        a.registry.get(c.profile.nodeId)?.online === true &&
        c.registry.get(a.profile.nodeId)?.online === true,
      4000
    )
    expect(a.registry.get(c.profile.nodeId)?.profile.nick).toBe('carol')

    // 投毒：伪造 peers 报文塞一个不存在的节点 → a 只会发 entry 验证（无人应答），不得入表
    const evil = makeEnvelope<PeersPayload>(MSG_TYPES.peers, bridge.profile.nodeId, {
      peers: [
        { nodeId: 'node-ghost', ip: '127.0.0.1', udpPort: 9, tcpPort: 9, lastSeen: Date.now() }
      ]
    })
    bridge.udp.send(evil, '127.0.0.1', a.port)
    await sleep(400)
    expect(a.registry.get('node-ghost')).toBeUndefined()
  })

  it('资料变更后，presence 版本失配触发自动刷新（防机器换人）', async () => {
    const a = await makeStack('alice')
    const b = await makeStack('bob', [{ host: '127.0.0.1', port: a.port }])
    a.discovery.start()
    b.discovery.start()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === true)

    // B 改名 + 资料版本号 +1（Discovery 持有 profile 引用，原地修改即生效）
    b.profile.nick = 'bob-换了个人'
    b.profile.profileRev = 2

    // A 在下个心跳发现 rev 失配 → 发 entry → B 回 alive 带新资料
    await waitFor(() => a.registry.get(b.profile.nodeId)?.profile.nick === 'bob-换了个人', 3000)
    expect(a.registry.get(b.profile.nodeId)?.profile.profileRev).toBe(2)
  })

  it('已在线节点不接受不同 UDP 源地址的伪造重绑定', async () => {
    const a = await makeStack('alice')
    const b = await makeStack('bob', [{ host: '127.0.0.1', port: a.port }])
    const evil = await makeStack('evil')
    a.discovery.start()
    b.discovery.start()
    await waitFor(() => a.registry.get(b.profile.nodeId)?.online === true)
    const before = a.registry.get(b.profile.nodeId)

    evil.udp.send(
      makeEnvelope<ProfilePayload>(MSG_TYPES.entry, b.profile.nodeId, {
        profile: { ...b.profile, nick: '伪造 bob', profileRev: b.profile.profileRev + 1 }
      }),
      '127.0.0.1',
      a.port
    )
    await sleep(100)

    const after = a.registry.get(b.profile.nodeId)
    expect(after?.udpPort).toBe(before?.udpPort)
    expect(after?.profile.nick).toBe('bob')
  })

  it('scan-ranges：在线节点低频同步网段记录，用户忽略后不自动加回', async () => {
    const a = await makeStack('alice')
    const b = await makeStack('bob', [{ host: '127.0.0.1', port: a.port }])
    a.scanRanges.push({ cidr: '10.1.2.0/24', addedAt: Date.now() })
    a.discovery.start()
    b.discovery.start()
    a.rangeSync.start()
    b.rangeSync.start()

    await waitFor(() => b.registry.get(a.profile.nodeId)?.online === true)
    a.rangeSync.shareNow()
    await waitFor(() => b.scanRanges.some((item) => item.cidr === '10.1.2.0/24'))

    b.scanRanges.splice(0, b.scanRanges.length)
    b.ignoredRanges.add('10.1.2.0/24')
    a.rangeSync.shareNow()
    await sleep(100)
    expect(b.scanRanges).toEqual([])
  })
})


it('回环：首次上线包缺失后仅凭心跳重新握手，关联应答确认同毫秒冲突', async () => {
  const a = await makeStack('alice'), b = await makeStack('bob')
  b.udp.send(makeEnvelope(MSG_TYPES.presence, b.profile.nodeId, { seq: 1, profileRev: 1 }), '127.0.0.1', a.port)
  await waitFor(() => !!a.registry.get(b.profile.nodeId) && !!b.registry.get(a.profile.nodeId))
  const timestamp = Date.now()
  b.profile.company = '已更新公司'
  b.udp.send({ ...makeEnvelope(MSG_TYPES.profile, b.profile.nodeId, { profile: b.profile }), ts: timestamp }, '127.0.0.1', a.port)
  await waitFor(() => a.registry.get(b.profile.nodeId)?.profile.company === '已更新公司')
  b.udp.send({ ...makeEnvelope(MSG_TYPES.profile, b.profile.nodeId, { profile: { ...b.profile, company: '延迟旧公司' } }), ts: timestamp }, '127.0.0.1', a.port)
  await sleep(60)
  expect(a.registry.get(b.profile.nodeId)?.profile.company).toBe('已更新公司')
  // 资料版本相同且发送时钟回拨，重新握手应确认当前公司。
  b.profile.company = '回拨后当前公司'
  b.udp.send({ ...makeEnvelope(MSG_TYPES.profile, b.profile.nodeId, { profile: b.profile }), ts: timestamp - 5000 }, '127.0.0.1', a.port)
  await waitFor(() => a.registry.get(b.profile.nodeId)?.profile.company === '回拨后当前公司')
})

it('回环：快速探活绕过普通发现去重，断开后按探活期限转离线', async () => {
  const a = await makeStack('alice'), b = await makeStack('bob')
  a.discovery.probe('127.0.0.1', b.port)
  await waitFor(() => !!a.registry.get(b.profile.nodeId))
  a.discovery.probeNode(b.profile.nodeId)
  await sleep(120)
  expect(a.registry.get(b.profile.nodeId)?.online).toBe(true)
  await b.udp.stop()
  a.discovery.probeNode(b.profile.nodeId)
  await waitFor(() => a.registry.get(b.profile.nodeId)?.online === false)
})

it('回环：排队的两轮扫描均送达，gossip 多包按间隔发送', async () => {
  const a = await makeStack('alice'), b = await makeStack('bob')
  const received: number[] = [], gossipTimes: number[] = []
  b.udp.on('envelope', env => {
    if (env.type === MSG_TYPES.entry) received.push(Date.now())
    if (env.type === MSG_TYPES.peers) gossipTimes.push(Date.now())
  })
  a.discovery.scanHosts(['127.0.0.1', '127.0.0.1'], b.port, 20)
  a.discovery.scanHosts(['127.0.0.1'], b.port)
  await waitFor(() => received.length === 3)
  const records = Array.from({ length: 24 }, (_, i) => ({
    profile: makeProfile(`extra-${i}`, 1000), ip: '127.0.0.1', udpPort: 9, online: false, lastSeen: Date.now()
  }))
  a.registry.seed(records)
  for (const record of a.registry.values()) record.online = true
  Reflect.get(a.discovery, 'sendPeersTo').call(a.discovery, b.profile.nodeId)
  await waitFor(() => gossipTimes.length === 3)
  expect(gossipTimes[2] - gossipTimes[0]).toBeGreaterThanOrEqual(80)
})

it('回环：旧客户端忽略关联字段且延迟应答，超过新端 2s 比例窗口仍保留在线', async () => {
  const a = await makeStack('alice'), b = await makeStack('bob')
  b.profile.caps = []
  a.registry.touch(b.profile.nodeId, '127.0.0.1', b.port, b.profile)
  const originalSend = b.udp.send.bind(b.udp)
  const delayed: Array<ReturnType<typeof setTimeout>> = []
  const legacy = vi.spyOn(b.udp, 'send').mockImplementation((env, host, port) => {
    if (env.type !== MSG_TYPES.alive) return originalSend(env, host, port)
    // 用比例缩短后的 150ms 模拟旧端正常发现抖动；旧端回包没有 probeId。
    delayed.push(setTimeout(() => originalSend(makeEnvelope(MSG_TYPES.alive, b.profile.nodeId,
      { profile: b.profile }), host, port), 150))
  })
  try {
    a.discovery.probeNode(b.profile.nodeId)
    await sleep(120)
    expect(a.registry.get(b.profile.nodeId)?.online).toBe(true)
    await sleep(180)
    expect(a.registry.get(b.profile.nodeId)?.online).toBe(true)
  } finally {
    legacy.mockRestore()
    delayed.forEach(clearTimeout)
  }
})
