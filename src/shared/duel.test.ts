import { describe, expect, it } from 'vitest'
import {
  DUEL_DEFAULT_MAX_ROUNDS,
  DUEL_MAX_HP,
  resolveDuelRound,
  validateDuelPayload,
  type DuelAction,
  type DuelResolution
} from './duel'

function resolve(
  hostAction: DuelAction,
  guestAction: DuelAction,
  overrides: Partial<Parameters<typeof resolveDuelRound>[0]> = {}
): DuelResolution {
  return resolveDuelRound({
    seed: 'seed-0123456789',
    round: 1,
    hostHp: DUEL_MAX_HP,
    guestHp: DUEL_MAX_HP,
    hostAction,
    guestAction,
    maxRounds: DUEL_DEFAULT_MAX_ROUNDS,
    ...overrides
  })
}

describe('resolveDuelRound', () => {
  it('同一 seed / 回合 / 招式得到完全一致的结果（host 与测试可复现）', () => {
    const first = resolve('attack', 'trick')
    const second = resolve('attack', 'trick')
    expect(second).toEqual(first)
    expect(first.hostAction).toBe('attack')
    expect(first.guestAction).toBe('trick')
    expect(first.hostDamage).toBeGreaterThan(0)
    expect(first.guestDamage).toBeGreaterThan(0)
    expect(first.hostHp).toBeLessThanOrEqual(DUEL_MAX_HP)
    expect(first.guestHp).toBeLessThanOrEqual(DUEL_MAX_HP)
  })

  it('防御把普攻伤害压到 40%，并回复 2 HP', () => {
    const normal = resolve('attack', 'trick')
    const guarded = resolve('attack', 'guard')
    expect(guarded.guestDamage).toBeLessThan(normal.guestDamage)
    expect(guarded.guestHeal).toBe(2)
    expect(guarded.hostDamage).toBe(0)
  })

  it('双方都防御时互相刮痧并各回 4 HP', () => {
    const result = resolve('guard', 'guard', { hostHp: 50, guestHp: 60 })
    expect(result.hostDamage).toBe(0)
    expect(result.guestDamage).toBe(0)
    expect(result.hostHp).toBe(54)
    expect(result.guestHp).toBe(64)
    expect(result.ended).toBe(false)
  })

  it('搞怪技能同时造成伤害并自回血，血量永不超过上限', () => {
    const result = resolve('trick', 'trick', { hostHp: 99, guestHp: 98 })
    expect(result.hostDamage).toBeGreaterThan(0)
    expect(result.guestDamage).toBeGreaterThan(0)
    expect(result.hostHeal).toBeGreaterThanOrEqual(3)
    expect(result.guestHeal).toBeGreaterThanOrEqual(3)
    expect(result.hostHp).toBeLessThanOrEqual(DUEL_MAX_HP)
    expect(result.guestHp).toBeLessThanOrEqual(DUEL_MAX_HP)
  })

  it('血量归零即 KO；双方同时归零判平局', () => {
    const hostWins = resolve('attack', 'guard', { guestHp: 1 })
    expect(hostWins.ended).toBe(true)
    expect(hostWins.reason).toBe('knockout')
    expect(hostWins.winner).toBe('host')

    const draw = resolve('attack', 'attack', { hostHp: 1, guestHp: 1 })
    expect(draw.ended).toBe(true)
    expect(draw.winner).toBe('draw')
  })

  it('回合耗尽按剩余血量判定，血量相同则平局', () => {
    const win = resolve('attack', 'attack', { round: 20, maxRounds: 20 })
    expect(win.ended).toBe(true)
    expect(win.reason).toBe('rounds')
    expect(win.winner).not.toBeNull()

    const draw = resolve('guard', 'guard', { round: 20, maxRounds: 20, hostHp: 30, guestHp: 30 })
    expect(draw.ended).toBe(true)
    expect(draw.winner).toBe('draw')
  })

  it('出招超时会被标记，调用方用防御兜底结算', () => {
    const result = resolve('attack', 'guard', { guestTimedOut: true })
    expect(result.guestTimedOut).toBe(true)
    expect(result.hostTimedOut).toBe(false)
  })
})

describe('validateDuelPayload', () => {
  it('接受合法邀请与状态快照', () => {
    expect(validateDuelPayload({
      op: 'invite',
      matchId: 'match-12345678',
      seed: 'seed-12345678',
      roundMs: 15_000,
      maxRounds: 20
    })).toBe(true)
    expect(validateDuelPayload({
      op: 'state',
      matchId: 'match-12345678',
      seq: 1,
      phase: 'fighting',
      round: 1,
      hostHp: 100,
      guestHp: 100,
      remainingMs: 9_000,
      last: null,
      winner: null,
      reason: null
    })).toBe(true)
  })

  it('拒绝未知操作、越界数值和夹带字段', () => {
    expect(validateDuelPayload({ op: 'explode', matchId: 'match-12345678' })).toBe(false)
    expect(validateDuelPayload({
      op: 'invite',
      matchId: 'match-12345678',
      seed: 'seed-12345678',
      roundMs: 1,
      maxRounds: 20
    })).toBe(false)
    expect(validateDuelPayload({
      op: 'move',
      matchId: 'match-12345678',
      round: 1,
      action: 'attack',
      injected: true
    })).toBe(false)
    expect(validateDuelPayload({
      op: 'state',
      matchId: 'match-12345678',
      seq: 1,
      phase: 'ended',
      round: 1,
      hostHp: -1,
      guestHp: 100,
      remainingMs: 0,
      last: null,
      winner: null,
      reason: null
    })).toBe(false)
  })
})
