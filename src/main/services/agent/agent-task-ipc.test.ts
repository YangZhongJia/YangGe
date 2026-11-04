import { describe, expect, it, vi } from 'vitest'
import type {
  AgentPermissionDecision,
  AgentResult,
  AgentTaskCreateInput,
  AgentTaskEventView,
  AgentTaskStepView,
  AgentTaskView
} from '../../../shared/ipc'
import { AgentTaskIpcController } from './agent-task-ipc'

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

function ok<T>(value: T): AgentResult<T> {
  return { ok: true, value }
}

function createHarness() {
  const calls: string[] = []
  const coordinator = {
    createTask: vi.fn(async (input: AgentTaskCreateInput) => {
      calls.push('create')
      return ok({ ...task, prompt: input.prompt })
    }),
    start: vi.fn(async () => {
      calls.push('start')
      return ok({ ...task, status: 'planning' as const })
    }),
    approvePlan: vi.fn(async () => ok(task)),
    pause: vi.fn(async () => ok(task)),
    resume: vi.fn(async () => ok(task)),
    cancel: vi.fn(async () => ok(task)),
    chat: vi.fn(async () => ok({} as AgentTaskEventView)),
    respondPermission: vi.fn(
      async (taskId: string, requestId: string, decision: AgentPermissionDecision) => {
        calls.push(`permission:${taskId}:${requestId}:${decision}`)
        return ok(null)
      }
    ),
    apply: vi.fn(async () => ok(null)),
    removeWorktree: vi.fn(async () => ok(null)),
    recoverInterruptedTasks: vi.fn(() => 0)
  }
  const store = {
    listTasks: vi.fn(() => [task]),
    getTask: vi.fn((id: string) => id === task.id ? task : null),
    listSteps: vi.fn((): AgentTaskStepView[] => []),
    listEvents: vi.fn((): AgentTaskEventView[] => [])
  }
  const workspaces = {
    buildPatch: vi.fn(async () => Buffer.from('diff --git a/a b/a\n')),
    listChangedFiles: vi.fn(async () => ['a'])
  }
  return {
    calls,
    coordinator,
    store,
    workspaces,
    controller: new AgentTaskIpcController({
      store,
      coordinator,
      workspaces
    })
  }
}

describe('AgentTaskIpcController', () => {
  it('rejects malformed creation payloads before touching the coordinator', async () => {
    const { controller, coordinator } = createHarness()

    await expect(controller.create({
      repoPath: 'relative/path',
      prompt: '实现登录',
      coordinatorAgentId: 'coordinator',
      teamAgentIds: ['implementer', 'reviewer']
    })).resolves.toMatchObject({ ok: false })
    await expect(controller.create({
      repoPath: 'C:\\project',
      prompt: ' ',
      coordinatorAgentId: 'coordinator',
      teamAgentIds: ['implementer', 'reviewer']
    })).resolves.toMatchObject({ ok: false })
    await expect(controller.create({
      repoPath: 'C:\\project',
      prompt: '实现登录',
      coordinatorAgentId: 'coordinator',
      teamAgentIds: ['implementer', 'implementer']
    })).resolves.toMatchObject({ ok: false })

    expect(coordinator.createTask).not.toHaveBeenCalled()
  })

  it('returns bounded task details and no fake data for unknown tasks', () => {
    const { controller, store } = createHarness()

    expect(controller.list(10_000)).toEqual([task])
    expect(store.listTasks).toHaveBeenCalledWith(200)
    expect(controller.get('missing-task')).toBeNull()
    expect(controller.events('missing-task', 10)).toEqual([])
  })

  it('forwards task ownership and the permission decision unchanged', async () => {
    const { controller, coordinator, calls } = createHarness()

    const result = await controller.respondPermission(
      'task-1',
      'perm_123',
      'allow_once'
    )

    expect(result).toEqual(ok(null))
    expect(calls).toContain('permission:task-1:perm_123:allow_once')
    expect(coordinator.respondPermission).toHaveBeenCalledWith(
      'task-1',
      'perm_123',
      'allow_once'
    )
  })

  it('returns coordinator state errors instead of bypassing transitions', async () => {
    const { controller, coordinator } = createHarness()
    coordinator.start.mockResolvedValueOnce({ ok: false, error: 'task_not_startable' })

    await expect(controller.start('task-1')).resolves.toEqual({
      ok: false,
      error: 'task_not_startable'
    })
    expect(coordinator.start).toHaveBeenCalledWith('task-1')
  })

  it('returns a reviewable diff and refuses an empty one', async () => {
    const { controller, workspaces } = createHarness()

    await expect(controller.diff('task-1')).resolves.toMatchObject({
      ok: true,
      value: { taskId: 'task-1', changedFiles: ['a'], truncated: false }
    })

    workspaces.buildPatch.mockResolvedValueOnce(Buffer.alloc(0))
    await expect(controller.diff('task-1')).resolves.toEqual({
      ok: false,
      error: 'patch_empty'
    })
  })

  it('validates task group chat messages and forwards them to the coordinator', async () => {
    const { controller, coordinator } = createHarness()

    await expect(controller.chat('task-1', '   ')).resolves.toEqual({
      ok: false,
      error: 'task_chat_invalid'
    })
    await expect(controller.chat('bad id!', '你好')).resolves.toEqual({
      ok: false,
      error: 'invalid_task_id'
    })
    expect(coordinator.chat).not.toHaveBeenCalled()

    await expect(controller.chat('task-1', '请先说说你的分工计划')).resolves.toMatchObject({
      ok: true
    })
    expect(coordinator.chat).toHaveBeenCalledWith('task-1', '请先说说你的分工计划')
  })

  it('rejects worktree cleanup while a task is active', async () => {
    const { controller, coordinator } = createHarness()
    coordinator.removeWorktree.mockResolvedValueOnce({
      ok: false,
      error: 'task_is_active'
    })

    await expect(controller.removeWorktree('task-1')).resolves.toEqual({
      ok: false,
      error: 'task_is_active'
    })
  })
})
