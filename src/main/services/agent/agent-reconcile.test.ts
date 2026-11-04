import { describe, expect, it } from 'vitest'
import type { AgentView } from '../../../shared/ipc'
import { planAgentReconcile } from './agent-reconcile'

function agent(overrides: Partial<AgentView> & Pick<AgentView, 'id' | 'command'>): AgentView {
  return {
    name: 'OpenCode',
    displayName: '',
    description: '',
    instructions: '',
    model: '',
    args: ['acp'],
    cwd: 'C:\\Users\\me',
    version: '',
    source: 'path',
    probeError: '',
    enabled: true,
    createdAt: 0,
    lastUsedAt: 0,
    lastProbeTs: 0,
    ...overrides
  }
}

// 旧版本落库的 npm 无扩展名垫片 vs 修正后的 .cmd 入口（同一主名，id 因命令路径变化）
const shim = agent({ id: 'agent_shim', command: 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode' })
const fixed = agent({ id: 'agent_cmd', command: 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd' })

describe('Agent 扫描对账计划', () => {
  it('垫片旧行迁移到 .cmd 新行：档案迁移、旧行不进入删除清单', () => {
    const plan = planAgentReconcile([shim, fixed], [fixed.id], [fixed.id])
    expect(plan).toEqual({ migrate: [{ staleId: shim.id, keepId: fixed.id }], remove: [] })
  })

  it('新行已在库且无旧行时不产生迁移', () => {
    expect(planAgentReconcile([fixed], [fixed.id], [fixed.id])).toEqual({ migrate: [], remove: [] })
  })

  it('迁移方向只从旧行指向新行，不依赖库内顺序', () => {
    expect(planAgentReconcile([fixed, shim], [fixed.id], [fixed.id])).toEqual({
      migrate: [{ staleId: shim.id, keepId: fixed.id }],
      remove: []
    })
  })

  it('不再被扫描命中的自动发现条目被清理，手动 Agent 永久保留', () => {
    const manual = agent({ id: 'agent_manual', command: 'D:\\tools\\my-agent.exe', source: 'manual' })
    const gone = agent({ id: 'agent_gone', name: 'Gone', command: 'C:\\old\\opencode.exe' })
    const plan = planAgentReconcile([manual, gone], [fixed.id], [fixed.id])
    expect(plan.remove).toEqual([gone.id])
  })

  it('新入口 ACP 握手失败（不在 fresh）时不迁移，旧条目按发现集合外清理', () => {
    const plan = planAgentReconcile([shim], [fixed.id], [])
    expect(plan).toEqual({ migrate: [], remove: [shim.id] })
  })

  it('握手失败的条目本身仍在发现集合内，不会被误删', () => {
    const flaky = agent({ id: 'agent_flaky', name: 'Flaky', command: 'C:\\tools\\flaky.cmd' })
    const plan = planAgentReconcile([flaky], [flaky.id], [])
    expect(plan).toEqual({ migrate: [], remove: [] })
  })
})
