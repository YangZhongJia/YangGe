// 局域网 P2P 自更新编排（决议 #166）。
import type { Platform, Profile, RuntimeArch } from '../../shared/protocol'
import { CAPS, UPDATE_PACKAGE_MAX_BYTES } from '../../shared/protocol'
import { compareSemver } from '../util/semver'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface UpdateSource {
  nodeId: string
  /** 来源节点展示名（备注优先，其次昵称） */
  fromName: string
  /** 来源节点的应用版本 */
  version: string
  platform: Platform
}

export interface SelfRelease {
  version: string
  platform: Platform
}

/** 择源候选：节点资料 + 在线态 + 展示名（由 main 层从 PeerRegistry 投影）。 */
export interface SourceCandidate {
  profile: Profile
  online: boolean
  displayName: string
}

export interface UpdateRequester {
  profile: Profile
  online: boolean
}

export interface UpdateRequestAuthorization {
  nodeId: string
  version: string
  platform: Platform
  arch: RuntimeArch
}

interface PendingUpdateRequest extends UpdateRequestAuthorization {
  token: number
  expiresAt: number
}

const UPDATE_REQUEST_TTL_MS = 120_000

/** 用户确认后的短期一次性授权，只允许匹配来源与安装包进入隐藏传输。 */
export class UpdateRequestGate {
  private sequence = 0
  private pending: PendingUpdateRequest | null = null

  begin(request: UpdateRequestAuthorization, now = Date.now()): number {
    const token = ++this.sequence
    this.pending = { ...request, token, expiresAt: now + UPDATE_REQUEST_TTL_MS }
    return token
  }

  cancel(token: number): void {
    if (this.pending?.token === token) this.pending = null
  }

  consume(peerId: string, name: string, size: number, now = Date.now()): boolean {
    const pending = this.pending
    if (!pending) return false
    if (now >= pending.expiresAt) {
      this.pending = null
      return false
    }
    if (peerId !== pending.nodeId) return false
    if (!matchesUpdatePackageName(name, pending.version, pending.platform, pending.arch)) return false
    if (!Number.isSafeInteger(size) || size <= 0 || size > UPDATE_PACKAGE_MAX_BYTES) return false
    this.pending = null
    return true
  }
}

/**
 * 从候选里挑「同平台、声明可作更新源、版本严格高于本机」的最高版本在线节点。
 * 具体安装包架构在 update req / 本地包匹配阶段复核，避免 Linux x64/arm64 混用。
 * 无合适来源返回 null。
 */
export function pickUpdateSource(self: SelfRelease, candidates: SourceCandidate[]): UpdateSource | null {
  let best: UpdateSource | null = null
  for (const c of candidates) {
    if (!c.online) continue
    if (c.profile.platform !== self.platform) continue
    if (!Array.isArray(c.profile.caps) || !c.profile.caps.includes(CAPS.updateSource)) continue
    if (compareSemver(c.profile.ver, self.version) <= 0) continue
    if (best && compareSemver(c.profile.ver, best.version) <= 0) continue
    best = {
      nodeId: c.profile.nodeId,
      fromName: c.displayName || c.profile.nick,
      version: c.profile.ver,
      platform: c.profile.platform
    }
  }
  return best
}

/** A 端收到 B 的 update req 后的最小安全复核：同平台、在线、本机版本更高；安装包查找再按请求架构筛选。 */
export function shouldServeUpdateRequest(
  self: SelfRelease,
  requester: UpdateRequester | null | undefined,
  requestedPlatform: Platform
): boolean {
  if (!requester?.online) return false
  if (requestedPlatform !== self.platform) return false
  if (requester.profile.platform !== self.platform) return false
  return compareSemver(self.version, requester.profile.ver) > 0
}

export function findLocalUpdatePackage(opts: {
  dirs: string[]
  version: string
  platform: Platform
  arch?: RuntimeArch
}): string | null {
  for (const dir of opts.dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    const matches = names
      .filter((name) => matchesUpdatePackageName(name, opts.version, opts.platform, opts.arch))
      .sort()
    for (const name of matches) {
      const path = join(dir, name)
      try {
        const st = statSync(path)
        if (st.isFile() && st.size > 0) return path
      } catch {
        // 忽略扫描期间消失的文件
      }
    }
  }
  return null
}

export function matchesUpdatePackageName(
  name: string,
  version: string,
  platform: Platform,
  arch?: RuntimeArch
): boolean {
  if (platform === 'win') {
    if (arch) return name === `YangGe-${version}-win-${arch}-setup.exe`
    return (
      name === `YangGe-${version}-win-x64-setup.exe` ||
      name === `YangGe-${version}-win-ia32-setup.exe` ||
      name === `YangGe-${version}-win-arm64-setup.exe`
    )
  }
  if (platform === 'linux') {
    if (arch) {
      const debArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null
      if (!debArch) return false
      return name === `YangGe-${version}-linux-${debArch}.deb`
    }
    return (
      name === `YangGe-${version}-linux-amd64.deb` ||
      name === `YangGe-${version}-linux-arm64.deb`
    )
  }
  return false
}

const WIN_SETUP_PACKAGE_RE = /^YangGe-(\d+(?:\.\d+)+[^\\/]*)-win-(x64|ia32|arm64)-(setup|portable)\.exe$/

/** 从安装包文件名解析版本号（决议 #166 第三步：收包后提示可安装）；非安装包名返回 null。 */
export function updatePackageVersionFromName(name: string): string | null {
  const match = WIN_SETUP_PACKAGE_RE.exec(name)
  return match ? match[1] : null
}

/** 启动清理（决议 #328）：返回应删除的过期安装包名——版本严格低于当前版本的才算过期，
 *  当前版本（更新源自留）与更高版本（已拉取待装）一律保留；非安装包文件不动。 */
export function staleUpdatePackages(names: string[], currentVersion: string): string[] {
  const stale: string[] = []
  for (const name of names) {
    const version = updatePackageVersionFromName(name)
    if (version && compareSemver(version, currentVersion) < 0) stale.push(name)
  }
  return stale
}
