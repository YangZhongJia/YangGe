import { basename } from 'node:path'
import type { AgentView } from '../../../shared/ipc'

// Agent 档案对账（纯函数）：扫描结果与已存档案在 id 变化 / 条目消失时的迁移与清理计划。
// 背景：agent id 由命令路径 sha1 派生；旧版本在 Windows 上把 npm 的无扩展名 POSIX 垫片
// 当成可执行文件落库（spawn 必 ENOENT），修正为 .cmd/.exe 后 id 会变化——按「名称 + 命令
// 主名」把用户档案迁移到新行；不再被扫描命中的自动发现条目移除，手动添加的 Agent 永久保留。

export interface AgentReconcilePlan {
  /** 旧行 → 新行：把旧行的本地档案（显示名/简介/角色提示词/启用状态）迁移到新行后删除旧行 */
  migrate: Array<{ staleId: string; keepId: string }>
  /** 磁盘上已不存在或被更优入口取代的自动发现条目 */
  remove: string[]
}

const EXECUTABLE_EXTENSION = /\.(exe|cmd|bat|com)$/i

function legacyKey(agent: AgentView): string {
  return `${agent.name}\u0000${basename(agent.command).replace(EXECUTABLE_EXTENSION, '').toLowerCase()}`
}

/**
 * @param stored        本次扫描 upsert 之后库里的全部 Agent（手动 + 自动发现）
 * @param discoveredIds 本次扫描命中的全部命令 id（含 ACP 握手失败的条目）
 * @param freshIds      本次 ACP 握手通过、可用的 Agent id
 */
export function planAgentReconcile(
  stored: readonly AgentView[],
  discoveredIds: readonly string[],
  freshIds: readonly string[]
): AgentReconcilePlan {
  const discovered = new Set(discoveredIds)
  const fresh = new Set(freshIds)

  // 旧行候选只取「非 fresh」的自动发现条目：同一主名下若新行已在库，
  // 迁移方向必须是从旧行指向新行，不能依赖列表顺序。
  const staleByKey = new Map<string, AgentView>()
  for (const agent of stored) {
    if (agent.source === 'manual' || fresh.has(agent.id)) continue
    const key = legacyKey(agent)
    if (!staleByKey.has(key)) staleByKey.set(key, agent)
  }

  const migrate: AgentReconcilePlan['migrate'] = []
  const migrated = new Set<string>()
  for (const agent of stored) {
    if (!fresh.has(agent.id)) continue
    const stale = staleByKey.get(legacyKey(agent))
    if (!stale || stale.id === agent.id) continue
    migrate.push({ staleId: stale.id, keepId: agent.id })
    migrated.add(stale.id)
  }

  const remove = stored
    .filter((agent) => agent.source !== 'manual' && !discovered.has(agent.id) && !migrated.has(agent.id))
    .map((agent) => agent.id)

  return { migrate, remove }
}
