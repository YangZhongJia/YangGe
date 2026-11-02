import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../components/AgentPane.vue', import.meta.url),
  'utf8'
)
const storeSource = readFileSync(
  new URL('../stores/agent.ts', import.meta.url),
  'utf8'
)

describe('Agent task room', () => {
  it('lets each Agent edit its display name, local description, role prompt, and enabled state', () => {
    expect(source).toContain('openAgentSettings(agent)')
    expect(source).toContain("tr('显示名称')")
    expect(source).toContain("tr('简介')")
    expect(source).toContain("tr('角色提示词')")
    expect(source).toContain('v-model:checked="settingsEnabled"')
    expect(source).toContain('store.updateAgentProfile({')
    expect(source).toContain('只在本机界面展示，不会自动发送给模型。')
    expect(source).toContain('角色提示词会随任务内容发送给该 CLI 配置的模型供应商')
    expect(source).toContain('它不是工具授权，也不是系统沙箱')
  })

  it('keeps the existing single-agent chat available as a separate mode', () => {
    expect(source).toContain("mode === 'tasks'")
    expect(source).toContain("mode === 'chat'")
    expect(source).toContain('{{ tr(\'单聊\') }}')
  })

  it('requires a Git repository and explains the clean-tree and provider boundary', () => {
    expect(source).toContain('{{ tr(\'选择 Git 仓库\') }}')
    expect(source).toContain('仓库必须干净')
    expect(source).toContain('任务内容可能由对应 Agent CLI 发送给其模型供应商')
    expect(source).toContain('worktree')
  })

  it('shows base CLIs separately with actionable ACP adapter guidance', () => {
    expect(source).toContain("store.clients.filter((item) => !item.adapterReady)")
    expect(source).toContain("{{ tr('需要 ACP 适配器') }}")
    expect(source).toContain('client.adapterCommand')
  })

  it('shows the coordinator, selected team, plan phases, timeline, and task permissions', () => {
    expect(source).toContain('{{ tr(\'协调者\') }}')
    expect(source).toContain('{{ tr(\'团队\') }}')
    expect(source).toContain('v-for="step in activeTaskDetail.steps"')
    expect(source).toContain('v-for="event in activeTaskDetail.events"')
    expect(source).toContain('respondTaskPermission')
    expect(source).toContain("respondTaskPermission('allow_session')")
  })

  it('requires an explicit review confirmation before applying a diff', () => {
    expect(source).toContain('loadTaskDiff')
    expect(source).toContain('v-for="file in taskDiff.changedFiles"')
    expect(source).toContain('applyConfirmed')
    expect(source).toContain('我已检查以上差异，并确认应用到源仓库')
    expect(storeSource).toContain('async applyTask(')
    expect(storeSource).toContain('async removeTaskWorktree(')
  })
})
