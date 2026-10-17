import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MSG_TYPES,
  type Envelope,
  type Profile,
  type ScanRangeSummary,
  type ScanRangesPayload
} from '../../shared/protocol'
import { makeEnvelope } from './codec'
import { PeerRegistry } from './peer-registry'
import { RangeSync } from './range-sync'
import { UdpChannel } from './udp'

let nextPort = 43000 + Math.floor(Math.random() * 1000)

interface RangeNode {
  udp: UdpChannel
  registry: PeerRegistry
  rangeSync: RangeSync
  profile: Profile
  port: number
  ranges: ScanRangeSummary[]
  accepted: Array<{ from: string; ranges: ScanRangeSummary[] }>
}

type FakeUdp = EventEmitter & {
  send: ReturnType<typeof vi.fn>
}

const nodes: RangeNode[] = []

function profile(name: string, port: number): Profile {
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
    caps: []
  }
}

function fakeUdp(): FakeUdp {
  const udp = new EventEmitter() as FakeUdp
  udp.send = vi.fn()
  return udp
}

async function makeNode(name: string): Promise<RangeNode> {
  nextPort += 2
  const port = nextPort
  const nodeProfile = profile(name, port)
  const udp = new UdpChannel({ port, bindAddress: '127.0.0.1', broadcastTargets: [] })
  const registry = new PeerRegistry(nodeProfile.nodeId)
  const ranges: ScanRangeSummary[] = []
  const accepted: Array<{ from: string; ranges: ScanRangeSummary[] }> = []
  const rangeSync = new RangeSync({
    udp,
    registry,
    selfId: nodeProfile.nodeId,
    getRanges: () => ranges,
    acceptRanges: (from, received) => {
      accepted.push({ from, ranges: received })
    },
    timings: {
      scanRangeShareInitialMin: 1,
      scanRangeShareInitialMax: 1,
      scanRangeShareInterval: 1_000
    }
  })
  await udp.start()
  const node = { udp, registry, rangeSync, profile: nodeProfile, port, ranges, accepted }
  nodes.push(node)
  return node
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(cond: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (cond()) return
    await sleep(20)
  }
  throw new Error('waitFor 超时')
}

afterEach(async () => {
  vi.useRealTimers()
  for (const node of nodes.splice(0)) {
    node.rangeSync.stop()
    await node.udp.stop()
  }
})

describe('RangeSync 定时分享', () => {
  it('节点上线后延迟向该节点分享当前网段', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const udp = fakeUdp()
    const registry = new PeerRegistry('node-alice')
    const rangeSync = new RangeSync({
      udp: udp as unknown as UdpChannel,
      registry,
      selfId: 'node-alice',
      getRanges: () => [{ cidr: '10.1.2.0/24', addedAt: 1 }],
      acceptRanges: vi.fn(),
      timings: {
        scanRangeShareInitialMin: 5,
        scanRangeShareInitialMax: 5,
        scanRangeShareInterval: 1_000
      }
    })

    registry.touch('node-bob', '127.0.0.1', 17878, profile('bob', 17878))

    expect(udp.send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(4)
    expect(udp.send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(udp.send).toHaveBeenCalledTimes(1)
    const [env, ip, port] = udp.send.mock.calls[0] as [Envelope<ScanRangesPayload>, string, number]
    expect(ip).toBe('127.0.0.1')
    expect(port).toBe(17878)
    expect(env.type).toBe(MSG_TYPES.scanRanges)
    expect(env.from).toBe('node-alice')
    expect(env.payload.ranges).toEqual([{ cidr: '10.1.2.0/24', addedAt: 1 }])

    rangeSync.stop()
  })

  it('stop 清理初始、周期与单节点分享定时器', () => {
    vi.useFakeTimers()
    const udp = fakeUdp()
    const registry = new PeerRegistry('node-alice')
    const rangeSync = new RangeSync({
      udp: udp as unknown as UdpChannel,
      registry,
      selfId: 'node-alice',
      getRanges: () => [{ cidr: '10.1.2.0/24', addedAt: 1 }],
      acceptRanges: vi.fn(),
      timings: {
        scanRangeShareInitialMin: 10,
        scanRangeShareInitialMax: 10,
        scanRangeShareInterval: 1_000
      }
    })

    rangeSync.start()
    registry.touch('node-bob', '127.0.0.1', 17878, profile('bob', 17878))
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    rangeSync.stop()

    expect(vi.getTimerCount()).toBe(0)
    expect(udp.send).not.toHaveBeenCalled()
  })
})

describe('RangeSync 入站过滤', () => {
  it('只接收已知 scan-ranges，并过滤非法与重复 CIDR', () => {
    const udp = fakeUdp()
    const acceptRanges = vi.fn()
    const registry = new PeerRegistry('node-alice')
    registry.touch('node-bob', '127.0.0.1', 17878, profile('bob', 17878))
    const source = { address: '127.0.0.1', port: 17878 }
    new RangeSync({
      udp: udp as unknown as UdpChannel,
      registry,
      selfId: 'node-alice',
      getRanges: () => [],
      acceptRanges
    })

    const payload: ScanRangesPayload = {
      ranges: [
        { cidr: '10.1.2.3/24', addedAt: 1 },
        { cidr: '10.1.2.0/24', addedAt: 2 },
        { cidr: '10.0.0.0/16', addedAt: 3 },
        { cidr: 'bad-cidr', addedAt: 4 },
        { cidr: '10.1.3.0/24', addedAt: 5 }
      ]
    }

    udp.emit('envelope', makeEnvelope(MSG_TYPES.scanRanges, 'node-bob', payload), false)
    udp.emit('envelope', makeEnvelope(MSG_TYPES.scanRanges, 'node-alice', payload), true)
    udp.emit('envelope', makeEnvelope(MSG_TYPES.scanRanges, 'node-bob', payload), true, source)

    udp.emit('envelope', makeEnvelope(MSG_TYPES.scanRanges, 'unknown', payload), true, source)
    udp.emit('envelope', makeEnvelope(MSG_TYPES.scanRanges, 'node-bob', payload), true, { ...source, port: 2 })
    registry.markOffline('node-bob')
    udp.emit('envelope', makeEnvelope(MSG_TYPES.scanRanges, 'node-bob', payload), true, source)
    expect(acceptRanges).toHaveBeenCalledTimes(1)
    expect(acceptRanges).toHaveBeenCalledWith('node-bob', [
      { cidr: '10.1.2.0/24', addedAt: 1 },
      { cidr: '10.1.3.0/24', addedAt: 5 }
    ])
  })
})

describe('RangeSync 回环同步', () => {
  it('shareNow 通过 127.0.0.1 发送去重后的合法 CIDR', async () => {
    const alice = await makeNode('alice')
    const bob = await makeNode('bob')
    alice.ranges.push(
      { cidr: '10.8.1.42/24', addedAt: 11 },
      { cidr: '10.8.1.0/24', addedAt: 22 },
      { cidr: '10.0.0.0/16', addedAt: 33 },
      { cidr: '10.8.2.0/24', addedAt: 0 }
    )
    alice.registry.touch(bob.profile.nodeId, '127.0.0.1', bob.port, bob.profile)
    bob.registry.touch(alice.profile.nodeId, '127.0.0.1', alice.port, alice.profile)
    alice.rangeSync.stop()
    const aliceSend = vi.spyOn(alice.udp, 'send')

    alice.rangeSync.shareNow()

    expect(aliceSend).toHaveBeenCalledTimes(1)
    await waitFor(() => bob.accepted.length === 1)
    expect(bob.accepted[0].from).toBe(alice.profile.nodeId)
    expect(bob.accepted[0].ranges[0]).toEqual({ cidr: '10.8.1.0/24', addedAt: 11 })
    expect(bob.accepted[0].ranges[1].cidr).toBe('10.8.2.0/24')
    expect(bob.accepted[0].ranges[1].addedAt).toBeGreaterThan(0)
    expect(bob.accepted[0].ranges).toHaveLength(2)
  })
})

// 实际 UDP 来源也必须匹配已发现节点。
it('回环拒绝陌生发送者与同 nodeId 不同端口的网段', async () => {
  const alice = await makeNode('alice'), bob = await makeNode('bob'), other = await makeNode('other')
  const env = makeEnvelope(MSG_TYPES.scanRanges, bob.profile.nodeId, { ranges: [{ cidr: '127.0.0.0/30', addedAt: 1 }] })
  bob.udp.send(env, '127.0.0.1', alice.port)
  await sleep(30)
  expect(alice.accepted).toHaveLength(0)
  alice.registry.touch(bob.profile.nodeId, '127.0.0.1', bob.port, bob.profile)
  other.udp.send(env, '127.0.0.1', alice.port)
  await sleep(30)
  expect(alice.accepted).toHaveLength(0)
  bob.udp.send(env, '127.0.0.1', alice.port)
  await waitFor(() => alice.accepted.length === 1)
})
