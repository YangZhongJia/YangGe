// 双人角斗场 —— 协议载荷、确定性战斗规则与渲染层视图（main / renderer / 测试共用）。
//
// 设计约束：
// 1) 纯内网点对点：只复用现有局域网 Messenger，不引入任何外网依赖。
// 2) 会话只驻留内存：邀请 / 出招 / 结算都不落聊天库，不污染历史记录。
// 3) 主客模型：发起方（host）权威结算，接收方（guest）只提交招式并应用 host 广播的快照。
//    这样乱序、重传、丢包都收敛到同一份状态；guest 过点重同步（sync）即可补齐。
// 4) 旧客户端兼容：新报文类型需要 duel1 能力位；对口邀请端必先声明能力位，
//    旧端既不会收到未知报文，也不会被误判离线。

export const DUEL_MAX_HP = 100
export const DUEL_MIN_ROUND_MS = 5_000
export const DUEL_MAX_ROUND_MS = 30_000
export const DUEL_DEFAULT_ROUND_MS = 10_000
export const DUEL_MIN_ROUNDS = 5
export const DUEL_DEFAULT_MAX_ROUNDS = 6
export const DUEL_MAX_ROUNDS_LIMIT = 50

/** 邀请等待接受 / 自动过期的时长。 */
export const DUEL_INVITE_TTL_MS = 30_000
/** 结算画面保留时长（之后主进程自动回收，避免长期占内存）。 */
export const DUEL_ENDED_TTL_MS = 10 * 60_000
/** guest 在倒计时结束后向 host 重同步的间隔。 */
export const DUEL_SYNC_RETRY_MS = 2_000
/** guest 过点后等待 host 快照的最长时间，超时按中断处理。 */
export const DUEL_SYNC_GIVEUP_MS = 20_000
/** host 在倒计时结束后的宽容窗口，等待迟到的 guest 招式。 */
export const DUEL_GRACE_MS = 400
/** 对同一对端的邀请最短间隔，避免连续打扰。 */
export const DUEL_INVITE_COOLDOWN_MS = 5_000

export type DuelAction = 'attack' | 'guard' | 'trick'
export type DuelSide = 'host' | 'guest'
export type DuelWinner = DuelSide | 'draw'
export type DuelPhase = 'incoming' | 'inviting' | 'fighting' | 'ended'
export type DuelOutcome = 'win' | 'lose' | 'draw'

export type DuelEndReason =
  | 'knockout'
  | 'rounds'
  | 'quit'
  | 'offline'
  | 'declined'
  | 'busy'
  | 'cancelled'
  | 'timeout'
  | 'error'

const DUEL_ACTIONS: readonly DuelAction[] = ['attack', 'guard', 'trick']
const DUEL_END_REASONS: readonly DuelEndReason[] = [
  'knockout',
  'rounds',
  'quit',
  'offline',
  'declined',
  'busy',
  'cancelled',
  'timeout',
  'error'
]
const DUEL_DECLINE_REASONS = ['declined', 'busy', 'timeout'] as const

export function isDuelAction(value: unknown): value is DuelAction {
  return typeof value === 'string' && (DUEL_ACTIONS as readonly string[]).includes(value)
}

export function isDuelSide(value: unknown): value is DuelSide {
  return value === 'host' || value === 'guest'
}

export function isDuelWinner(value: unknown): value is DuelWinner {
  return value === 'host' || value === 'guest' || value === 'draw'
}

export function isDuelEndReason(value: unknown): value is DuelEndReason {
  return typeof value === 'string' && (DUEL_END_REASONS as readonly string[]).includes(value)
}

export function duelOtherSide(side: DuelSide): DuelSide {
  return side === 'host' ? 'guest' : 'host'
}

/** 单回合结算明细：给双方 UI 播放同一套伤害 / 治疗 / 动画。 */
export interface DuelRoundResult {
  round: number
  hostAction: DuelAction
  guestAction: DuelAction
  hostDamage: number
  guestDamage: number
  hostHeal: number
  guestHeal: number
  hostHp: number
  guestHp: number
  hostTimedOut: boolean
  guestTimedOut: boolean
}

export interface DuelResolution extends DuelRoundResult {
  ended: boolean
  winner: DuelWinner | null
  reason: DuelEndReason | null
}

export interface DuelResolveInput {
  seed: string
  round: number
  hostHp: number
  guestHp: number
  hostAction: DuelAction
  guestAction: DuelAction
  hostTimedOut?: boolean
  guestTimedOut?: boolean
  maxRounds: number
}

function clampHp(value: number): number {
  return Math.max(0, Math.min(DUEL_MAX_HP, Math.round(value)))
}

/** FNV-1a：让同一 seed / round / 槽位在所有客户端得到同一随机流。 */
function hashUnit(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d)
  hash ^= hash >>> 15
  return (hash >>> 0) / 0x1_0000_0000
}

function roll(seed: string, round: number, slot: string): number {
  return hashUnit(`${seed}|${round}|${slot}`)
}

const GUARD_ATTACK_RATIO = 0.4
const GUARD_TRICK_RATIO = 0.5
const GUARD_HEAL = 2
const DOUBLE_GUARD_HEAL = 4

/**
 * 确定性单回合结算。只依赖输入（不读时钟 / 随机源），
 * host 与测试可复现同一结果；guest 不需要重算，只应用 host 快照。
 *
 * 规则（“搞怪但不复杂”）：
 * - 普通攻击：8–14 伤害；对方防御时只吃 40%。
 * - 防御：本回合回 2 HP；双方都防御时各回 4 HP，互相干瞪眼。
 * - 搞怪技能：4–8 伤害 + 自回 3–7 HP；对方防御时伤害减半。
 * - 同归于尽判平局；回合耗尽按剩余血量判定，血量相同则平局。
 */
export function resolveDuelRound(input: DuelResolveInput): DuelResolution {
  const { seed, round, hostAction, guestAction } = input
  const attackHost = 8 + Math.floor(roll(seed, round, 'host:attack') * 7)
  const attackGuest = 8 + Math.floor(roll(seed, round, 'guest:attack') * 7)
  const trickHost = 4 + Math.floor(roll(seed, round, 'host:trick') * 5)
  const trickGuest = 4 + Math.floor(roll(seed, round, 'guest:trick') * 5)
  const healHost = 3 + Math.floor(roll(seed, round, 'host:heal') * 5)
  const healGuest = 3 + Math.floor(roll(seed, round, 'guest:heal') * 5)

  let hostDamage = 0
  let guestDamage = 0
  let hostHeal = 0
  let guestHeal = 0

  if (hostAction === 'attack') {
    guestDamage += guestAction === 'guard' ? Math.ceil(attackHost * GUARD_ATTACK_RATIO) : attackHost
  } else if (hostAction === 'trick') {
    guestDamage += guestAction === 'guard' ? Math.ceil(trickHost * GUARD_TRICK_RATIO) : trickHost
    hostHeal += healHost
  }

  if (guestAction === 'attack') {
    hostDamage += hostAction === 'guard' ? Math.ceil(attackGuest * GUARD_ATTACK_RATIO) : attackGuest
  } else if (guestAction === 'trick') {
    hostDamage += hostAction === 'guard' ? Math.ceil(trickGuest * GUARD_TRICK_RATIO) : trickGuest
    guestHeal += healGuest
  }

  if (hostAction === 'guard' && guestAction === 'guard') {
    hostHeal += DOUBLE_GUARD_HEAL
    guestHeal += DOUBLE_GUARD_HEAL
  } else {
    if (hostAction === 'guard') hostHeal += GUARD_HEAL
    if (guestAction === 'guard') guestHeal += GUARD_HEAL
  }

  const hostHp = clampHp(input.hostHp - hostDamage + hostHeal)
  const guestHp = clampHp(input.guestHp - guestDamage + guestHeal)

  let ended = false
  let winner: DuelWinner | null = null
  let reason: DuelEndReason | null = null

  if (hostHp <= 0 || guestHp <= 0) {
    ended = true
    reason = 'knockout'
    if (hostHp <= 0 && guestHp <= 0) winner = 'draw'
    else winner = hostHp <= 0 ? 'guest' : 'host'
  } else if (round >= input.maxRounds) {
    ended = true
    reason = 'rounds'
    winner = hostHp === guestHp ? 'draw' : hostHp > guestHp ? 'host' : 'guest'
  }

  return {
    round,
    hostAction,
    guestAction,
    hostDamage,
    guestDamage,
    hostHeal,
    guestHeal,
    hostHp,
    guestHp,
    hostTimedOut: input.hostTimedOut === true,
    guestTimedOut: input.guestTimedOut === true,
    ended,
    winner,
    reason
  }
}

// ---------- 线上载荷 ----------

export interface DuelInvitePayload {
  op: 'invite'
  matchId: string
  seed: string
  roundMs: number
  maxRounds: number
}

export interface DuelStatePayload {
  op: 'state'
  matchId: string
  /** host 侧单调递增；guest 只接受更大的 seq，重传 / 乱序天然幂等。 */
  seq: number
  phase: 'fighting' | 'ended'
  round: number
  hostHp: number
  guestHp: number
  /** 当前回合剩余时间（相对值，避免两端时钟偏差）。 */
  remainingMs: number
  last: DuelRoundResult | null
  winner: DuelWinner | null
  reason: DuelEndReason | null
}

export type DuelPayload =
  | DuelInvitePayload
  | { op: 'accept'; matchId: string }
  | { op: 'decline'; matchId: string; reason?: (typeof DUEL_DECLINE_REASONS)[number] }
  | { op: 'cancel'; matchId: string }
  | { op: 'move'; matchId: string; round: number; action: DuelAction }
  | { op: 'sync'; matchId: string }
  | { op: 'quit'; matchId: string }
  | DuelStatePayload

const MATCH_ID = /^[A-Za-z0-9_-]{8,64}$/
const SEED = /^[A-Za-z0-9_-]{8,64}$/

function isId(value: unknown): value is string {
  return typeof value === 'string' && MATCH_ID.test(value)
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function hasOnlyKeys(payload: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(payload).every((key) => allowed.includes(key))
}

export function isDuelRoundResult(value: unknown): value is DuelRoundResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (!hasOnlyKeys(row, [
    'round', 'hostAction', 'guestAction', 'hostDamage', 'guestDamage', 'hostHeal', 'guestHeal',
    'hostHp', 'guestHp', 'hostTimedOut', 'guestTimedOut'
  ])) return false
  return (
    isIntIn(row.round, 1, DUEL_MAX_ROUNDS_LIMIT) &&
    isDuelAction(row.hostAction) &&
    isDuelAction(row.guestAction) &&
    isIntIn(row.hostDamage, 0, DUEL_MAX_HP) &&
    isIntIn(row.guestDamage, 0, DUEL_MAX_HP) &&
    isIntIn(row.hostHeal, 0, DUEL_MAX_HP) &&
    isIntIn(row.guestHeal, 0, DUEL_MAX_HP) &&
    isIntIn(row.hostHp, 0, DUEL_MAX_HP) &&
    isIntIn(row.guestHp, 0, DUEL_MAX_HP) &&
    typeof row.hostTimedOut === 'boolean' &&
    typeof row.guestTimedOut === 'boolean'
  )
}

/** 入站白名单校验（codec 调用）；任何未知字段都拒绝，避免夹带私有数据。 */
export function validateDuelPayload(payload: unknown): payload is DuelPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
  const record = payload as Record<string, unknown>
  const op = record.op
  if (op === 'invite') {
    return (
      hasOnlyKeys(record, ['op', 'matchId', 'seed', 'roundMs', 'maxRounds']) &&
      isId(record.matchId) &&
      typeof record.seed === 'string' && SEED.test(record.seed) &&
      isIntIn(record.roundMs, DUEL_MIN_ROUND_MS, DUEL_MAX_ROUND_MS) &&
      isIntIn(record.maxRounds, DUEL_MIN_ROUNDS, DUEL_MAX_ROUNDS_LIMIT)
    )
  }
  if (op === 'accept' || op === 'cancel' || op === 'sync' || op === 'quit') {
    return hasOnlyKeys(record, ['op', 'matchId']) && isId(record.matchId)
  }
  if (op === 'decline') {
    return (
      hasOnlyKeys(record, ['op', 'matchId', 'reason']) &&
      isId(record.matchId) &&
      (record.reason === undefined ||
        (typeof record.reason === 'string' &&
          (DUEL_DECLINE_REASONS as readonly string[]).includes(record.reason)))
    )
  }
  if (op === 'move') {
    return (
      hasOnlyKeys(record, ['op', 'matchId', 'round', 'action']) &&
      isId(record.matchId) &&
      isIntIn(record.round, 1, DUEL_MAX_ROUNDS_LIMIT) &&
      isDuelAction(record.action)
    )
  }
  if (op === 'state') {
    if (!hasOnlyKeys(record, [
      'op', 'matchId', 'seq', 'phase', 'round', 'hostHp', 'guestHp', 'remainingMs',
      'last', 'winner', 'reason'
    ])) return false
    if (!isId(record.matchId)) return false
    if (typeof record.seq !== 'number' || !Number.isInteger(record.seq) || record.seq < 0) return false
    if (record.phase !== 'fighting' && record.phase !== 'ended') return false
    if (!isIntIn(record.round, 1, DUEL_MAX_ROUNDS_LIMIT)) return false
    if (!isIntIn(record.hostHp, 0, DUEL_MAX_HP) || !isIntIn(record.guestHp, 0, DUEL_MAX_HP)) return false
    if (!isIntIn(record.remainingMs, 0, DUEL_MAX_ROUND_MS)) return false
    if (record.last !== null && !isDuelRoundResult(record.last)) return false
    if (record.winner !== null && !isDuelWinner(record.winner)) return false
    if (record.reason !== null && !isDuelEndReason(record.reason)) return false
    return record.phase === 'ended' ? true : record.remainingMs > 0
  }
  return false
}

// ---------- IPC 视图 ----------

export interface DuelView {
  matchId: string
  peerId: string
  peerName: string
  /** 本机在协议中的角色。 */
  role: DuelSide
  phase: DuelPhase
  round: number
  maxRounds: number
  roundMs: number
  selfHp: number
  peerHp: number
  maxHp: number
  selfAction: DuelAction | null
  peerAction: DuelAction | null
  selfSubmitted: boolean
  peerSubmitted: boolean
  /** 本地时钟下的截止时间；0 表示当前阶段没有倒计时。 */
  endsAt: number
  last: DuelRoundResult | null
  winner: DuelWinner | null
  outcome: DuelOutcome | null
  reason: DuelEndReason | null
  seq: number
}

export interface DuelStateEvent {
  peerId: string
  view: DuelView | null
}

export type DuelFailureReason =
  | 'offline'
  | 'unsupported'
  | 'busy'
  | 'rate-limited'
  | 'invalid'
  | 'no-session'

export interface DuelCommandResult {
  ok: boolean
  reason?: DuelFailureReason
}

export function duelOutcomeFor(winner: DuelWinner | null, role: DuelSide): DuelOutcome | null {
  if (!winner) return null
  if (winner === 'draw') return 'draw'
  return winner === role ? 'win' : 'lose'
}
