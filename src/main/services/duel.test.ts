import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAPS, type Envelope } from '../../shared/protocol'
import type { Messenger } from '../net/messenger'
import { DuelService } from './duel'

class FakeMessenger extends EventEmitter {
  sent: Envelope[] = []

  constructor(private readonly bus: Bus) {
    super()
  }

  async sendReliable(peerId: string, env: Envelope): Promise<boolean> {
    this.sent.push(env)
    return this.bus.deliver(peerId, env)
  }
}

class Bus {
  readonly nodes = new Map<string, FakeMessenger>()
  readonly online = new Set<string>()
  readonly caps = new Map<string, readonly string[]>()
  readonly serviceById = new Map<string, DuelService>()

  deliver(peerId: string, env: Envelope): boolean {
    const target = this.nodes.get(peerId)
    if (!target || !this.online.has(peerId)) return false
    target.emit('incoming', env)
    return true
  }

  add(id: string, name: string, options: { caps?: readonly string[] } = {}): DuelNode {
    const messenger = new FakeMessenger(this)
    this.nodes.set(id, messenger)
    this.online.add(id)
    this.caps.set(id, options.caps ?? [CAPS.duel])
    const service = new DuelService({
      selfId: id,
      messenger: messenger as unknown as Messenger,
      isOnline: (peerId) => this.online.has(peerId),
      peerCaps: (peerId) => this.caps.get(peerId) ?? null,
      peerName: (peerId) => (peerId === 'alice' ? 'Alice' : peerId === 'bob' ? 'Bob' : peerId),
      emit: () => undefined,
      inviteTtlMs: 5_000,
      syncGiveUpMs: 5_000,
      inviteCooldownMs: 60_000
    })
    this.serviceById.set(id, service)
    return { id, name, service, messenger }
  }
}

interface DuelNode {
  id: string
  name: string
  service: DuelService
  messenger: FakeMessenger
}

function setup(): { bus: Bus; alice: DuelNode; bob: DuelNode } {
  const bus = new Bus()
  return { bus, alice: bus.add('alice', 'Alice'), bob: bus.add('bob', 'Bob') }
}

function startMatch(alice: DuelNode, bob: DuelNode): string {
  expect(alice.service.invite('bob').ok).toBe(true)
  const invite = bob.service.currentView()
  expect(invite).toMatchObject({ phase: 'incoming', peerId: 'alice', peerName: 'Alice', role: 'guest' })
  const matchId = invite!.matchId
  expect(bob.service.respond(matchId, true).ok).toBe(true)
  expect(alice.service.currentView()).toMatchObject({ phase: 'fighting', round: 1, role: 'host' })
  expect(bob.service.currentView()).toMatchObject({ phase: 'fighting', round: 1, role: 'guest' })
  return matchId
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DuelService 邀请与开局', () => {
  it('只向声明 duel1 的在线对端发送邀请；旧端保持零打扰', () => {
    const bus = new Bus()
    const alice = bus.add('alice', 'Alice')
    bus.add('bob', 'Bob', { caps: [] })

    expect(alice.service.invite('bob')).toMatchObject({ ok: false, reason: 'unsupported' })
    expect(alice.messenger.sent).toHaveLength(0)

    bus.online.delete('bob')
    expect(alice.service.invite('bob')).toMatchObject({ ok: false, reason: 'offline' })
    expect(alice.messenger.sent).toHaveLength(0)
  })

  it('接受后双方进入同一回合；拒绝方给出明确结束态', () => {
    const { alice, bob } = setup()
    const matchId = startMatch(alice, bob)

    expect(alice.service.currentView()?.matchId).toBe(matchId)
    expect(alice.service.currentView()).toMatchObject({
      round: 1,
      selfHp: 100,
      peerHp: 100,
      seq: 1
    })

    const guestView = bob.service.currentView()!
    expect(guestView.peerHp).toBe(100)
    expect(guestView.selfHp).toBe(100)
    expect(guestView.outcome).toBeNull()
  })

  it('拒绝邀请：邀请方保留结算提示，接收方立即收起', () => {
    const { alice, bob } = setup()
    alice.service.invite('bob')
    const matchId = bob.service.currentView()!.matchId

    expect(bob.service.respond(matchId, false)).toEqual({ ok: true })
    expect(bob.service.currentView()).toBeNull()
    expect(alice.service.currentView()).toMatchObject({
      phase: 'ended',
      reason: 'declined',
      outcome: null
    })
  })

  it('邀请超时自动取消，双方都不会停留在等待态', () => {
    vi.useFakeTimers()
    const { alice, bob } = setup()
    alice.service.invite('bob')
    expect(bob.service.currentView()).toMatchObject({ phase: 'incoming' })

    vi.advanceTimersByTime(5_000)

    expect(alice.service.currentView()).toMatchObject({ phase: 'ended', reason: 'timeout' })
    expect(bob.service.currentView()).toBeNull()
  })

  it('同一对端连续邀请受冷却限制', () => {
    const { alice, bob } = setup()
    alice.service.invite('bob')
    const matchId = bob.service.currentView()!.matchId
    bob.service.respond(matchId, false)
    expect(alice.service.invite('bob')).toMatchObject({ ok: false, reason: 'rate-limited' })
  })
})

describe('DuelService 出招与同步', () => {
  it('双方出招后 host 立即权威结算，两端血量与回合一致', () => {
    const { alice, bob } = setup()
    const matchId = startMatch(alice, bob)

    expect(alice.service.move(matchId, 'attack')).toEqual({ ok: true })
    expect(bob.service.move(matchId, 'trick')).toEqual({ ok: true })

    const hostView = alice.service.currentView()!
    const guestView = bob.service.currentView()!
    expect(hostView.round).toBe(2)
    expect(guestView.round).toBe(2)
    expect(hostView.last).toEqual(guestView.last)
    expect(hostView.selfHp).toBe(guestView.peerHp)
    expect(hostView.peerHp).toBe(guestView.selfHp)
    expect(hostView.last).toMatchObject({ round: 1, hostAction: 'attack', guestAction: 'trick' })
  })

  it('同一回合重复出招不改写已锁定招式', () => {
    const { alice, bob } = setup()
    const matchId = startMatch(alice, bob)

    bob.service.move(matchId, 'attack')
    expect(bob.service.move(matchId, 'trick')).toMatchObject({ ok: false, reason: 'invalid' })
    alice.service.move(matchId, 'attack')
    expect(alice.service.currentView()?.last).toMatchObject({ guestAction: 'attack' })
  })

  it('重复 / 乱序的 state 不会让 guest 回退或重复结算', () => {
    const { alice, bob } = setup()
    const matchId = startMatch(alice, bob)

    const startState = alice.messenger.sent.find(
      (env) => env.type === 'duel' && (env.payload as { op?: string; seq?: number }).op === 'state' &&
        (env.payload as { seq?: number }).seq === 1
    )
    expect(startState).toBeTruthy()

    alice.service.move(matchId, 'attack')
    bob.service.move(matchId, 'guard')
    const afterFirst = bob.service.currentView()!

    alice.service.move(matchId, 'trick')
    bob.service.move(matchId, 'attack')
    const applied = bob.service.currentView()!
    expect(applied.seq).toBeGreaterThan(afterFirst.seq)

    // 旧快照乱序到达 + 最新快照重复到达：都按 seq 幂等丢弃。
    bob.messenger.emit('incoming', startState!)
    expect(bob.service.currentView()).toEqual(applied)
    const latest = alice.messenger.sent
      .filter((env) => env.type === 'duel' && (env.payload as { op?: string }).op === 'state')
      .at(-1)
    expect(latest).toBeTruthy()
    bob.messenger.emit('incoming', latest!)
    expect(bob.service.currentView()).toEqual(applied)
  })

  it('跨回合 / 未来回合的 move 一律丢弃', () => {
    const { alice, bob } = setup()
    const matchId = startMatch(alice, bob)

    alice.service.handleEnvelope({
      v: 1,
      type: 'duel',
      id: 'future-1',
      from: 'bob',
      ts: Date.now(),
      payload: { op: 'move', matchId, round: 99, action: 'attack' }
    })
    expect(alice.service.currentView()?.peerSubmitted).toBe(false)

    alice.service.move(matchId, 'attack')
    bob.service.move(matchId, 'guard')
    const roundTwo = alice.service.currentView()!.round
    alice.service.handleEnvelope({
      v: 1,
      type: 'duel',
      id: 'stale-1',
      from: 'bob',
      ts: Date.now(),
      payload: { op: 'move', matchId, round: roundTwo - 1, action: 'attack' }
    })
    expect(alice.service.currentView()?.peerSubmitted).toBe(false)
  })

  it('倒计时结束 host 按防御兜底结算，guest 收到超时标记', () => {
    vi.useFakeTimers()
    const { alice, bob } = setup()
    const matchId = startMatch(alice, bob)

    alice.service.move(matchId, 'attack')
    vi.advanceTimersByTime(11_000)

    const hostView = alice.service.currentView()!
    const guestView = bob.service.currentView()!
    expect(hostView.round).toBe(2)
    expect(hostView.last).toMatchObject({
      round: 1,
      guestAction: 'guard',
      guestTimedOut: true,
      hostTimedOut: false
    })
    expect(guestView.last).toEqual(hostView.last)
  })

  it('guest 丢失快照后重同步可拿到 host 的最新状态', () => {
    vi.useFakeTimers()
    const bus = new Bus()
    const alice = bus.add('alice', 'Alice')
    const bob = bus.add('bob', 'Bob')
    const matchId = startMatch(alice, bob)

    // guest 暂时不可达：host 的下一回合快照投递失败。
    bus.online.delete('bob')
    alice.service.move(matchId, 'attack')
    vi.advanceTimersByTime(11_000)
    const expected = alice.service.currentView()!
    const before = bob.service.currentView()!
    expect(before.round).toBe(1)

    // 恢复可达后 guest 的重同步定时器补发 sync，host 补发当前快照。
    bus.online.add('bob')
    vi.advanceTimersByTime(2_000)

    expect(bob.service.currentView()!.seq).toBeGreaterThan(before.seq)
    expect(bob.service.currentView()!.round).toBe(expected.round)
    expect(bob.service.currentView()!.selfHp).toBe(expected.peerHp)
  })
})

describe('DuelService 中断与退出', () => {
  it('对端离线时中断对局，不宣布胜负', () => {
    const bus = new Bus()
    const alice = bus.add('alice', 'Alice')
    const bob = bus.add('bob', 'Bob')
    startMatch(alice, bob)

    bus.online.delete('bob')
    alice.service.handleRegistryChange()

    expect(alice.service.currentView()).toMatchObject({
      phase: 'ended',
      reason: 'offline',
      outcome: null,
      winner: null
    })
  })

  it('对端恢复同步后双方均显示中断，不产生胜负', () => {
    vi.useFakeTimers()
    const bus = new Bus()
    const alice = bus.add('alice', 'Alice')
    const bob = bus.add('bob', 'Bob')
    startMatch(alice, bob)

    bus.online.delete('bob')
    alice.service.handleRegistryChange()
    expect(alice.service.currentView()).toMatchObject({ phase: 'ended', reason: 'offline', outcome: null })

    // guest 同步后得到相同的中断状态。
    bus.online.add('bob')
    vi.advanceTimersByTime(15_000)

    expect(bob.service.currentView()).toMatchObject({ phase: 'ended', reason: 'offline', outcome: null, winner: null })
  })

  it('一方退出：退出方判负，留守方判胜', () => {
    const { alice, bob } = setup()
    const matchId = startMatch(alice, bob)

    expect(bob.service.quit(matchId)).toEqual({ ok: true })
    expect(bob.service.currentView()).toMatchObject({ phase: 'ended', reason: 'quit', outcome: 'lose' })
    expect(alice.service.currentView()).toMatchObject({ phase: 'ended', reason: 'quit', outcome: 'win' })
  })

  it('取消邀请：host 显示已取消，guest 清空邀请', () => {
    const { alice, bob } = setup()
    alice.service.invite('bob')
    const matchId = bob.service.currentView()!.matchId

    expect(alice.service.quit(matchId)).toEqual({ ok: true })
    expect(alice.service.currentView()).toMatchObject({ phase: 'ended', reason: 'cancelled' })
    expect(bob.service.currentView()).toBeNull()
  })

  it('忽略非对端伪造的 state 快照', () => {
    const bus = new Bus()
    const alice = bus.add('alice', 'Alice')
    const bob = bus.add('bob', 'Bob')
    const matchId = startMatch(alice, bob)

    const before = bob.service.currentView()!
    bob.service.handleEnvelope({
      v: 1,
      type: 'duel',
      id: 'spoof-1',
      from: 'eve',
      ts: Date.now(),
      payload: {
        op: 'state',
        matchId,
        seq: 99,
        phase: 'ended',
        round: 1,
        hostHp: 0,
        guestHp: 100,
        remainingMs: 0,
        last: null,
        winner: 'guest',
        reason: 'knockout'
      }
    })
    // 来自非对端的 state 一律丢弃，bob 的会话保持原状。
    expect(bob.service.currentView()).toEqual(before)
  })
})
