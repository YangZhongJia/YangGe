import { describe, expect, it } from 'vitest'
import {
  IpcEvents,
  type AgentCoordinatorPlan,
  type AgentPermissionDecision,
  type AgentResult,
  type AgentRunResult,
  type AgentSessionView,
  type AgentTaskCreateInput,
  type AgentTaskEventView,
  type AgentTaskStepView,
  type AgentTaskView,
  type AgentView,
  type TaskWorkspace
} from '../../../shared/ipc'
import {
  AgentCoordinator,
  type AgentCoordinatorRuntime,
  type AgentTaskStore
} from './agent-coordinator'
import type { AgentTaskRecordInput } from '../../store/agent-task-repo'

const COORDINATOR = 'agent-coordinator'
const IMPLEMENTER = 'agent-implementer'
const REVIEWER = 'agent-reviewer'
const RESEARCHER = 'agent-researcher'

function agent(id: string): AgentView {
  return {
    id,
    name: id,
    command: `/agents/${id}`,
    args: [],
    cwd: '',
    version: '1.0.0',
    source: 'manual',
    probeError: '',
    enabled: true,
    createdAt: 1,
    lastUsedAt: 0,
    lastProbeTs: 1
  }
}

function createInput(nonce = 'login'): AgentTaskCreateInput {
  return {
    repoPath: 'C:\\project',
    prompt: `修复${nonce}流程`,
    coordinatorAgentId: COORDINATOR,
    teamAgentIds: [IMPLEMENTER, REVIEWER, RESEARCHER]
  }
}

function plan(
  steps: AgentCoordinatorPlan['steps'] = [
    {
      id: 'implement-1',
      title: '实现',
      role: 'implement',
      agentId: IMPLEMENTER,
      dependsOn: [],
      input: '实现登录修复',
      expectedOutput: '代码完成'
    },
    {
      id: 'review-1',
      title: '审查',
      role: 'review',
      agentId: REVIEWER,
      dependsOn: ['implement-1'],
      input: '审查改动',
      expectedOutput: '审查结论'
    },
    {
      id: 'implement-2',
      title: '修订',
      role: 'implement',
      agentId: IMPLEMENTER,
      dependsOn: ['review-1'],
      input: '处理审查意见',
      expectedOutput: '修订完成'
    },
    {
      id: 'review-2',
      title: '复审',
      role: 'review',
      agentId: REVIEWER,
      dependsOn: ['implement-2'],
      input: '复审修订',
      expectedOutput: '最终审查结论'
    }
  ]
): AgentCoordinatorPlan {
  return { summary: '分两轮实现和审查登录修复', steps }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

class MemoryTaskStore implements AgentTaskStore {
  readonly tasks = new Map<string, AgentTaskView>()
  readonly steps = new Map<string, AgentTaskStepView>()
  readonly events = new Map<string, AgentTaskEventView[]>()

  createTask(input: AgentTaskRecordInput): AgentTaskView {
    const value: AgentTaskView = {
      ...clone(input),
      status: 'draft',
      plan: null,
      reviewRound: 0,
      error: null,
      updatedAt: input.createdAt
    }
    this.tasks.set(value.id, value)
    return clone(value)
  }

  getTask(id: string): AgentTaskView | null {
    const value = this.tasks.get(id)
    return value ? clone(value) : null
  }

  listTasks(limit = 50): AgentTaskView[] {
    return [...this.tasks.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
      .map(clone)
  }

  updateTask(id: string, patch: Parameters<AgentTaskStore['updateTask']>[1]): AgentTaskView | null {
    const current = this.tasks.get(id)
    if (!current) return null
    const value: AgentTaskView = {
      ...current,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'plan') ? { plan: patch.plan ?? null } : {}),
      ...(patch.reviewRound !== undefined ? { reviewRound: patch.reviewRound } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'error') ? { error: patch.error ?? null } : {}),
      updatedAt: patch.updatedAt ?? Date.now()
    }
    this.tasks.set(id, value)
    return clone(value)
  }

  replacePlan(
    taskId: string,
    nextPlan: AgentCoordinatorPlan,
    nextSteps: AgentTaskStepView[]
  ): AgentTaskView | null {
    const current = this.tasks.get(taskId)
    if (!current) return null
    for (const [id, step] of this.steps) if (step.taskId === taskId) this.steps.delete(id)
    for (const step of nextSteps) this.steps.set(step.id, clone(step))
    const value: AgentTaskView = {
      ...current,
      plan: clone(nextPlan),
      status: 'awaiting_approval',
      error: null,
      updatedAt: Date.now()
    }
    this.tasks.set(taskId, value)
    return clone(value)
  }

  createStep(step: AgentTaskStepView): AgentTaskStepView {
    this.steps.set(step.id, clone(step))
    return clone(step)
  }

  listSteps(taskId: string): AgentTaskStepView[] {
    return [...this.steps.values()]
      .filter((step) => step.taskId === taskId)
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(clone)
  }

  updateStep(id: string, patch: Parameters<AgentTaskStore['updateStep']>[1]): AgentTaskStepView | null {
    const current = this.steps.get(id)
    if (!current) return null
    const value = { ...current, ...clone(patch), updatedAt: patch.updatedAt ?? Date.now() }
    this.steps.set(id, value)
    return clone(value)
  }

  appendEvent(event: AgentTaskEventView): void {
    const list = this.events.get(event.taskId) ?? []
    if (!list.some((item) => item.id === event.id)) list.push(clone(event))
    this.events.set(event.taskId, list)
  }

  listEvents(taskId: string, limit = 500): AgentTaskEventView[] {
    return (this.events.get(taskId) ?? [])
      .slice()
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(clone)
  }
}

class MemoryWorkspace {
  createCalls: Array<{ taskId: string; repoPath: string }> = []
  applyCalls: string[] = []
  removeCalls: string[] = []
  patch = Buffer.from('diff --git a/a b/a\n')

  async create(taskId: string, repoPath: string): Promise<TaskWorkspace> {
    this.createCalls.push({ taskId, repoPath })
    return {
      repoRoot: repoPath,
      sourceBranch: 'main',
      baseCommit: 'a'.repeat(40),
      worktreePath: `C:\\worktrees\\${taskId}`,
      taskBranch: `yangge/task-${taskId}`
    }
  }

  async buildPatch(): Promise<Buffer> {
    return Buffer.from(this.patch)
  }

  async listChangedFiles(): Promise<string[]> {
    return ['a']
  }

  async apply(taskId: string): Promise<void> {
    this.applyCalls.push(taskId)
  }

  async remove(taskId: string): Promise<void> {
    this.removeCalls.push(taskId)
  }
}

class MemoryAgents implements AgentCoordinatorRuntime {
  readonly agents = [COORDINATOR, IMPLEMENTER, REVIEWER, RESEARCHER].map(agent)
  readonly prompts: Array<{ agentId: string; sessionId: string; text: string }> = []
  readonly sessions = new Map<string, string>()
  readonly pendingPermissions = new Map<string, { sessionId: string; decision?: AgentPermissionDecision }>()
  readonly outputs = new Map<string, string[]>()
  readonly blockers = new Map<string, { promise: Promise<string>; output: string }>()
  readonly sessionCreated: string[] = []
  readonly closedSessions: string[] = []
  readonly cancelledSessions: string[] = []
  maxActivePrompts = 0
  activePrompts = 0

  private listeners = new Set<(channel: string, payload: unknown) => void>()
  private sequence = 0

  queue(agentId: string, output: string): void {
    const queue = this.outputs.get(agentId) ?? []
    queue.push(output)
    this.outputs.set(agentId, queue)
  }

  blockNext(agentId: string, output: string): () => void {
    let release = (): void => {}
    const blocker = new Promise<string>((resolve) => {
      release = () => resolve(output)
    })
    this.blockers.set(agentId, { promise: blocker, output })
    return release
  }

  listAgents(): AgentView[] {
    return clone(this.agents)
  }

  async newSession(agentId: string): Promise<AgentResult<AgentSessionView>> {
    if (!this.agents.some((item) => item.id === agentId)) {
      return { ok: false, error: 'agent_not_found' }
    }
    const id = `session-${++this.sequence}`
    this.sessions.set(id, agentId)
    this.sessionCreated.push(id)
    return {
      ok: true,
      value: {
        id,
        agentId,
        agentName: agentId,
        acpSessionId: `acp-${id}`,
        cwd: 'C:\\worktrees\\task',
        title: agentId,
        status: 'idle',
        createdAt: 1,
        updatedAt: 1
      }
    }
  }

  async prompt(sessionId: string, text: string): Promise<AgentResult<AgentRunResult>> {
    const agentId = this.sessions.get(sessionId)!
    this.prompts.push({ agentId, sessionId, text })
    this.activePrompts += 1
    this.maxActivePrompts = Math.max(this.maxActivePrompts, this.activePrompts)
    try {
      const blocked = this.blockers.get(agentId)
      if (blocked) {
        this.blockers.delete(agentId)
        await blocked.promise
      }
      const output = blocked?.output ?? this.outputs.get(agentId)?.shift() ?? `${agentId} completed`
      this.emit(IpcEvents.agentUpdate, {
        sessionId,
        runId: null,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: output.slice(0, Math.ceil(output.length / 2)) }
        }
      })
      this.emit(IpcEvents.agentUpdate, {
        sessionId,
        runId: null,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: output.slice(Math.ceil(output.length / 2)) }
        }
      })
      return { ok: true, value: { runId: `run-${sessionId}`, stopReason: 'end_turn' } }
    } finally {
      this.activePrompts -= 1
    }
  }

  cancel(sessionId: string): void {
    this.cancelledSessions.push(sessionId)
    const agentId = this.sessions.get(sessionId)
    if (agentId) {
      const blocked = this.blockers.get(agentId)
      if (blocked) blocked.promise.then(() => undefined)
    }
  }

  async respondPermission(requestId: string, decision: AgentPermissionDecision): Promise<AgentResult<null>> {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return { ok: false, error: 'permission_not_found' }
    pending.decision = decision
    return { ok: true, value: null }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.closedSessions.push(sessionId)
  }

  subscribe(listener: (channel: string, payload: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  requestPermission(sessionId: string, requestId: string): void {
    this.pendingPermissions.set(requestId, { sessionId })
    this.emit(IpcEvents.agentPermissionRequest, {
      requestId,
      sessionId,
      runId: null,
      toolCallId: 'tool-1',
      title: '写入文件',
      toolKind: 'edit',
      status: 'pending',
      locations: [],
      command: '',
      options: [],
      createdAt: 1
    })
  }

  currentSessionFor(agentId: string): string | null {
    return this.sessionCreated.find((id) => this.sessions.get(id) === agentId) ?? null
  }

  private emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners) listener(channel, payload)
  }
}

function value<T>(result: AgentResult<T>): T {
  expect(result.ok).toBe(true)
  return (result as { ok: true; value: T }).value
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timeout_waiting_for_${label}`)
}

function harness() {
  const store = new MemoryTaskStore()
  const agents = new MemoryAgents()
  const workspaces = new MemoryWorkspace()
  const emitted: Array<{ channel: string; payload: unknown }> = []
  let sequence = 0
  const coordinator = new AgentCoordinator({
    store,
    agents,
    workspaces,
    emit: (channel, payload) => emitted.push({ channel, payload }),
    now: () => 100,
    id: () => `generated-${++sequence}`
  })
  return { store, agents, workspaces, coordinator, emitted }
}

async function createTask(
  coordinator: AgentCoordinator,
  input = createInput()
): Promise<AgentTaskView> {
  return value(await coordinator.createTask(input))
}

describe('AgentCoordinator', () => {
  it('validates the selected coordinator and team before creating a worktree', async () => {
    const { coordinator, workspaces } = harness()
    const invalid = await coordinator.createTask({
      ...createInput(),
      teamAgentIds: [IMPLEMENTER, 'agent-missing']
    })
    expect(invalid.ok).toBe(false)
    expect(workspaces.createCalls).toHaveLength(0)

    const created = await createTask(coordinator)
    expect(created).toMatchObject({
      status: 'draft',
      coordinatorAgentId: COORDINATOR,
      teamAgentIds: [IMPLEMENTER, REVIEWER, RESEARCHER],
      sourceBranch: 'main'
    })
    expect(workspaces.createCalls).toEqual([
      { taskId: created.id, repoPath: 'C:\\project' }
    ])
  })

  it('rejects malformed, oversized, unknown, cyclic, single-agent, and over-round plans', async () => {
    const valid = plan()
    const invalidPlans = [
      'not json',
      JSON.stringify(plan(Array.from({ length: 6 }, (_item, index) => ({
        ...valid.steps[0],
        id: `step-${index}`,
        title: `步骤 ${index}`
      })))),
      JSON.stringify(plan([{ ...valid.steps[0], agentId: 'agent-missing' }])),
      JSON.stringify(plan([
        { ...valid.steps[0], dependsOn: ['cycle-2'] },
        { ...valid.steps[1], id: 'cycle-2', dependsOn: ['implement-1'] }
      ])),
      JSON.stringify(plan([
        valid.steps[0],
        { ...valid.steps[1], agentId: IMPLEMENTER }
      ])),
      JSON.stringify(plan([
        valid.steps[0],
        valid.steps[1],
        valid.steps[2],
        valid.steps[3],
        { ...valid.steps[3], id: 'review-3', dependsOn: ['review-2'] }
      ]))
    ]

    for (const output of invalidPlans) {
      const { coordinator, store, agents } = harness()
      agents.queue(COORDINATOR, output)
      const created = await createTask(coordinator)
      value(await coordinator.start(created.id))
      await waitFor(() => store.getTask(created.id)?.status === 'failed', 'invalid plan')
      expect(store.listSteps(created.id)).toHaveLength(0)
      expect(agents.prompts.some((prompt) => prompt.agentId === IMPLEMENTER)).toBe(false)
    }
  })

  it('waits for plan approval, hands results forward, and enforces one writer', async () => {
    const { coordinator, store, agents } = harness()
    agents.queue(COORDINATOR, JSON.stringify(plan()))
    agents.queue(IMPLEMENTER, 'implemented login v1')
    agents.queue(REVIEWER, 'review found missing test')
    agents.queue(IMPLEMENTER, 'implemented login v2')
    agents.queue(REVIEWER, 'review approved')

    const created = await createTask(coordinator)
    value(await coordinator.start(created.id))
    await waitFor(() => store.getTask(created.id)?.status === 'awaiting_approval', 'plan approval')
    expect(agents.prompts.filter((prompt) => prompt.agentId === IMPLEMENTER)).toHaveLength(0)
    expect(store.listSteps(created.id).every((step) => step.status === 'queued')).toBe(true)

    value(await coordinator.approvePlan(created.id))
    await waitFor(() => store.getTask(created.id)?.status === 'completed', 'task completion')

    const task = store.getTask(created.id)!
    expect(task.reviewRound).toBe(2)
    expect(task.error).toBeNull()
    expect(store.listSteps(created.id).every((step) => step.status === 'completed')).toBe(true)
    expect(agents.maxActivePrompts).toBe(1)
    const workerPrompts = agents.prompts.filter((prompt) => prompt.agentId !== COORDINATOR)
    expect(workerPrompts.map((prompt) => prompt.agentId)).toEqual([
      IMPLEMENTER,
      REVIEWER,
      IMPLEMENTER,
      REVIEWER
    ])
    expect(workerPrompts[1].text).toContain('implemented login v1')
    expect(workerPrompts[2].text).toContain('review found missing test')
  })

  it('persists an ACP request before waiting for the Agent response', async () => {
    const { coordinator, store, agents } = harness()
    const releasePlan = agents.blockNext(COORDINATOR, JSON.stringify(plan()))
    const created = await createTask(coordinator)
    value(await coordinator.start(created.id))
    await waitFor(() => agents.prompts.some((prompt) => prompt.agentId === COORDINATOR), 'plan prompt')

    expect(store.listEvents(created.id).some((event) => event.kind === 'plan_request')).toBe(true)
    releasePlan()
    await waitFor(
      () => ['awaiting_approval', 'failed'].includes(store.getTask(created.id)?.status ?? ''),
      'plan result'
    )
    expect(store.getTask(created.id)?.error).toBeNull()
    expect(store.getTask(created.id)?.status).toBe('awaiting_approval')
  })

  it('pauses after the active prompt and resumes from completed work', async () => {
    const { coordinator, store, agents } = harness()
    const shortPlan = plan(plan().steps.slice(0, 2))
    agents.queue(COORDINATOR, JSON.stringify(shortPlan))
    const release = agents.blockNext(IMPLEMENTER, 'implementation finished')
    agents.queue(REVIEWER, 'review finished')
    const created = await createTask(coordinator)
    value(await coordinator.start(created.id))
    await waitFor(() => store.getTask(created.id)?.status === 'awaiting_approval', 'approval')
    value(await coordinator.approvePlan(created.id))
    await waitFor(() => agents.prompts.some((prompt) => prompt.agentId === IMPLEMENTER), 'implement prompt')

    value(await coordinator.pause(created.id))
    release()
    await waitFor(() => store.listSteps(created.id)[0]?.status === 'completed', 'active step')
    expect(store.getTask(created.id)?.status).toBe('paused')
    expect(store.listSteps(created.id)[1].status).toBe('queued')

    value(await coordinator.resume(created.id))
    await waitFor(() => store.getTask(created.id)?.status === 'completed', 'resumed completion')
  })

  it('cancels the active session and queued work without starting a duplicate run', async () => {
    const { coordinator, store, agents } = harness()
    agents.queue(COORDINATOR, JSON.stringify(plan(plan().steps.slice(0, 2))))
    const release = agents.blockNext(IMPLEMENTER, 'late output')
    const created = await createTask(coordinator)
    value(await coordinator.start(created.id))
    await waitFor(() => store.getTask(created.id)?.status === 'awaiting_approval', 'approval')
    value(await coordinator.approvePlan(created.id))
    await waitFor(() => agents.prompts.some((prompt) => prompt.agentId === IMPLEMENTER), 'implement prompt')

    expect(value(await coordinator.cancel(created.id)).status).toBe('cancelled')
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(agents.cancelledSessions.length).toBeGreaterThan(0)
    expect(store.getTask(created.id)?.status).toBe('cancelled')
    expect(store.listSteps(created.id).every((step) => step.status === 'cancelled')).toBe(true)
    expect(agents.prompts.some((prompt) => prompt.agentId === REVIEWER)).toBe(false)
  })

  it('restarts an interrupted step in a new session with saved transcript context', async () => {
    const { coordinator, store, agents, workspaces } = harness()
    agents.queue(COORDINATOR, JSON.stringify(plan(plan().steps.slice(0, 2))))
    const created = await createTask(coordinator)
    value(await coordinator.start(created.id))
    await waitFor(() => store.getTask(created.id)?.status === 'awaiting_approval', 'approval')
    const steps = store.listSteps(created.id)
    store.updateTask(created.id, { status: 'running' })
    store.updateStep(steps[0].id, { status: 'running', sessionId: 'dead-session' })
    store.appendEvent({
      id: 'prior-event',
      taskId: created.id,
      stepId: steps[0].id,
      kind: 'agent',
      agentId: IMPLEMENTER,
      text: 'saved transcript before restart',
      createdAt: 2
    })

    agents.queue(IMPLEMENTER, 'implementation recovered')
    agents.queue(REVIEWER, 'review recovered')
    const restarted = new AgentCoordinator({
      store,
      agents,
      workspaces,
      now: () => 200,
      id: () => 'restart-generated'
    })
    value(await restarted.resume(created.id))
    await waitFor(() => store.getTask(created.id)?.status === 'completed', 'recovered completion')
    const implementationPrompt = agents.prompts
      .filter((prompt) => prompt.agentId === IMPLEMENTER)
      .at(-1)
    expect(implementationPrompt?.sessionId).not.toBe('dead-session')
    expect(implementationPrompt?.text).toContain('saved transcript before restart')
    expect(store.listEvents(created.id).some((event) => event.kind === 'recovery')).toBe(true)
  })

  it('routes permission responses only through the task that owns the request', async () => {
    const { coordinator, store, agents } = harness()
    agents.queue(COORDINATOR, JSON.stringify(plan(plan().steps.slice(0, 2))))
    const release = agents.blockNext(IMPLEMENTER, 'permissioned implementation')
    agents.queue(REVIEWER, 'approved')
    const created = await createTask(coordinator)
    value(await coordinator.start(created.id))
    await waitFor(() => store.getTask(created.id)?.status === 'awaiting_approval', 'approval')
    value(await coordinator.approvePlan(created.id))
    await waitFor(() => agents.prompts.some((prompt) => prompt.agentId === IMPLEMENTER), 'implement prompt')
    const sessionId = agents.currentSessionFor(IMPLEMENTER)!
    agents.requestPermission(sessionId, 'permission-1')

    expect((await coordinator.respondPermission('other-task', 'permission-1', 'allow_once')).ok).toBe(false)
    expect(agents.pendingPermissions.get('permission-1')?.decision).toBeUndefined()
    expect((await coordinator.respondPermission(created.id, 'permission-1', 'allow_once')).ok).toBe(true)
    expect(agents.pendingPermissions.get('permission-1')?.decision).toBe('allow_once')
    release()
    await waitFor(() => store.getTask(created.id)?.status === 'completed', 'permission completion')
  })

  it('refuses to apply while active or cancelled and applies only completed tasks', async () => {
    const { coordinator, store, workspaces } = harness()
    const created = await createTask(coordinator)
    store.updateTask(created.id, { status: 'running' })
    expect((await coordinator.apply(created.id)).ok).toBe(false)
    store.updateTask(created.id, { status: 'cancelled' })
    expect((await coordinator.apply(created.id)).ok).toBe(false)
    expect(workspaces.applyCalls).toHaveLength(0)

    store.updateTask(created.id, { status: 'completed' })
    expect(value(await coordinator.apply(created.id))).toBeNull()
    expect(workspaces.applyCalls).toEqual([created.id])
  })

  it('recovers tasks interrupted by a previous process without claiming a live session', async () => {
    const { coordinator, store } = harness()
    const created = await createTask(coordinator)
    store.updateTask(created.id, { status: 'running' })
    const step: AgentTaskStepView = {
      id: 'step-task_1',
      taskId: created.id,
      ordinal: 0,
      role: 'implement',
      agentId: IMPLEMENTER,
      title: '实现',
      input: '实现',
      expectedOutput: '完成',
      dependsOn: [],
      status: 'running',
      attempt: 1,
      sessionId: 'dead-session',
      runId: null,
      result: '',
      error: null,
      createdAt: 1,
      updatedAt: 1
    }
    store.createStep(step)

    expect(coordinator.recoverInterruptedTasks()).toBe(1)
    expect(store.getTask(created.id)?.status).toBe('failed')
    expect(store.listSteps(created.id)[0]).toMatchObject({
      status: 'queued',
      sessionId: null,
      runId: null
    })
    expect(store.listEvents(created.id).some((event) => event.kind === 'recovery')).toBe(true)
  })

  it('removes worktrees only after a task is no longer active', async () => {
    const { coordinator, store, workspaces } = harness()
    const created = await createTask(coordinator)
    store.updateTask(created.id, { status: 'running' })
    await expect(coordinator.removeWorktree(created.id)).resolves.toEqual({
      ok: false,
      error: 'task_is_active'
    })
    expect(workspaces.removeCalls).toHaveLength(0)

    store.updateTask(created.id, { status: 'completed' })
    await expect(coordinator.removeWorktree(created.id)).resolves.toEqual({
      ok: true,
      value: null
    })
    expect(workspaces.removeCalls).toEqual([created.id])
  })

  it('emits task updates and task-scoped permission prompts', async () => {
    const { coordinator, store, agents, emitted } = harness()
    agents.queue(COORDINATOR, JSON.stringify(plan(plan().steps.slice(0, 2))))
    const release = agents.blockNext(IMPLEMENTER, 'implementation')
    agents.queue(REVIEWER, 'approved')
    const created = await createTask(coordinator)
    value(await coordinator.start(created.id))
    await waitFor(() => store.getTask(created.id)?.status === 'awaiting_approval', 'approval')
    value(await coordinator.approvePlan(created.id))
    await waitFor(() => agents.prompts.some((prompt) => prompt.agentId === IMPLEMENTER), 'implement')
    const sessionId = agents.currentSessionFor(IMPLEMENTER)!
    agents.requestPermission(sessionId, 'permission-emitted')

    expect(emitted.some((event) => event.channel === IpcEvents.agentTaskUpdated)).toBe(true)
    expect(emitted.some((event) => event.channel === IpcEvents.agentTaskEvent)).toBe(true)
    expect(emitted.find((event) =>
      event.channel === IpcEvents.agentTaskPermissionRequest
    )?.payload).toMatchObject({
      taskId: created.id,
      request: { requestId: 'permission-emitted' }
    })
    release()
    await waitFor(() => store.getTask(created.id)?.status === 'completed', 'completion')
  })
})
