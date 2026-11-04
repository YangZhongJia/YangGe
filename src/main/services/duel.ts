import { randomBytes, randomUUID } from 'node:crypto'
import { CAPS, MSG_TYPES, type Envelope } from '../../shared/protocol'
import {
  DUEL_DEFAULT_MAX_ROUNDS,
  DUEL_DEFAULT_ROUND_MS,
  DUEL_ENDED_TTL_MS,
  DUEL_GRACE_MS,
  DUEL_INVITE_COOLDOWN_MS,
  DUEL_INVITE_TTL_MS,
  DUEL_MAX_HP,
  DUEL_SYNC_GIVEUP_MS,
  DUEL_SYNC_RETRY_MS,
  duelOutcomeFor,
  duelOtherSide,
  resolveDuelRound,
  validateDuelPayload,
  type DuelAction,
  type DuelCommandResult,
  type DuelEndReason,
  type DuelPayload,
  type DuelRoundResult,
  type DuelSide,
  type DuelStateEvent,
  type DuelView,
  type DuelWinner
} from '../../shared/duel'
import { makeEnvelope } from '../net/codec'
import type { Messenger } from '../net/messenger'

// 双人角斗场用例编排（主进程）。
//
// 状态机：inviting / incoming → fighting → ended（结束时保留结算视图，用户关闭后释放）。
// host 权威：只有 host 结算回合并广播 state；guest 只提交 move 与 sync。
// 所有入站报文先经 codec 白名单校验，本服务再做身份 / 会话 / 回合三层核对。
// 会话只驻留内存，不写消息库 —— 聊天记录保持原样，旧版客户端完全不受影响。

export interface DuelDeps {
  selfId: string
  messenger: Messenger
  isOnline(peerId: string): boolean
  /** 对端声明的能力位；老版本没有 duel1 时禁止发起邀请。 */
  peerCaps(peerId: string): readonly string[] | null
  peerName(peerId: string): string
  emit(event: DuelStateEvent): void
  now?(): number
  roundMs?: number
  inviteTtlMs?: number
  endedTtlMs?: number
  graceMs?: number
  syncRetryMs?: number
  syncGiveUpMs?: number
  inviteCooldownMs?: number
}

interface DuelTimings {
  roundMs: number
  inviteTtlMs: number
  endedTtlMs: number
  graceMs: number
  syncRetryMs: number
  syncGiveUpMs: number
  inviteCooldownMs: number
}

interface DuelSession {
  matchId: string
  peerId: string
  role: DuelSide
  phase: 'incoming' | 'inviting' | 'fighting' | 'ended'
  seed: string
  roundMs: number
  maxRounds: number
  round: number
  hostHp: number
  guestHp: number
  hostAction: DuelAction | null
  guestAction: DuelAction | null
  seq: number
  deadline: number
  last: DuelRoundResult | null
  winner: DuelWinner | null
  reason: DuelEndReason | null
  roundTimer: NodeJS.Timeout | null
  inviteTimer: NodeJS.Timeout | null
  endedTimer: NodeJS.Timeout | null
  /** guest 是否已收到 host 的至少一帧状态（accept 发送失败时不误判离线）。 */
  hostStateSeen: boolean
}

export class DuelService {
  private current: DuelSession | null = null
  private readonly timing: DuelTimings
  private readonly lastInviteAt = new Map<string, number>()
  private disposed = false

  constructor(private readonly deps: DuelDeps) {
    this.timing = {
      roundMs: deps.roundMs ?? DUEL_DEFAULT_ROUND_MS,
      inviteTtlMs: deps.inviteTtlMs ?? DUEL_INVITE_TTL_MS,
      endedTtlMs: deps.endedTtlMs ?? DUEL_ENDED_TTL_MS,
      graceMs: deps.graceMs ?? DUEL_GRACE_MS,
      syncRetryMs: deps.syncRetryMs ?? DUEL_SYNC_RETRY_MS,
      syncGiveUpMs: deps.syncGiveUpMs ?? DUEL_SYNC_GIVEUP_MS,
      inviteCooldownMs: deps.inviteCooldownMs ?? DUEL_INVITE_COOLDOWN_MS
    }
    deps.messenger.on('incoming', (env: Envelope) => {
      if (env.type !== MSG_TYPES.duel) return
      this.handleEnvelope(env as Envelope<DuelPayload>)
    })
  }

  currentView(): DuelView | null {
    return this.current ? this.toView(this.current) : null
  }

  /** 发起邀请：只允许在线且声明 duel1 的对端，一次仅保留一场会话。 */
  invite(peerId: string): DuelCommandResult {
    if (!peerId || peerId.length > 64) return { ok: false, reason: 'invalid' }
    const existing = this.current
    if (existing && existing.phase !== 'ended') return { ok: false, reason: 'busy' }
    if (!this.deps.isOnline(peerId)) return { ok: false, reason: 'offline' }
    const caps = this.deps.peerCaps(peerId)
    if (!caps || !caps.includes(CAPS.duel)) return { ok: false, reason: 'unsupported' }

    const now = this.now()
    const lastAt = this.lastInviteAt.get(peerId) ?? 0
    if (now - lastAt < this.timing.inviteCooldownMs) return { ok: false, reason: 'rate-limited' }
    if (existing?.phase === 'ended') this.clearSession(existing)
    this.lastInviteAt.set(peerId, now)

    const session: DuelSession = {
      matchId: randomUUID(),
      peerId,
      role: 'host',
      phase: 'inviting',
      seed: randomBytes(12).toString('hex'),
      roundMs: this.timing.roundMs,
      maxRounds: DUEL_DEFAULT_MAX_ROUNDS,
      round: 0,
      hostHp: DUEL_MAX_HP,
      guestHp: DUEL_MAX_HP,
      hostAction: null,
      guestAction: null,
      seq: 0,
      deadline: now + this.timing.inviteTtlMs,
      last: null,
      winner: null,
      reason: null,
      roundTimer: null,
      inviteTimer: null,
      endedTimer: null,
      hostStateSeen: false
    }
    this.current = session
    this.inviteTimer(session)
    this.emitView(session)

    const payload: DuelPayload = {
      op: 'invite',
      matchId: session.matchId,
      seed: session.seed,
      roundMs: session.roundMs,
      maxRounds: session.maxRounds
    }
    void this.sendReliable(peerId, payload).then((ok) => {
      if (ok || this.current !== session || session.phase !== 'inviting') return
      this.finish(session, null, 'offline')
    })
    return { ok: true }
  }

  /** 接受 / 拒绝收到的邀请。 */
  respond(matchId: string, accept: boolean): DuelCommandResult {
    const session = this.current
    if (!session || session.matchId !== matchId) return { ok: false, reason: 'no-session' }
    if (session.role !== 'guest' || session.phase !== 'incoming') {
      return { ok: false, reason: 'invalid' }
    }
    if (!accept) {
      this.send(session.peerId, { op: 'decline', matchId, reason: 'declined' })
      this.clearSession(session)
      return { ok: true }
    }
    if (!this.deps.isOnline(session.peerId)) {
      this.clearSession(session)
      return { ok: false, reason: 'offline' }
    }

    session.phase = 'fighting'
    session.round = 1
    session.hostHp = DUEL_MAX_HP
    session.guestHp = DUEL_MAX_HP
    session.hostAction = null
    session.guestAction = null
    session.seq = 0
    session.deadline = this.now() + session.roundMs
    this.clearInviteTimer(session)
    this.armGuestSync(session)
    this.emitView(session)

    void this.sendReliable(session.peerId, { op: 'accept', matchId }).then((ok) => {
      if (ok || this.current !== session || session.hostStateSeen) return
      if (session.phase === 'fighting' && session.seq === 0) {
        this.finish(session, null, 'offline')
      }
    })
    return { ok: true }
  }

  /** 出招：本机每回合只允许锁定一次；guest 把招式发给 host。 */
  move(matchId: string, action: DuelAction): DuelCommandResult {
    const session = this.current
    if (!session || session.matchId !== matchId) return { ok: false, reason: 'no-session' }
    if (session.phase !== 'fighting') return { ok: false, reason: 'invalid' }
    const own = this.ownAction(session)
    if (own !== null) return own === action ? { ok: true } : { ok: false, reason: 'invalid' }

    if (session.role === 'host') {
      session.hostAction = action
      this.emitView(session)
      if (session.guestAction !== null) this.resolveHostRound(session)
      return { ok: true }
    }

    session.guestAction = action
    this.emitView(session)
    this.send(session.peerId, {
      op: 'move',
      matchId,
      round: session.round,
      action
    })
    return { ok: true }
  }

  /** 主动退出 / 取消邀请 / 关闭结算画面（按当前阶段自动映射）。 */
  quit(matchId: string): DuelCommandResult {
    const session = this.current
    if (!session || session.matchId !== matchId) return { ok: false, reason: 'no-session' }

    if (session.phase === 'ended') {
      this.clearSession(session)
      return { ok: true }
    }
    if (session.phase === 'incoming') {
      this.send(session.peerId, { op: 'decline', matchId, reason: 'declined' })
      this.clearSession(session)
      return { ok: true }
    }
    if (session.phase === 'inviting') {
      this.send(session.peerId, { op: 'cancel', matchId })
      this.finish(session, null, 'cancelled')
      return { ok: true }
    }

    this.send(session.peerId, { op: 'quit', matchId })
    this.finish(session, duelOtherSide(session.role), 'quit')
    return { ok: true }
  }

  /** 关闭 ended 会话；fighting 阶段请走 quit。 */
  close(matchId: string): DuelCommandResult {
    const session = this.current
    if (!session || session.matchId !== matchId) return { ok: false, reason: 'no-session' }
    if (session.phase !== 'ended') return { ok: false, reason: 'invalid' }
    this.clearSession(session)
    return { ok: true }
  }

  /** 注册表任意变化后调用：对端掉线则中断，不推断胜负。 */
  handleRegistryChange(): void {
    const session = this.current
    if (!session || session.phase === 'ended') return
    if (this.deps.isOnline(session.peerId)) return
    if (session.phase === 'incoming') {
      this.clearSession(session)
      return
    }
    if (session.phase === 'inviting') {
      this.finish(session, null, 'offline')
      return
    }
    this.finish(session, null, 'offline')
  }

  /** 入站入口（也供测试直接调用）。 */
  handleEnvelope(env: Envelope<DuelPayload>): void {
    if (this.disposed) return
    if (!env || env.from === this.deps.selfId) return
    if (!validateDuelPayload(env.payload)) return
    const payload = env.payload
    const session = this.current

    if (session?.phase === 'ended' && payload.op === 'invite') {
      this.clearSession(session)
    }

    switch (payload.op) {
      case 'invite':
        this.onInvite(env.from, payload)
        return
      case 'accept':
        if (session?.role === 'host' && session.peerId === env.from && session.matchId === payload.matchId) {
          if (session.phase === 'inviting') this.startHostMatch(session)
          else if (session.phase === 'fighting' || session.phase === 'ended') this.sendState(session)
        }
        return
      case 'decline':
        if (session?.role === 'host' && session.peerId === env.from && session.matchId === payload.matchId && session.phase === 'inviting') {
          this.finish(session, null, payload.reason === 'busy' ? 'busy' : payload.reason === 'timeout' ? 'timeout' : 'declined')
        }
        return
      case 'cancel':
        if (session && session.peerId === env.from && session.matchId === payload.matchId && session.role === 'guest' && session.phase !== 'ended') {
          this.clearSession(session)
        }
        return
      case 'move':
        this.onRemoteMove(env.from, payload)
        return
      case 'sync':
        if (session?.role === 'host' && session.peerId === env.from && session.matchId === payload.matchId) {
          if (session.phase === 'inviting') this.sendInvite(session)
          else this.sendState(session)
        }
        return
      case 'quit':
        if (session && session.peerId === env.from && session.matchId === payload.matchId && session.phase !== 'ended') {
          this.finish(session, session.role, 'quit')
        }
        return
      case 'state':
        this.onHostState(env.from, payload)
        return
      default:
        return
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.current) this.clearTimers(this.current)
    this.current = null
  }

  private onInvite(from: string, payload: Extract<DuelPayload, { op: 'invite' }>): void {
    const existing = this.current
    if (existing) {
      if (existing.matchId === payload.matchId && existing.peerId === from) {
        // host 重发邀请：guest 已经开打就补发 accept，让 host 进入同一状态机。
        if (existing.phase === 'fighting') this.send(from, { op: 'accept', matchId: existing.matchId })
        return
      }
      if (existing.phase !== 'ended') {
        this.send(from, { op: 'decline', matchId: payload.matchId, reason: 'busy' })
        return
      }
      this.clearSession(existing)
    }

    const now = this.now()
    this.current = {
      matchId: payload.matchId,
      peerId: from,
      role: 'guest',
      phase: 'incoming',
      seed: payload.seed,
      roundMs: payload.roundMs,
      maxRounds: payload.maxRounds,
      round: 0,
      hostHp: DUEL_MAX_HP,
      guestHp: DUEL_MAX_HP,
      hostAction: null,
      guestAction: null,
      seq: 0,
      deadline: now + this.timing.inviteTtlMs,
      last: null,
      winner: null,
      reason: null,
      roundTimer: null,
      inviteTimer: null,
      endedTimer: null,
      hostStateSeen: false
    }
    this.inviteTimer(this.current)
    this.emitView(this.current)
  }

  private onRemoteMove(
    from: string,
    payload: Extract<DuelPayload, { op: 'move' }>
  ): void {
    const session = this.current
    if (!session || session.role !== 'host' || session.phase !== 'fighting') return
    if (session.matchId !== payload.matchId || session.peerId !== from) return
    if (payload.round !== session.round) return
    if (session.guestAction !== null) return
    session.guestAction = payload.action
    this.emitView(session)
    if (session.hostAction !== null) this.resolveHostRound(session)
  }

  private onHostState(
    from: string,
    payload: Extract<DuelPayload, { op: 'state' }>
  ): void {
    const session = this.current
    if (!session || session.role !== 'guest' || session.matchId !== payload.matchId) return
    if (session.peerId !== from) return
    if (session.phase === 'incoming' || session.phase === 'ended') return
    if (payload.seq <= session.seq) return

    session.hostStateSeen = true
    session.seq = payload.seq
    session.round = payload.round
    session.hostHp = payload.hostHp
    session.guestHp = payload.guestHp
    session.last = payload.last
    session.winner = payload.winner
    session.reason = payload.reason
    session.deadline = payload.phase === 'fighting' ? this.now() + payload.remainingMs : 0
    // 新回合：把上一回合的本地出招状态清空，等待本轮再次选择。
    if (payload.last && payload.last.round === payload.round) {
      session.guestAction = null
    } else if (payload.phase === 'fighting') {
      session.guestAction = null
    }
    this.clearRoundTimer(session)

    if (payload.phase === 'ended') {
      session.phase = 'ended'
      session.hostAction = null
      session.guestAction = null
      this.clearTimers(session)
      this.emitView(session)
      this.armEndedTtl(session)
      return
    }

    session.phase = 'fighting'
    this.armGuestSync(session)
    this.emitView(session)
  }

  private startHostMatch(session: DuelSession): void {
    this.clearInviteTimer(session)
    session.phase = 'fighting'
    session.round = 1
    session.hostHp = DUEL_MAX_HP
    session.guestHp = DUEL_MAX_HP
    session.hostAction = null
    session.guestAction = null
    session.seq = 1
    session.deadline = this.now() + session.roundMs
    this.armHostRound(session)
    this.sendState(session)
    this.emitView(session)
  }

  private resolveHostRound(session: DuelSession): void {
    if (this.current !== session || session.phase !== 'fighting') return
    const hostTimedOut = session.hostAction === null
    const guestTimedOut = session.guestAction === null
    const hostAction = session.hostAction ?? 'guard'
    const guestAction = session.guestAction ?? 'guard'
    this.clearRoundTimer(session)

    const resolution = resolveDuelRound({
      seed: session.seed,
      round: session.round,
      hostHp: session.hostHp,
      guestHp: session.guestHp,
      hostAction,
      guestAction,
      hostTimedOut,
      guestTimedOut,
      maxRounds: session.maxRounds
    })
    session.hostHp = resolution.hostHp
    session.guestHp = resolution.guestHp
    // 只把协议允许的字段放进 last：ended/winner/reason 由 state 顶层承载，
    // 否则 guest 的严格白名单会拒绝整帧。
    session.last = {
      round: resolution.round,
      hostAction: resolution.hostAction,
      guestAction: resolution.guestAction,
      hostDamage: resolution.hostDamage,
      guestDamage: resolution.guestDamage,
      hostHeal: resolution.hostHeal,
      guestHeal: resolution.guestHeal,
      hostHp: resolution.hostHp,
      guestHp: resolution.guestHp,
      hostTimedOut: resolution.hostTimedOut,
      guestTimedOut: resolution.guestTimedOut
    }
    session.hostAction = null
    session.guestAction = null
    session.seq += 1

    if (resolution.ended) {
      session.phase = 'ended'
      session.winner = resolution.winner
      session.reason = resolution.reason
      session.deadline = 0
      this.sendState(session)
      this.emitView(session)
      this.armEndedTtl(session)
      return
    }

    session.round += 1
    session.deadline = this.now() + session.roundMs
    this.armHostRound(session)
    this.sendState(session)
    this.emitView(session)
  }

  private armHostRound(session: DuelSession): void {
    this.clearRoundTimer(session)
    const delay = Math.max(0, session.deadline - this.now())
    session.roundTimer = this.timer(() => {
      if (this.current !== session || session.phase !== 'fighting') return
      if (session.hostAction !== null && session.guestAction !== null) {
        this.resolveHostRound(session)
        return
      }
      session.roundTimer = this.timer(() => {
        if (this.current === session && session.phase === 'fighting') this.resolveHostRound(session)
      }, this.timing.graceMs)
    }, delay)
  }

  private armGuestSync(session: DuelSession): void {
    if (session.role !== 'guest' || session.phase !== 'fighting') return
    this.clearRoundTimer(session)
    const tick = (): void => {
      if (this.current !== session || session.phase !== 'fighting') return
      const now = this.now()
      if (now < session.deadline) {
        session.roundTimer = this.timer(tick, session.deadline - now)
        return
      }
      if (now - session.deadline >= this.timing.syncGiveUpMs) {
        if (this.deps.isOnline(session.peerId)) {
          // 对端还在但快照始终不来：先告知 host 退出，避免它继续等 guest 出招。
          this.send(session.peerId, { op: 'quit', matchId: session.matchId })
          this.finish(session, duelOtherSide(session.role), 'timeout')
        } else {
          this.finish(session, null, 'offline')
        }
        return
      }
      this.send(session.peerId, { op: 'sync', matchId: session.matchId })
      session.roundTimer = this.timer(tick, this.timing.syncRetryMs)
    }
    session.roundTimer = this.timer(tick, Math.max(0, session.deadline - this.now()))
  }

  private inviteTimer(session: DuelSession): void {
    this.clearInviteTimer(session)
    session.inviteTimer = this.timer(() => {
      if (this.current !== session || (session.phase !== 'incoming' && session.phase !== 'inviting')) return
      if (session.phase === 'incoming') {
        this.send(session.peerId, { op: 'decline', matchId: session.matchId, reason: 'timeout' })
        this.clearSession(session)
        return
      }
      this.send(session.peerId, { op: 'cancel', matchId: session.matchId })
      this.finish(session, null, 'timeout')
    }, Math.max(0, session.deadline - this.now()))
  }

  private armEndedTtl(session: DuelSession): void {
    if (session.endedTimer) clearTimeout(session.endedTimer)
    session.endedTimer = this.timer(() => {
      if (this.current === session && session.phase === 'ended') this.clearSession(session)
    }, this.timing.endedTtlMs)
  }

  private finish(session: DuelSession, winner: DuelWinner | null, reason: DuelEndReason): void {
    if (session.phase === 'ended') return
    session.phase = 'ended'
    session.winner = winner
    session.reason = reason
    session.hostAction = null
    session.guestAction = null
    session.deadline = 0
    session.seq += 1
    this.clearTimers(session)
    this.emitView(session)
    this.armEndedTtl(session)
  }

  private sendInvite(session: DuelSession): void {
    this.send(session.peerId, {
      op: 'invite',
      matchId: session.matchId,
      seed: session.seed,
      roundMs: session.roundMs,
      maxRounds: session.maxRounds
    })
  }

  private sendState(session: DuelSession): void {
    if (session.role !== 'host') return
    const remaining = session.phase === 'fighting'
      ? Math.max(1, Math.min(session.roundMs, Math.round(session.deadline - this.now())))
      : 0
    this.send(session.peerId, {
      op: 'state',
      matchId: session.matchId,
      seq: session.seq,
      phase: session.phase === 'ended' ? 'ended' : 'fighting',
      round: session.round,
      hostHp: session.hostHp,
      guestHp: session.guestHp,
      remainingMs: remaining,
      last: session.last,
      winner: session.winner,
      reason: session.reason
    })
  }

  private send(peerId: string, payload: DuelPayload): void {
    void this.sendReliable(peerId, payload)
  }

  private sendReliable(peerId: string, payload: DuelPayload): Promise<boolean> {
    const env = makeEnvelope<DuelPayload>(MSG_TYPES.duel, this.deps.selfId, payload)
    return this.deps.messenger.sendReliable(peerId, env).catch(() => false)
  }

  private ownAction(session: DuelSession): DuelAction | null {
    return session.role === 'host' ? session.hostAction : session.guestAction
  }

  private toView(session: DuelSession): DuelView {
    const selfHp = session.role === 'host' ? session.hostHp : session.guestHp
    const peerHp = session.role === 'host' ? session.guestHp : session.hostHp
    const selfAction = this.ownAction(session)
    const peerAction = session.role === 'host' ? session.guestAction : session.hostAction
    return {
      matchId: session.matchId,
      peerId: session.peerId,
      peerName: this.deps.peerName(session.peerId) || session.peerId,
      role: session.role,
      phase: session.phase,
      round: session.round,
      maxRounds: session.maxRounds,
      roundMs: session.roundMs,
      selfHp,
      peerHp,
      maxHp: DUEL_MAX_HP,
      selfAction,
      peerAction,
      selfSubmitted: selfAction !== null,
      peerSubmitted: peerAction !== null,
      endsAt: session.phase === 'ended' ? 0 : session.deadline,
      last: session.last,
      winner: session.winner,
      outcome: session.phase === 'ended' ? duelOutcomeFor(session.winner, session.role) : null,
      reason: session.reason,
      seq: session.seq
    }
  }

  private emitView(session: DuelSession): void {
    this.deps.emit({ peerId: session.peerId, view: this.toView(session) })
  }

  private clearSession(session: DuelSession): void {
    this.clearTimers(session)
    if (this.current === session) this.current = null
    this.deps.emit({ peerId: session.peerId, view: null })
  }

  private clearTimers(session: DuelSession): void {
    this.clearRoundTimer(session)
    this.clearInviteTimer(session)
    if (session.endedTimer) {
      clearTimeout(session.endedTimer)
      session.endedTimer = null
    }
  }

  private clearRoundTimer(session: DuelSession): void {
    clearTimeout(session.roundTimer ?? undefined)
    session.roundTimer = null
  }

  private clearInviteTimer(session: DuelSession): void {
    clearTimeout(session.inviteTimer ?? undefined)
    session.inviteTimer = null
  }

  private timer(fn: () => void, ms: number): NodeJS.Timeout {
    const handle = setTimeout(fn, Math.max(0, ms))
    handle.unref?.()
    return handle
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }
}
