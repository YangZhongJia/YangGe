import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentProfileUpdate,
  AgentTaskCreateInput,
  AgentTaskDetailView,
  AgentTaskDiffView,
  AgentTaskView,
  AgentView
} from '../../../shared/ipc'
import { useAgentStore } from './agent'

const agent: AgentView = {
  id: 'agent-1',
  name: 'Codex',
  displayName: '',
  description: '',
  instructions: '',
  model: '',
  command: 'C:\\agents\\codex-acp.exe',
  args: [],
  cwd: 'C:\\project',
  version: '1.0.0',
  source: 'manual',
  probeError: '',
  enabled: true,
  createdAt: 1,
  lastUsedAt: 0,
  lastProbeTs: 1
}

const task: AgentTaskView = {
  id: 'task-1',
  prompt: '实现登录',
  repoPath: 'C:\\project',
  sourceBranch: 'main',
  baseCommit: 'a'.repeat(40),
  worktreePath: 'C:\\worktrees\\task-1',
  taskBranch: 'yangge/task-task-1',
  mode: 'git' as const,
  coordinatorAgentId: 'coordinator',
  teamAgentIds: ['implementer', 'reviewer'],
  status: 'draft',
  plan: null,
  reviewRound: 0,
  error: null,
  createdAt: 1,
  updatedAt: 1
}

const detail: AgentTaskDetailView = {
  task,
  steps: [],
  events: []
}

function installApi() {
  const api = {
    listAgentTasks: vi.fn(async () => [task]),
    createAgentTask: vi.fn(async (input: AgentTaskCreateInput) => ({
      ok: true as const,
      value: { ...task, prompt: input.prompt }
    })),
    getAgentTask: vi.fn(async () => detail),
    startAgentTask: vi.fn(async () => ({ ok: true as const, value: { ...task, status: 'planning' as const } })),
    approveAgentTaskPlan: vi.fn(async () => ({
      ok: true as const,
      value: { ...task, status: 'running' as const }
    })),
    pauseAgentTask: vi.fn(async () => ({ ok: true as const, value: { ...task, status: 'paused' as const } })),
    resumeAgentTask: vi.fn(async () => ({ ok: true as const, value: { ...task, status: 'running' as const } })),
    cancelAgentTask: vi.fn(async () => ({
      ok: true as const,
      value: { ...task, status: 'cancelled' as const }
    })),
    listAgentTaskEvents: vi.fn(async () => []),
    getAgentTaskDiff: vi.fn(async (): Promise<{
      ok: true
      value: AgentTaskDiffView
    }> => ({
      ok: true,
      value: {
        taskId: task.id,
        patch: 'diff --git a/a b/a',
        changedFiles: ['a'],
        bytes: 19,
        truncated: false
      }
    })),
    applyAgentTask: vi.fn(async () => ({ ok: true as const, value: null })),
    removeAgentTaskWorktree: vi.fn(async () => ({ ok: true as const, value: null })),
    respondAgentTaskPermission: vi.fn(async () => ({ ok: true as const, value: null })),
    listAgents: vi.fn(async () => [agent]),
    scanAgents: vi.fn(async () => ({
      ok: true as const,
      value: {
        agents: [agent],
        found: 1,
        clients: [],
        failures: [{ command: 'C:\\Tools\\opencode.cmd', error: 'ACP 握手失败：超时' }],
        scannedAt: 12_345
      }
    })),
    updateAgentProfile: vi.fn(async (input: AgentProfileUpdate) => ({
      ok: true as const,
      value: { ...agent, ...input }
    })),
    listAgentSessions: vi.fn(async () => [])
  }
  vi.stubGlobal('window', { pantry: api })
  return api
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('agent task store', () => {
  it('records scan completion time and names the failed executable', async () => {
    const api = installApi()
    const store = useAgentStore()

    await store.scan()

    expect(api.scanAgents).toHaveBeenCalledTimes(1)
    expect(store.agents).toEqual([agent])
    expect(store.scannedAt).toBe(12_345)
    expect(store.error).toContain('opencode.cmd')
    expect(store.error).toContain('超时')
  })

  it('replaces the saved local Agent profile in reactive state', async () => {
    const api = installApi()
    const store = useAgentStore()
    store.agents = [agent]
    store.sessions = [{
      id: 'session-1',
      agentId: agent.id,
      agentName: agent.name,
      acpSessionId: 'acp-1',
      cwd: 'C:\\project',
      title: agent.name,
      status: 'idle',
      createdAt: 1,
      updatedAt: 1
    }]
    const input: AgentProfileUpdate = {
      id: agent.id,
      displayName: 'Builder',
      description: '实现与测试',
      instructions: '先写测试。',
      model: '',
      enabled: false
    }

    await expect(store.updateAgentProfile(input)).resolves.toBe(true)

    expect(api.updateAgentProfile).toHaveBeenCalledWith(input)
    expect(store.agents).toEqual([{ ...agent, ...input }])
    expect(store.sessions[0]?.agentName).toBe('Builder')
  })

  it('loads and creates tasks while selecting the new room', async () => {
    const api = installApi()
    const store = useAgentStore()

    await store.refreshTasks()
    expect(store.tasks).toEqual([task])
    expect(store.activeTaskId).toBe(task.id)

    await store.createTask({
      repoPath: 'C:\\project',
      prompt: '实现新功能',
      coordinatorAgentId: 'coordinator',
      teamAgentIds: ['implementer', 'reviewer']
    })

    expect(api.createAgentTask).toHaveBeenCalled()
    expect(store.activeTask?.prompt).toBe('实现新功能')
  })

  it('projects task updates and ordered event refreshes into the active room', async () => {
    const api = installApi()
    const store = useAgentStore()
    await store.refreshTasks()

    store.applyTaskUpdate({ ...task, status: 'awaiting_approval' })
    await Promise.resolve()
    expect(store.activeTaskDetail?.task.status).toBe('awaiting_approval')
    expect(api.getAgentTask).toHaveBeenCalledWith(task.id)
  })

  it('routes plan approval, pause, resume, and cancellation through task id', async () => {
    const api = installApi()
    const store = useAgentStore()
    await store.refreshTasks()

    await store.approvePlan(task.id)
    await store.pauseTask(task.id)
    await store.resumeTask(task.id)
    await store.cancelTask(task.id)

    expect(api.approveAgentTaskPlan).toHaveBeenCalledWith(task.id)
    expect(api.pauseAgentTask).toHaveBeenCalledWith(task.id)
    expect(api.resumeAgentTask).toHaveBeenCalledWith(task.id)
    expect(api.cancelAgentTask).toHaveBeenCalledWith(task.id)
  })

  it('loads and applies a reviewed diff, then exposes worktree cleanup', async () => {
    const api = installApi()
    const store = useAgentStore()
    await store.refreshTasks()

    await store.loadTaskDiff(task.id)
    expect(store.taskDiff?.changedFiles).toEqual(['a'])
    await store.applyTask(task.id)
    await store.removeTaskWorktree(task.id)

    expect(api.applyAgentTask).toHaveBeenCalledWith(task.id)
    expect(api.removeAgentTaskWorktree).toHaveBeenCalledWith(task.id)
  })

  it('uses the task-scoped permission endpoint', async () => {
    const api = installApi()
    const store = useAgentStore()
    store.taskPermissions.push({
      taskId: task.id,
      request: {
        requestId: 'perm-1',
        sessionId: 'session-1',
        runId: null,
        toolCallId: 'tool-1',
        title: '写入',
        toolKind: 'edit',
        status: 'pending',
        locations: [],
        command: '',
        options: [],
        createdAt: 1
      }
    })

    await store.respondTaskPermission(task.id, 'perm-1', 'allow_once')

    expect(api.respondAgentTaskPermission).toHaveBeenCalledWith(
      task.id,
      'perm-1',
      'allow_once'
    )
    expect(store.taskPermissions).toHaveLength(0)
  })
})
