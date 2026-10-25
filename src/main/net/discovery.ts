import type { RemoteInfo } from 'node:dgram'
import { isDeepStrictEqual } from 'node:util'
import {
  DISCOVERY_PROBE_CAP,
  GOSSIP_FANOUT,
  MSG_TYPES,
  PEERS_PER_PACKET,
  TIMINGS,
  type Envelope,
  type PeersPayload,
  type PeerSummary,
  type PresencePayload,
  type Profile,
  type ProfilePayload,
  type Timings
} from '../../shared/protocol'
import { makeEnvelope } from './codec'
import type { PeerClock } from './peer-clock'
import type { UdpChannel } from './udp'
import type { PeerRegistry } from './peer-registry'

export interface ManualPeer {
  host: string
  port: number
}

export interface DiscoveryOptions {
  udp: UdpChannel
  registry: PeerRegistry
  profile: Profile
  /** 跨网段/本机联调的手动节点（protocol §6.3 第一板斧） */
  manualPeers?: ManualPeer[]
  /** 测试注入：缩短时序 */
  timings?: Partial<Timings>
  /** 时钟偏移矫正（决议 #65）：收到实时发现报文时观测各节点与本机的时钟差 */
  peerClock?: PeerClock
}

export interface ScanOptions {
  key?: string
  background?: boolean
  shouldRun?: () => boolean
  onProgress?: (done: number) => void
  onComplete?: () => void
  onCancel?: () => void
}

interface ScanTask extends ScanOptions {
  hosts: string[]
  port: number
  delay: number
  index: number
}

interface ProfileRequest {
  id: string
  ip: string
  port: number
  timer: ReturnType<typeof setTimeout>
  retry: ReturnType<typeof setTimeout>
  active: boolean
}

/**
 * 发现服务（protocol §6）：entry/alive/exit/presence 的全部时序逻辑。
 * 不依赖 Electron —— vitest 里两个实例对发即可集成测试。
 */
export class Discovery {
  private readonly udp: UdpChannel
  private readonly registry: PeerRegistry
  private readonly profile: Profile
  private readonly manualPeers: ManualPeer[]
  private readonly t: Timings
  private readonly peerClock?: PeerClock

  private stopped = false
  private presenceSeq = 0
  private presenceTimer: ReturnType<typeof setInterval> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private gossipTimer: ReturnType<typeof setInterval> | null = null
  private scanTimer: ReturnType<typeof setTimeout> | null = null
  private readonly scans: ScanTask[] = []
  private nextScanAt = 0
  private readonly gossipSends = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly cacheTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly profileRequests = new Map<string, ProfileRequest>()
  private readonly lastProfileProbe = new Map<string, number>()
  private readonly lastDirectedReply = new Map<string, number>()
  private readonly pendingReplies = new Map<string, ReturnType<typeof setTimeout>>()
  /** nodeId → 最近一次发 alive 的时间（§6.1 去重应答，防批量开机风暴） */
  private readonly lastAliveAt = new Map<string, number>()
  /** 已做过"结识即交换"的节点（§6.3 gossip），避免反复发 */
  private readonly gossiped = new Set<string>()

  constructor(opts: DiscoveryOptions) {
    this.udp = opts.udp
    this.registry = opts.registry
    this.profile = opts.profile
    this.manualPeers = opts.manualPeers ?? []
    this.t = { ...TIMINGS, ...opts.timings }
    this.peerClock = opts.peerClock
    this.udp.on('envelope', (env: Envelope, known: boolean, rinfo: RemoteInfo) => {
      if (known && !this.stopped) this.handle(env, rinfo)
      // 未知类型按协议忽略（向前兼容）
    })
    // 结识即交换（§6.3）：首次得知某节点在线 → 把我已知的在线节点摘要告诉它
    this.registry.on('online', (nodeId: string) => {
      if (this.stopped || this.gossiped.has(nodeId)) return
      this.gossiped.add(nodeId)
      this.sendPeersTo(nodeId)
    })
  }

  private get selfId(): string {
    return this.profile.nodeId
  }

  start(): void {
    this.stopped = false
    this.udp.broadcast(this.envEntry())
    for (const peer of this.manualPeers) {
      this.udp.send(this.envEntry(), peer.host, peer.port)
    }

    this.presenceTimer = setInterval(() => this.sendPresence(), this.t.presenceInterval)
    this.sweepTimer = setInterval(() => this.registry.sweep(this.t.offlineAfter), this.t.sweepInterval)
    this.gossipTimer = setInterval(() => this.gossipRound(), this.t.gossipInterval)
    this.presenceTimer.unref?.()
    this.sweepTimer.unref?.()
    this.gossipTimer.unref?.()

    // 节点缓存启动探测（§6.3）：对 7 天内活跃过的离线节点错峰单播 entry，
    // 广播不可达（跨网段）时靠它快速重建在线列表
    const now = Date.now()
    const stale = this.registry
      .values()
      .filter((r) => !r.online && now - r.lastSeen < this.t.peerCacheProbeTtl)
    stale.forEach((record, i) => {
      const timer = setTimeout(() => {
        this.cacheTimers.delete(timer)
        this.probe(record.ip, record.udpPort)
      }, 50 * i)
      this.cacheTimers.add(timer)
      timer.unref?.()
    })
  }

  /** 退出：广播 exit，并对在线节点逐个单播（跨网段节点收不到广播，protocol §6.1） */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.presenceTimer) clearInterval(this.presenceTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.gossipTimer) clearInterval(this.gossipTimer)
    if (this.scanTimer) {
      clearTimeout(this.scanTimer)
      this.scanTimer = null
    }
    for (const task of this.scans.splice(0)) task.onCancel?.()
    for (const timer of this.gossipSends.values()) clearTimeout(timer)
    this.gossipSends.clear()
    for (const timer of this.cacheTimers) clearTimeout(timer)
    this.cacheTimers.clear()
    for (const id of this.profileRequests.keys()) this.clearProfileRequest(id)
    this.lastProfileProbe.clear()
    this.lastDirectedReply.clear()
    this.lastAliveAt.clear()
    this.gossiped.clear()
    for (const timer of this.pendingReplies.values()) clearTimeout(timer)
    this.pendingReplies.clear()

    const exit = makeEnvelope(MSG_TYPES.exit, this.selfId, {})
    this.udp.broadcast(exit)
    for (const record of this.registry.values()) {
      if (record.online) this.udp.send(exit, record.ip, record.udpPort)
    }
  }

  /** 按需探活（F-DISC-8）：复用 entry，对方回 alive 即在线 */
  probe(host: string, port: number): void {
    if (this.stopped) return
    this.udp.send(this.envEntry(), host, port)
  }

  /** 周期 gossip（§6.3 兜底）：向随机 GOSSIP_FANOUT 个在线节点交换摘要 */
  private gossipRound(): void {
    const online = this.registry.values().filter((r) => r.online)
    if (online.length === 0) return
    const shuffled = shuffle([...online])
    for (const record of shuffled.slice(0, GOSSIP_FANOUT)) {
      this.sendPeersTo(record.profile.nodeId)
    }
  }

  /** 把我已知的在线节点摘要（排除自己与对方）分包单播给目标 */
  private sendPeersTo(nodeId: string): void {
    if (this.gossipSends.has(nodeId)) return
    let index = 0
    const tick = (): void => {
      const target = this.registry.get(nodeId)
      if (!target?.online) {
        this.gossipSends.delete(nodeId)
        return
      }
      // 按需取一包，避免每个目标各缓存一份千人列表；变化由后续周期补齐。
      const peers = this.registry.values().filter(r => r.online && r.profile.nodeId !== nodeId)
      const summaries: PeerSummary[] = peers.slice(index, index + PEERS_PER_PACKET).map(r => ({
        nodeId: r.profile.nodeId, ip: r.ip, udpPort: r.udpPort,
        tcpPort: r.profile.tcpPort, lastSeen: r.lastSeen
      }))
      if (summaries.length > 0) {
        this.udp.send(makeEnvelope<PeersPayload>(MSG_TYPES.peers, this.selfId, { peers: summaries }), target.ip, target.udpPort)
      }
      index += PEERS_PER_PACKET
      if (index >= peers.length) {
        this.gossipSends.delete(nodeId)
        return
      }
      const timer = setTimeout(tick, this.t.gossipPacketInterval)
      this.gossipSends.set(nodeId, timer)
      timer.unref?.()
    }
    const timer = setTimeout(tick, 0)
    this.gossipSends.set(nodeId, timer)
    timer.unref?.()
  }

  /** 资料变更广播（向导/设置保存后）：同网段即时刷新；跨网段靠 presence 的 rev 失配兜底 */
  announceProfile(): void {
    const env = makeEnvelope<ProfilePayload>(MSG_TYPES.profile, this.selfId, {
      profile: this.profile
    })
    this.udp.broadcast(env)
    for (const record of this.registry.values()) {
      if (record.online) this.udp.send(env, record.ip, record.udpPort)
    }
  }

  /** 探活已知节点；未知节点返回 false */
  probeNode(nodeId: string): boolean {
    if (this.stopped) return false
    const record = this.registry.get(nodeId)
    if (!record) return false
    this.requestProfile(nodeId, record.ip, record.udpPort, true)
    return true
  }

  /** 所有网段扫描共用队列；手动优先，后台任务保留游标。 */
  scanHosts(hosts: string[], port: number, hostDelayMs = 8, opts: ScanOptions = {}): number {
    if (this.stopped || hosts.length === 0) return 0
    const existing = opts.key && this.scans.find(task => task.key === opts.key)
    if (existing) return existing.hosts.length
    this.scans.push({ ...opts, hosts: [...hosts], port, delay: Math.max(8, hostDelayMs), index: 0 })
    this.scheduleScan(0)
    return hosts.length
  }

  cancelScan(key: string): void {
    for (const task of [...this.scans]) {
      if (task.key !== key) continue
      this.scans.splice(this.scans.indexOf(task), 1)
      task.onCancel?.()
    }
    if (this.scans.length === 0 && this.scanTimer) {
      clearTimeout(this.scanTimer)
      this.scanTimer = null
    }
  }

  private scheduleScan(delay: number): void {
    if (this.scanTimer || this.scans.length === 0) return
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null
      const task = this.scans.find(item => !item.background) ?? this.scans[0]
      if (!task) return
      if (task.shouldRun && !task.shouldRun()) {
        this.scans.splice(this.scans.indexOf(task), 1)
        task.onCancel?.()
        this.scheduleScan(0)
        return
      }
      this.nextScanAt = Date.now() + task.delay
      this.probe(task.hosts[task.index], task.port)
      task.index += 1
      task.onProgress?.(task.index)
      if (task.index === task.hosts.length) {
        this.scans.splice(this.scans.indexOf(task), 1)
        // 先保留下一发的间隔，完成回调可安全加入下一任务。
        this.scheduleScan(task.delay)
        task.onComplete?.()
      }
      this.scheduleScan(task.delay)
    }, Math.max(delay, this.nextScanAt - Date.now()))
    this.scanTimer.unref?.()
  }

  private clearProfileRequest(nodeId: string): void {
    const request = this.profileRequests.get(nodeId)
    if (!request) return
    clearTimeout(request.timer)
    clearTimeout(request.retry)
    this.profileRequests.delete(nodeId)
  }

  private requestProfile(nodeId: string, ip: string, port: number, active = false): void {
    const existing = this.profileRequests.get(nodeId)
    if (existing) {
      if (existing.ip === ip && existing.port === port) existing.active ||= active
      return
    }
    const now = Date.now()
    if (!active && now - (this.lastProfileProbe.get(nodeId) ?? -Infinity) < this.t.profileProbeInterval) return
    if (this.profileRequests.size >= 1024) return
    // 仅保留有界节流记录，避免陌生心跳不断生成身份占用内存。
    if (this.lastProfileProbe.size >= 1024) this.lastProfileProbe.delete(this.lastProfileProbe.keys().next().value!)
    this.lastProfileProbe.set(nodeId, now)
    const record = this.registry.get(nodeId)
    const fast = record?.profile.caps.includes(DISCOVERY_PROBE_CAP)
    const timeout = fast ? this.t.probeTimeout : this.t.legacyProbeTimeout
    const env = this.envEntry()
    env.payload.probeId = env.id
    const request: ProfileRequest = {
      id: env.id, ip, port, active,
      retry: setTimeout(() => this.udp.send(env, ip, port), fast ? timeout / 2 : this.t.aliveDedupWindow),
      timer: setTimeout(() => {
        this.clearProfileRequest(nodeId)
        const current = this.registry.get(nodeId)
        if (request.active && current?.ip === ip && current.udpPort === port && current.lastSeen <= now) {
          this.registry.markOffline(nodeId)
        }
      }, timeout)
    }
    this.profileRequests.set(nodeId, request)
    request.timer.unref?.()
    request.retry.unref?.()
    this.udp.send(env, ip, port)
  }

  private envEntry(): Envelope<ProfilePayload> {
    return makeEnvelope<ProfilePayload>(MSG_TYPES.entry, this.selfId, { profile: this.profile })
  }

  private away = false

  /** 离开状态（决议 #323）：变更后立即广播一次，后续心跳继续携带 */
  setAway(value: boolean): void {
    if (this.away === value) return
    this.away = value
    this.sendPresence()
  }

  private sendPresence(): void {
    this.presenceSeq += 1
    const payload: PresencePayload = { seq: this.presenceSeq, profileRev: this.profile.profileRev }
    if (this.away) payload.away = true
    const env = makeEnvelope(MSG_TYPES.presence, this.selfId, payload)
    this.udp.broadcast(env)
    // 跨网段在线节点单播心跳（protocol §6.2）；同网段节点会重复收到，靠去重无害
    for (const record of this.registry.values()) {
      if (record.online) this.udp.send(env, record.ip, record.udpPort)
    }
  }

  private handle(env: Envelope, rinfo: RemoteInfo): void {
    if (env.from === this.selfId) return // 自己的广播回环

    switch (env.type) {
      case MSG_TYPES.entry:
      case MSG_TYPES.alive:
      case MSG_TYPES.profile: {
        const { profile, probeId } = env.payload as ProfilePayload
        if (profile.nodeId !== env.from) break
        const request = this.profileRequests.get(env.from)
        const confirmed = env.type === MSG_TYPES.alive && !!probeId && request?.id === probeId &&
          request.ip === rinfo.address && request.port === rinfo.port
        const record = this.registry.touch(env.from, rinfo.address, rinfo.port, profile, env.ts, confirmed)
        if (!record) break
        this.peerClock?.observe(env.from, env.ts, Date.now())
        if (confirmed || (request && request.ip === rinfo.address && request.port === rinfo.port &&
          !profile.caps.includes(DISCOVERY_PROBE_CAP) && env.type === MSG_TYPES.alive)) {
          this.clearProfileRequest(env.from)
        }
        if (profile.profileRev === record.profile.profileRev && !isDeepStrictEqual(profile, record.profile)) {
          this.requestProfile(env.from, rinfo.address, rinfo.port)
        }
        if (env.type === MSG_TYPES.entry) this.scheduleAliveReply(env.from, rinfo, probeId)
        break
      }
      case MSG_TYPES.exit: {
        const peer = this.registry.get(env.from)
        if (peer?.ip === rinfo.address && peer.udpPort === rinfo.port) this.registry.markOffline(env.from)
        break
      }
      case MSG_TYPES.presence: {
        const presence = env.payload as PresencePayload
        const knownRev = this.registry.profileRevOf(env.from)
        const touched = this.registry.touch(env.from, rinfo.address, rinfo.port)
        this.registry.setAway(env.from, presence.away === true)
        if (touched) this.peerClock?.observe(env.from, env.ts, Date.now())
        const peer = this.registry.get(env.from)
        if ((touched && presence.profileRev !== knownRev) || !peer || (!peer.online && !touched)) {
          this.requestProfile(env.from, rinfo.address, rinfo.port)
        }
        break
      }
      case MSG_TYPES.peers: {
        // gossip：转述不直接入表——对陌生且新鲜的条目单播 entry 验证（防列表投毒）
        const { peers } = env.payload as PeersPayload
        const now = Date.now()
        for (const summary of peers) {
          if (summary.nodeId === this.selfId) continue
          if (this.registry.get(summary.nodeId)?.online) continue
          if (now - summary.lastSeen > this.t.gossipFreshness) continue
          this.probe(summary.ip, summary.udpPort)
        }
        break
      }
      default:
        break // 其余已知类型由后续模块（messenger/transfer）接管
    }
  }

  /** entry 应答：规模自适应抖动 + 10s 去重（protocol §6.1 批量开机风暴对策） */
  private scheduleAliveReply(nodeId: string, rinfo: RemoteInfo, probeId?: string): void {
    const now = Date.now()
    if (probeId) {
      if (now - (this.lastDirectedReply.get(nodeId) ?? -Infinity) < this.t.directedReplyInterval) return
      this.lastDirectedReply.set(nodeId, now)
      this.udp.send(makeEnvelope<ProfilePayload>(MSG_TYPES.alive, this.selfId, {
        profile: this.profile, probeId
      }), rinfo.address, rinfo.port)
      return
    }
    const last = this.lastAliveAt.get(nodeId) ?? 0
    if (now - last < this.t.aliveDedupWindow) return
    if (this.pendingReplies.has(nodeId)) return

    const online = this.registry.onlineCount()
    const window = Math.min(
      this.t.entryReplyJitterBase + Math.floor(online / 100) * 1000,
      this.t.entryReplyJitterMax
    )
    const delay = Math.floor(Math.random() * Math.max(window, 1))

    const timer = setTimeout(() => {
      this.pendingReplies.delete(nodeId)
      this.lastAliveAt.set(nodeId, Date.now())
      const alive = makeEnvelope<ProfilePayload>(MSG_TYPES.alive, this.selfId, {
        profile: this.profile
      })
      this.udp.send(alive, rinfo.address, rinfo.port)
    }, delay)
    this.pendingReplies.set(nodeId, timer)
  }
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const current = items[i]
    items[i] = items[j]
    items[j] = current
  }
  return items
}
