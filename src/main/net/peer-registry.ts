import { EventEmitter } from 'node:events'
import { isDeepStrictEqual } from 'node:util'
import type { Profile } from '../../shared/protocol'

const zhCollator = new Intl.Collator('zh-Hans-CN')

export interface PeerRecord {
  profile: Profile
  ip: string
  udpPort: number
  lastSeen: number
  online: boolean
  /** 离开状态（锁屏 / 闲置，决议 #323）；仅在线时有意义，不入持久化 */
  away?: boolean
}

/**
 * 节点表（内存态）。SQLite 持久化（F-DISC-7 联系人持久保留）随存储层落地。
 * 事件：'updated'（任何可见变化后触发一次，监听方自行节流）。
 */
export class PeerRegistry extends EventEmitter {
  private readonly peers = new Map<string, PeerRecord>()
  private readonly profileTimes = new Map<string, number>()
  private readonly profileConfirmationOnly = new Set<string>()

  constructor(private readonly selfNodeId: string) {
    super()
  }

  /** 启动时把持久化的历史联系人以离线态种回（F-DISC-7）；不覆盖已有记录 */
  seed(records: PeerRecord[]): void {
    let changed = false
    for (const record of records) {
      const id = record.profile.nodeId
      if (id === this.selfNodeId || this.peers.has(id)) continue
      this.peers.set(id, { ...record, online: false })
      changed = true
    }
    if (changed) this.emit('updated')
  }

  /** 收到对端任意报文时调用；带 profile 的报文（entry/alive/profile）会更新资料 */
  touch(nodeId: string, ip: string, udpPort: number, profile?: Profile, profileTs?: number,
    confirmed = false): PeerRecord | null {
    if (nodeId === this.selfNodeId) return null
    if (profile && profile.nodeId !== nodeId) return null

    const now = Date.now()
    const existing = this.peers.get(nodeId)
    let changed = false

    if (!existing) {
      if (!profile) return null // 没见过又没带资料的节点，等它的 entry/alive
      const record: PeerRecord = { profile, ip, udpPort, lastSeen: now, online: true }
      this.peers.set(nodeId, record)
      if (profileTs !== undefined) this.profileTimes.set(nodeId, profileTs)
      this.emit('updated')
      this.emit('online', nodeId) // 新节点即在线：触发补发等待者（messenger）
      return record
    }

    const sameAddress = existing.ip === ip && existing.udpPort === udpPort
    if (!sameAddress) {
      // 已在线节点不接受源地址漂移；离线节点换地址必须带完整 profile 重新握手。
      if (existing.online || !profile) return null
      existing.ip = ip
      existing.udpPort = udpPort
      changed = true
    }

    let cameOnline = false
    if (!existing.online) {
      existing.online = true
      changed = true
      cameOnline = true
    }
    const newer = profile && profile.profileRev > existing.profile.profileRev
    const sameRevision = profile && profile.profileRev === existing.profile.profileRev
    const ordered = profileTs === undefined || !this.profileTimes.has(nodeId) ||
      profileTs > this.profileTimes.get(nodeId)!
    if (profile && (newer || (sameRevision && ((ordered && !this.profileConfirmationOnly.has(nodeId)) || confirmed)))) {
      if (!isDeepStrictEqual(profile, existing.profile)) {
        changed = true
      }
      if (newer) this.profileConfirmationOnly.delete(nodeId)
      if (confirmed && sameRevision && profileTs !== undefined && profileTs <= (this.profileTimes.get(nodeId) ?? -Infinity)) {
        // 发送端时钟回拨后，同版本仅接受关联应答，防旧时钟报文再次覆盖。
        this.profileConfirmationOnly.add(nodeId)
      }
      existing.profile = profile
      if (profileTs !== undefined) this.profileTimes.set(nodeId, profileTs)
    }
    existing.lastSeen = now

    if (changed) this.emit('updated')
    // 放在所有字段更新之后：emit 是同步的，监听者（messenger 补发）要拿到最新地址（§7.2）
    if (cameOnline) this.emit('online', nodeId)
    return existing
  }

  get(nodeId: string): PeerRecord | undefined {
    return this.peers.get(nodeId)
  }

  /** 对端 profileRev（用于 presence 失配检测）；未知返回 -1 */
  profileRevOf(nodeId: string): number {
    return this.peers.get(nodeId)?.profile.profileRev ?? -1
  }

  markOffline(nodeId: string): void {
    const record = this.peers.get(nodeId)
    if (record && record.online) {
      record.online = false
      record.away = false
      this.emit('updated')
    }
  }

  /** 离开状态（决议 #323）：presence 心跳携带，仅内存态 */
  setAway(nodeId: string, away: boolean): void {
    const record = this.peers.get(nodeId)
    if (!record || !record.online) return
    if (record.away === away) return
    record.away = away
    this.emit('updated')
  }

  /** 心跳超时离线判定（protocol §6.2），由 Discovery 周期调用 */
  sweep(offlineAfterMs: number): void {
    const now = Date.now()
    let changed = false
    for (const record of this.peers.values()) {
      if (record.online && now - record.lastSeen > offlineAfterMs) {
        record.online = false
        changed = true
      }
    }
    if (changed) this.emit('updated')
  }

  onlineCount(): number {
    let n = 0
    for (const record of this.peers.values()) {
      if (record.online) n += 1
    }
    return n
  }

  /** 在线优先，再按昵称排序（通讯录展示顺序的最小实现） */
  list(): PeerRecord[] {
    return this.values().sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1
      return zhCollator.compare(a.profile.nick, b.profile.nick)
    })
  }

  /** 原始节点列表：保留 Map 迭代顺序，供网络/持久化等不需要展示排序的热路径使用。 */
  values(): PeerRecord[] {
    return [...this.peers.values()]
  }
}
