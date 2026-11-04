import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  IpcEvents,
  type AgentCoordinatorPlan,
  type AgentCoordinatorPlanStep,
  type AgentPermissionDecision,
  type AgentPermissionRequestView,
  type AgentResult,
  type AgentRunResult,
  type AgentSessionView,
  type AgentTaskCreateInput,
  type AgentTaskErrorEvent,
  type AgentTaskEventView,
  type AgentTaskPermissionRequestEvent,
  type AgentTaskPermissionResolvedEvent,
  type AgentTaskStepView,
  type AgentTaskView,
  type AgentView,
  type TaskWorkspace
} from '../../../shared/ipc'
import type {
  AgentTaskRecordInput,
  AgentTaskStore as StoredTaskRepository
} from '../../store/agent-task-repo'

const MAX_PLAN_OUTPUT_BYTES = 64 * 1024
const MAX_PROMPT_BYTES = 128 * 1024
const MAX_EVENT_BYTES = 32 * 1024
const MAX_STEP_RESULT_BYTES = 16 * 1024
const MAX_PLAN_STEPS = 5
const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const ACTIVE_TASK_STATUSES = new Set(['planning', 'running', 'review'])

export type AgentTaskStore = StoredTaskRepository

export interface AgentCoordinatorRuntime {
  listAgents(): AgentView[]
  newSession(agentId: string, cwd?: string): Promise<AgentResult<AgentSessionView>>
  prompt(sessionId: string, text: string): Promise<AgentResult<AgentRunResult>>
  cancel(sessionId: string): void
  respondPermission(
    requestId: string,
    decision: AgentPermissionDecision
  ): Promise<AgentResult<null>>
  closeSession(sessionId: string): Promise<void>
  subscribe(listener: (channel: string, payload: unknown) => void): () => void
}

export interface TaskWorkspaceService {
  create(taskId: string, repoPath: string): Promise<TaskWorkspace>
  buildPatch(taskId: string): Promise<Buffer>
  listChangedFiles(taskId: string): Promise<string[]>
  apply(taskId: string, repoPath: string): Promise<void>
  remove(taskId: string): Promise<void>
}

export interface PlainTaskWorkspaceService {
  create(taskId: string, dirPath: string): Promise<TaskWorkspace>
}

export interface AgentCoordinatorOptions {
  store: AgentTaskStore
  agents: AgentCoordinatorRuntime
  workspaces: TaskWorkspaceService
  plainWorkspaces?: PlainTaskWorkspaceService
  emit?: (channel: string, payload: unknown) => void
  now?: () => number
  id?: () => string
}

interface ActiveAgentRun {
  taskId: string
  sessionId: string
  agentId: string
  stepId: string | null
  output: string
}

interface PendingTaskPermission {
  taskId: string
  sessionId: string
}

interface InvokedAgent {
  sessionId: string
  runId: string
  stopReason: string | null
  output: string
}

function ok<T>(value: T): AgentResult<T> {
  return { ok: true, value }
}

function fail<T>(error: unknown): AgentResult<T> {
  return { ok: false, error: errorText(error) }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) end -= 1
  return value.slice(0, end)
}

function requiredString(
  value: unknown,
  name: string,
  maxBytes: number
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`invalid_plan: ${name} 不能为空`)
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`invalid_plan: ${name} 过长`)
  }
  return value.trim()
}

function parsePlanJson(output: string): unknown {
  if (Buffer.byteLength(output, 'utf8') > MAX_PLAN_OUTPUT_BYTES) {
    throw new Error('invalid_plan: 计划过长')
  }
  const candidates = [output.trim()]
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  const first = output.indexOf('{')
  const last = output.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(output.slice(first, last + 1))

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // 尝试下一个可提取的 JSON 片段。
    }
  }
  const preview = output.trim().replace(/\s+/g, ' ').slice(0, 240)
  const bytes = Buffer.byteLength(output, 'utf8')
  throw new Error(
    preview.length === 0
      ? 'invalid_plan: 协调者没有返回任何文本（可能只执行了工具调用）'
      : `invalid_plan: 协调者没有返回 JSON（${bytes} 字节：${preview}）`
  )
}

/** 提取 ACP 文本块；兼容对象与数组两种 content 形态。 */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => contentText(item)).join('')
  if (isPlainObject(value)) {
    if (typeof value['text'] === 'string') return value['text']
    if (value['content'] !== undefined) return contentText(value['content'])
  }
  return ''
}

function topologicalPlanSteps(
  plan: AgentCoordinatorPlan,
  teamAgentIds: Set<string>,
  mode: 'git' | 'plain' = 'git'
): AgentCoordinatorPlanStep[] {
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > MAX_PLAN_STEPS) {
    throw new Error('invalid_plan: 步骤数量必须为 1-5')
  }
  const ids = new Set<string>()
  const byId = new Map<string, AgentCoordinatorPlanStep>()
  for (const rawStep of plan.steps) {
    if (!isPlainObject(rawStep)) throw new Error('invalid_plan: 步骤格式错误')
    const id = requiredString(rawStep['id'], '步骤 id', 64)
    if (!STEP_ID_PATTERN.test(id)) throw new Error('invalid_plan: 步骤 id 不合法')
    if (ids.has(id)) throw new Error('invalid_plan: 步骤 id 重复')
    ids.add(id)
    const role = rawStep['role']
    if (role !== 'research' && role !== 'implement' && role !== 'review') {
      throw new Error('invalid_plan: 步骤角色不合法')
    }
    const agentId = requiredString(rawStep['agentId'], 'Agent id', 64)
    if (!teamAgentIds.has(agentId)) {
      throw new Error(`invalid_plan: ${agentId} 不在所选团队中`)
    }
    const dependsOn = Array.isArray(rawStep['dependsOn'])
      ? rawStep['dependsOn'].map((item) => requiredString(item, '依赖 id', 64))
      : []
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new Error('invalid_plan: 依赖重复')
    }
    const step: AgentCoordinatorPlanStep = {
      id,
      title: requiredString(rawStep['title'], '步骤标题', 500),
      role,
      agentId,
      dependsOn,
      input: requiredString(rawStep['input'], '步骤输入', 32 * 1024),
      expectedOutput: requiredString(rawStep['expectedOutput'], '预期输出', 8 * 1024)
    }
    byId.set(id, step)
  }

  for (const step of byId.values()) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`invalid_plan: 未知依赖 ${dependency}`)
      }
      if (dependency === step.id) throw new Error('invalid_plan: 步骤不能依赖自身')
    }
  }

  const indegree = new Map([...byId].map(([id, step]) => [id, step.dependsOn.length]))
  const dependents = new Map<string, string[]>()
  for (const step of byId.values()) {
    for (const dependency of step.dependsOn) {
      const list = dependents.get(dependency) ?? []
      list.push(step.id)
      dependents.set(dependency, list)
    }
  }
  const orderedIds = [...byId.keys()]
  const ordered: AgentCoordinatorPlanStep[] = []
  while (ordered.length < byId.size) {
    const next = orderedIds.find((id) => indegree.get(id) === 0 && !ordered.some((step) => step.id === id))
    if (!next) throw new Error('invalid_plan: 依赖存在环')
    ordered.push(byId.get(next)!)
    for (const dependent of dependents.get(next) ?? []) {
      indegree.set(dependent, (indegree.get(dependent) ?? 1) - 1)
    }
  }

  const implementers = new Set(
    ordered.filter((step) => step.role === 'implement').map((step) => step.agentId)
  )
  if (mode === 'plain') {
    // 普通目录：可能是纯测试、调研或汇总任务，不强制实现步骤，也不强制审查收尾。
    return ordered
  }
  if (implementers.size === 0) throw new Error('invalid_plan: 至少需要一个实现步骤')
  const reviews = ordered.filter((step) => step.role === 'review')
  if (reviews.length === 0) throw new Error('invalid_plan: 至少需要一个审查步骤')
  if (reviews.length > 2) throw new Error('invalid_plan: 最多两轮审查')
  if (reviews.some((step) => implementers.has(step.agentId))) {
    throw new Error('invalid_plan: 实现与审查必须使用不同 Agent')
  }
  if (ordered.at(-1)?.role !== 'review') {
    throw new Error('invalid_plan: 最终步骤必须是审查')
  }
  return ordered
}

function parsePlan(output: string, task: AgentTaskView): {
  plan: AgentCoordinatorPlan
  orderedSteps: AgentCoordinatorPlanStep[]
} {
  const parsed = parsePlanJson(output)
  if (!isPlainObject(parsed)) throw new Error('invalid_plan: 计划必须是对象')
  const summary = requiredString(parsed['summary'], '计划摘要', 2_000)
  const rawSteps = parsed['steps']
  if (!Array.isArray(rawSteps)) throw new Error('invalid_plan: steps 必须是数组')
  const rawPlan = {
    summary,
    steps: rawSteps as AgentCoordinatorPlanStep[]
  }
  const orderedSteps = topologicalPlanSteps(rawPlan, new Set(task.teamAgentIds), task.mode)
  return {
    plan: {
      summary,
      steps: orderedSteps
    },
    orderedSteps
  }
}

function eventText(event: AgentTaskEventView): string {
  return `[${new Date(event.createdAt).toISOString()}] ${event.kind}: ${event.text}`
}

export class AgentCoordinator {
  private readonly store: AgentTaskStore
  private readonly agents: AgentCoordinatorRuntime
  private readonly workspaces: TaskWorkspaceService
  private readonly plainWorkspaces: PlainTaskWorkspaceService | null
  private readonly emitTask: (channel: string, payload: unknown) => void
  private readonly now: () => number
  private readonly id: () => string
  private readonly contexts = new Map<string, ActiveAgentRun>()
  private readonly activeSessions = new Map<string, Set<string>>()
  private readonly chatSessions = new Map<string, string>()
  private readonly pendingPermissions = new Map<string, PendingTaskPermission>()
  private readonly operations = new Set<string>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(options: AgentCoordinatorOptions) {
    this.store = options.store
    this.agents = options.agents
    this.workspaces = options.workspaces
    this.plainWorkspaces = options.plainWorkspaces ?? null
    this.emitTask = options.emit ?? (() => {})
    this.now = options.now ?? (() => Date.now())
    this.id = options.id ?? (() => randomUUID())
    this.unsubscribe = this.agents.subscribe((channel, payload) => {
      this.handleAgentEvent(channel, payload)
    })
  }

  async createTask(input: AgentTaskCreateInput): Promise<AgentResult<AgentTaskView>> {
    if (this.disposed) return fail('应用正在退出')
    try {
      if (!input || typeof input !== 'object') throw new Error('任务参数不合法')
      if (typeof input.repoPath !== 'string' || !isAbsolute(input.repoPath)) {
        throw new Error('repository_path_must_be_absolute')
      }
      if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
        throw new Error('任务描述不能为空')
      }
      if (Buffer.byteLength(input.prompt, 'utf8') > MAX_PROMPT_BYTES) {
        throw new Error('任务描述过长')
      }
      if (
        typeof input.coordinatorAgentId !== 'string' ||
        input.coordinatorAgentId.length === 0
      ) {
        throw new Error('必须选择协调者 Agent')
      }
      if (!Array.isArray(input.teamAgentIds) || input.teamAgentIds.length < 2) {
        throw new Error('团队至少需要实现与审查两个 Agent')
      }
      if (input.teamAgentIds.length > 16) throw new Error('团队最多 16 个 Agent')
      const teamAgentIds = [...new Set(input.teamAgentIds)]
      if (teamAgentIds.length !== input.teamAgentIds.length) throw new Error('团队成员不能重复')
      if (teamAgentIds.includes(input.coordinatorAgentId)) {
        throw new Error('协调者不能同时加入执行团队')
      }
      this.assertAgentsAvailable(input.coordinatorAgentId, teamAgentIds)
      const mode = input.mode === 'plain' ? 'plain' : 'git'
      if (mode === 'plain' && !this.plainWorkspaces) {
        throw new Error('plain_directory_unsupported')
      }

      const taskId = this.id()
      if (!STEP_ID_PATTERN.test(taskId)) throw new Error('任务 id 不合法')
      let workspace: TaskWorkspace | null = null
      let usedPlain = false
      try {
        if (mode === 'plain') {
          workspace = await this.plainWorkspaces!.create(taskId, input.repoPath)
          usedPlain = true
        } else {
          workspace = await this.workspaces.create(taskId, input.repoPath)
        }
        const createdAt = this.now()
        const record: AgentTaskRecordInput = {
          id: taskId,
          repoPath: workspace.repoRoot,
          mode,
          prompt: input.prompt.trim(),
          sourceBranch: workspace.sourceBranch,
          baseCommit: workspace.baseCommit,
          worktreePath: workspace.worktreePath,
          taskBranch: workspace.taskBranch,
          coordinatorAgentId: input.coordinatorAgentId,
          teamAgentIds,
          createdAt
        }
        const task = this.store.createTask(record)
        this.appendEvent(
          task,
          'system',
          mode === 'plain' ? '任务群已建立，Agent 将直接在该目录内工作' : '任务群已建立，仓库已隔离到专用 worktree',
          null,
          null,
          0
        )
        this.appendEvent(task, 'chat.user', task.prompt, null, null, 1)
        return ok(task)
      } catch (error) {
        if (workspace && !usedPlain) await this.workspaces.remove(taskId).catch(() => undefined)
        throw error
      }
    } catch (error) {
      return fail(error)
    }
  }

  async start(taskId: string): Promise<AgentResult<AgentTaskView>> {
    if (this.disposed) return fail('应用正在退出')
    try {
      const task = this.requireTask(taskId)
      if (task.status !== 'draft' && task.status !== 'failed') {
        throw new Error('task_not_startable')
      }
      if (this.operations.has(taskId)) throw new Error('task_already_running')
      this.assertTaskAgentsAvailable(task)
      const updated = this.store.updateTask(taskId, {
        status: 'planning',
        error: null,
        updatedAt: this.now()
      })
      if (!updated) throw new Error('task_not_found')
      this.launch(taskId, () => this.planTask(taskId))
      return ok(updated)
    } catch (error) {
      return fail(error)
    }
  }

  async approvePlan(taskId: string): Promise<AgentResult<AgentTaskView>> {
    if (this.disposed) return fail('应用正在退出')
    try {
      const task = this.requireTask(taskId)
      if (task.status !== 'awaiting_approval' || !task.plan) {
        throw new Error('plan_not_awaiting_approval')
      }
      if (this.operations.has(taskId)) throw new Error('task_already_running')
      this.assertTaskAgentsAvailable(task)
      topologicalPlanSteps(task.plan, new Set(task.teamAgentIds), task.mode)
      const updated = this.store.updateTask(taskId, {
        status: 'running',
        error: null,
        updatedAt: this.now()
      })
      if (!updated) throw new Error('task_not_found')
      this.launch(taskId, () => this.runTask(taskId))
      return ok(updated)
    } catch (error) {
      return fail(error)
    }
  }

  async pause(taskId: string): Promise<AgentResult<AgentTaskView>> {
    try {
      const task = this.requireTask(taskId)
      if (!ACTIVE_TASK_STATUSES.has(task.status)) throw new Error('task_not_active')
      const updated = this.store.updateTask(taskId, {
        status: 'paused',
        updatedAt: this.now()
      })
      if (!updated) throw new Error('task_not_found')
      this.appendEvent(updated, 'system', '已暂停；当前 ACP 提示完成后不再派发下一步', null, null, 0)
      return ok(updated)
    } catch (error) {
      return fail(error)
    }
  }

  async resume(taskId: string): Promise<AgentResult<AgentTaskView>> {
    if (this.disposed) return fail('应用正在退出')
    try {
      const task = this.requireTask(taskId)
      if (!['paused', 'running', 'review', 'failed'].includes(task.status)) {
        throw new Error('task_not_resumable')
      }
      if (this.operations.has(taskId)) throw new Error('task_already_running')
      if (!task.plan) throw new Error('task_plan_missing')
      this.assertTaskAgentsAvailable(task)
      topologicalPlanSteps(task.plan, new Set(task.teamAgentIds), task.mode)

      const interrupted = this.store.listSteps(taskId).filter((step) =>
        step.status === 'running' || step.status === 'awaiting_approval'
      )
      for (const step of interrupted) {
        this.store.updateStep(step.id, {
          status: 'queued',
          attempt: Math.min(step.attempt + 1, 3),
          sessionId: null,
          runId: null,
          error: null,
          updatedAt: this.now()
        })
      }
      const updated = this.store.updateTask(taskId, {
        status: 'running',
        error: null,
        updatedAt: this.now()
      })
      if (!updated) throw new Error('task_not_found')
      this.appendRecoveryEvent(updated)
      this.launch(taskId, () => this.runTask(taskId))
      return ok(updated)
    } catch (error) {
      return fail(error)
    }
  }

  async cancel(taskId: string): Promise<AgentResult<AgentTaskView>> {
    try {
      const task = this.requireTask(taskId)
      if (!['planning', 'running', 'review', 'paused'].includes(task.status)) {
        throw new Error('task_not_cancellable')
      }
      const updated = this.store.updateTask(taskId, {
        status: 'cancelled',
        updatedAt: this.now()
      })
      if (!updated) throw new Error('task_not_found')
      for (const step of this.store.listSteps(taskId)) {
        if (step.status === 'completed' || step.status === 'cancelled') continue
        this.store.updateStep(step.id, {
          status: 'cancelled',
          error: 'task_cancelled',
          updatedAt: this.now()
        })
      }
      for (const sessionId of this.activeSessions.get(taskId) ?? []) {
        this.agents.cancel(sessionId)
      }
      this.appendEvent(updated, 'system', '任务已取消，所有未完成步骤停止', null, null, 0)
      await this.closeChatSession(taskId)
      return ok(updated)
    } catch (error) {
      return fail(error)
    }
  }


  /**
   * 任务群聊：把用户消息交给统筹者（持久 ACP 会话），回复作为 chat.coordinator 事件入时间线。
   * 统筹者只做沟通与分派建议，聊天阶段不允许改文件/执行命令（提示词约束）。
   */
  async chat(taskId: string, text: string): Promise<AgentResult<AgentTaskEventView>> {
    if (this.disposed) return fail('应用正在退出')
    try {
      const task = this.requireTask(taskId)
      if (typeof text !== 'string' || text.trim().length === 0) throw new Error('消息不能为空')
      if (Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) throw new Error('消息过长')
      if (task.status === 'cancelled') throw new Error('任务已取消')
      const content = text.trim()
      this.appendEvent(task, 'chat.user', content, null, null, this.chatSequence(taskId, 'chat.user'))

      let sessionId = await this.ensureChatSession(task)
      const ask = () => {
        const context = this.contexts.get(sessionId)
        if (context) context.output = ''
        return this.agents.prompt(sessionId, this.buildChatPrompt(this.requireTask(taskId), content))
      }
      let result = await ask()
      if (!result.ok) {
        // 会话可能已随 CLI 退出失效：重建一次再试
        await this.closeChatSession(taskId)
        sessionId = await this.ensureChatSession(this.requireTask(taskId))
        result = await ask()
      }
      if (!result.ok) throw new Error(result.error)
      const reply = (this.contexts.get(sessionId)?.output ?? '').trim() || '（统筹者没有返回内容）'
      return ok(
        this.appendEvent(
          this.requireTask(taskId),
          'chat.coordinator',
          reply,
          null,
          task.coordinatorAgentId,
          this.chatSequence(taskId, 'chat.coordinator')
        )
      )
    } catch (error) {
      return fail(error)
    }
  }

  private async ensureChatSession(task: AgentTaskView): Promise<string> {
    const existing = this.chatSessions.get(task.id)
    if (existing && this.contexts.has(existing)) return existing
    const created = await this.agents.newSession(task.coordinatorAgentId, task.worktreePath)
    if (!created.ok) throw new Error(created.error)
    const sessionId = created.value.id
    this.chatSessions.set(task.id, sessionId)
    this.contexts.set(sessionId, {
      taskId: task.id,
      sessionId,
      agentId: task.coordinatorAgentId,
      stepId: null,
      output: ''
    })
    return sessionId
  }

  private async closeChatSession(taskId: string): Promise<void> {
    const sessionId = this.chatSessions.get(taskId)
    if (!sessionId) return
    this.chatSessions.delete(taskId)
    this.contexts.delete(sessionId)
    await this.agents.closeSession(sessionId).catch(() => undefined)
  }

  private chatSequence(taskId: string, kind: string): number {
    return this.store.listEvents(taskId, 2_000).filter((event) => event.kind === kind).length + 1
  }

  private eventSequence(taskId: string, kind: string): number {
    return this.store.listEvents(taskId, 2_000).filter((event) => event.kind === kind).length + 1
  }

  private buildChatPrompt(task: AgentTaskView, text: string): string {
    const steps = this.store
      .listSteps(task.id)
      .map(
        (step) =>
          `${step.ordinal + 1}. [${step.role}] ${step.title} — ${step.status}（${step.agentId}）`
      )
      .join('\n')
    const recent = this.store
      .listEvents(task.id, 2_000)
      .slice(-10)
      .map((event) => `- ${event.kind}: ${truncateUtf8(event.text, 400)}`)
      .join('\n')
    return [
      '你是阳鸽任务群的统筹者（coordinator），负责与用户沟通、拆解任务并把工作分派给团队。',
      '当前是群聊阶段：只回复用户，不要修改文件、不要执行命令、不要调用工具；用简洁中文回答。',
      `任务目标：${task.prompt}`,
      `任务状态：${task.status}`,
      task.plan ? `计划摘要：${task.plan.summary}` : '还没有生成计划。',
      steps ? `步骤进度：\n${steps}` : '',
      recent ? `最近记录：\n${recent}` : '',
      `用户消息：${text}`
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  async respondPermission(
    taskId: string,
    requestId: string,
    decision: AgentPermissionDecision
  ): Promise<AgentResult<null>> {
    try {
      this.requireTask(taskId)
      const pending = this.pendingPermissions.get(requestId)
      if (!pending || pending.taskId !== taskId) {
        throw new Error('permission_request_not_owned_by_task')
      }
      const result = await this.agents.respondPermission(requestId, decision)
      if (!result.ok) return result
      this.pendingPermissions.delete(requestId)
      return ok(null)
    } catch (error) {
      return fail(error)
    }
  }

  async apply(taskId: string): Promise<AgentResult<null>> {
    try {
      const task = this.requireTask(taskId)
      if (task.status !== 'completed') {
        throw new Error(
          task.status === 'cancelled' ? 'task_cancelled' : 'task_not_ready_to_apply'
        )
      }
      if (task.mode === 'plain') {
        // 普通目录任务：改动已直接写入目录，没有补丁可应用。
        this.appendEvent(task, 'system', '普通目录任务：改动已在目录内直接生效', null, null, 0)
        return ok(null)
      }
      await this.workspaces.apply(taskId, task.repoPath)
      this.appendEvent(task, 'system', '补丁已应用到源仓库工作区，未创建提交', null, null, 0)
      return ok(null)
    } catch (error) {
      return fail(error)
    }
  }

  async removeWorktree(taskId: string): Promise<AgentResult<null>> {
    try {
      const task = this.requireTask(taskId)
      if (ACTIVE_TASK_STATUSES.has(task.status) || this.operations.has(taskId)) {
        throw new Error('task_is_active')
      }
      if (task.mode === 'git') await this.workspaces.remove(taskId)
      await this.closeChatSession(taskId)
      this.appendEvent(
        task,
        'system',
        task.mode === 'plain' ? '任务已清理，目录内容保持原样' : '任务 worktree 已清理，任务记录与历史保留',
        null,
        null,
        0
      )
      return ok(null)
    } catch (error) {
      return fail(error)
    }
  }

  recoverInterruptedTasks(): number {
    let recovered = 0
    for (const task of this.store.listTasks(200)) {
      if (!ACTIVE_TASK_STATUSES.has(task.status)) continue
      const now = this.now()
      for (const step of this.store.listSteps(task.id)) {
        if (step.status !== 'running' && step.status !== 'awaiting_approval') continue
        this.store.updateStep(step.id, {
          status: 'queued',
          sessionId: null,
          runId: null,
          error: null,
          updatedAt: now
        })
      }
      const failed = this.store.updateTask(task.id, {
        status: 'failed',
        error: 'application_interrupted',
        updatedAt: now
      })
      if (!failed) continue
      this.appendRecoveryEvent(failed)
      recovered += 1
    }
    return recovered
  }

  checkpointAndDispose(): void {
    if (this.disposed) return
    this.recoverInterruptedTasks()
    for (const sessions of this.activeSessions.values()) {
      for (const sessionId of sessions) this.agents.cancel(sessionId)
    }
    this.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    for (const sessionId of this.chatSessions.values()) {
      this.contexts.delete(sessionId)
      void this.agents.closeSession(sessionId).catch(() => undefined)
    }
    this.chatSessions.clear()
    this.contexts.clear()
    this.pendingPermissions.clear()
  }

  private async planTask(taskId: string): Promise<void> {
    let task: AgentTaskView | null = null
    try {
      task = this.requireTask(taskId)
      const basePrompt = this.buildPlanPrompt(task)
      let lastError: unknown = null
      // 首次失败后重试一次：部分 Agent（如 Codex）可能把整轮花在工具调用上而没有输出 JSON。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const prompt =
          attempt === 0
            ? basePrompt
            : `${basePrompt}\n\n上一次回复没有包含可解析的 JSON。请只输出 JSON 对象本身：不要调用任何工具，不要读取文件或目录，不要输出解释、前言或 Markdown 代码围栏。`
        const result = await this.invokeAgent(
          task,
          task.coordinatorAgentId,
          prompt,
          null,
          'plan'
        )
        const latest = this.requireTask(taskId)
        if (latest.status !== 'planning') return
        try {
          const parsed = parsePlan(result.output, latest)
          const stamp = this.now()
          const steps: AgentTaskStepView[] = parsed.orderedSteps.map((step, ordinal) => ({
            id: this.stepId(taskId, ordinal),
            taskId,
            ordinal,
            role: step.role,
            agentId: step.agentId,
            title: step.title,
            input: step.input,
            expectedOutput: step.expectedOutput,
            dependsOn: step.dependsOn,
            status: 'queued',
            attempt: 0,
            sessionId: null,
            runId: null,
            result: '',
            error: null,
            createdAt: stamp,
            updatedAt: stamp
          }))
          const updated = this.store.replacePlan(taskId, parsed.plan, steps, stamp)
          if (!updated) throw new Error('task_not_found')
          this.appendEvent(
            updated,
            'plan',
            `计划待确认：${parsed.plan.summary}`,
            null,
            task.coordinatorAgentId,
            0
          )
          return
        } catch (error) {
          lastError = error
          this.appendEvent(
            latest,
            'system',
            `计划解析失败（第 ${attempt + 1} 次）：${errorText(error)}${
              result.stopReason ? ` · stopReason=${result.stopReason}` : ''
            }`,
            null,
            task.coordinatorAgentId,
            this.eventSequence(taskId, 'system')
          )
        }
      }
      throw lastError ?? new Error('invalid_plan: 协调者没有返回 JSON')
    } catch (error) {
      const latest = this.store.getTask(taskId)
      if (latest && latest.status === 'planning') {
        const failed = this.store.updateTask(taskId, {
          status: 'failed',
          error: errorText(error),
          updatedAt: this.now()
        })
        if (failed) this.appendEvent(failed, 'error', errorText(error), null, null, 0)
      }
    }
  }

  private async runTask(taskId: string): Promise<void> {
    let currentStep: AgentTaskStepView | null = null
    try {
      let task = this.requireTask(taskId)
      if (!task.plan) throw new Error('task_plan_missing')
      if (task.mode === 'plain' && !this.plainWorkspaces) throw new Error('plain_directory_unsupported')
      const ordered = topologicalPlanSteps(task.plan, new Set(task.teamAgentIds), task.mode)
      const storedSteps = this.store.listSteps(taskId)
      const byOrdinal = new Map(storedSteps.map((step) => [step.ordinal, step]))

      for (let ordinal = 0; ordinal < ordered.length; ordinal += 1) {
        task = this.requireTask(taskId)
        if (task.status === 'paused' || task.status === 'cancelled') return
        if (task.status !== 'running' && task.status !== 'review') {
          throw new Error(`task_state_invalid: ${task.status}`)
        }
        const planStep = ordered[ordinal]
        let step = byOrdinal.get(ordinal)
        if (!step) throw new Error('task_step_missing')
        if (step.status === 'completed') continue
        if (step.status === 'cancelled') return
        if (planStep.role === 'review' && task.mode === 'git' && task.reviewRound >= 2) {
          throw new Error('review_round_limit_reached')
        }

        const phase = planStep.role === 'review' ? 'review' : 'running'
        task = this.store.updateTask(taskId, {
          status: phase,
          reviewRound:
            planStep.role === 'review' ? task.reviewRound + 1 : task.reviewRound,
          error: null,
          updatedAt: this.now()
        })!
        step = this.store.updateStep(step.id, {
          status: 'running',
          attempt: Math.min(step.attempt + 1, 3),
          error: null,
          updatedAt: this.now()
        })!
        currentStep = step

        const result = await this.invokeAgent(
          task,
          planStep.agentId,
          this.buildStepPrompt(task, planStep, ordinal),
          step.id,
          'step'
        )
        const latest = this.requireTask(taskId)
        if (this.disposed || latest.status === 'failed') {
          return
        }
        if (latest.status === 'cancelled') {
          this.store.updateStep(step.id, {
            status: 'cancelled',
            runId: result.runId,
            error: 'task_cancelled',
            updatedAt: this.now()
          })
          return
        }
        step = this.store.updateStep(step.id, {
          status: 'completed',
          runId: result.runId,
          result: truncateUtf8(result.output, MAX_STEP_RESULT_BYTES),
          error: null,
          updatedAt: this.now()
        })!
        currentStep = null
        this.appendEvent(
          task,
          'agent',
          result.output,
          step.id,
          step.agentId,
          step.attempt
        )
      }

      const latest = this.requireTask(taskId)
      if (latest.status === 'running' || latest.status === 'review') {
        const completed = this.store.updateTask(taskId, {
          status: 'completed',
          error: null,
          updatedAt: this.now()
        })!
        this.appendEvent(completed, 'system', '全部步骤完成，等待用户审查最终差异', null, null, 0)
      }
    } catch (error) {
      const latest = this.store.getTask(taskId)
      if (!latest || latest.status === 'cancelled' || latest.status === 'paused') return
      if (currentStep) {
        this.store.updateStep(currentStep.id, {
          status: 'failed',
          error: errorText(error),
          updatedAt: this.now()
        })
      }
      const failed = this.store.updateTask(taskId, {
        status: 'failed',
        error: errorText(error),
        updatedAt: this.now()
      })
      if (failed) {
        this.appendEvent(
          failed,
          'error',
          errorText(error),
          currentStep?.id ?? null,
          currentStep?.agentId ?? null,
          currentStep?.attempt ?? 0
        )
      }
    }
  }

  private async invokeAgent(
    task: AgentTaskView,
    agentId: string,
    prompt: string,
    stepId: string | null,
    kind: 'plan' | 'step'
  ): Promise<InvokedAgent> {
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      throw new Error('agent_prompt_too_large')
    }
    const created = await this.agents.newSession(agentId, task.worktreePath)
    if (!created.ok) throw new Error(created.error)
    const sessionId = created.value.id
    if (stepId) {
      this.store.updateStep(stepId, {
        sessionId,
        updatedAt: this.now()
      })
    }
    const context: ActiveAgentRun = {
      taskId: task.id,
      sessionId,
      agentId,
      stepId,
      output: ''
    }
    this.contexts.set(sessionId, context)
    const sessions = this.activeSessions.get(task.id) ?? new Set<string>()
    sessions.add(sessionId)
    this.activeSessions.set(task.id, sessions)
    const requestSequence = this.store
      .listEvents(task.id, 2_000)
      .filter((event) => event.stepId === stepId && event.kind === `${kind}_request`)
      .length + 1
    this.appendEvent(
      task,
      `${kind}_request`,
      prompt,
      stepId,
      agentId,
      requestSequence
    )
    try {
      const result = await this.agents.prompt(sessionId, prompt)
      if (!result.ok) throw new Error(result.error)
      return {
        sessionId,
        runId: result.value.runId,
        stopReason: result.value.stopReason,
        output: context.output
      }
    } finally {
      this.contexts.delete(sessionId)
      sessions.delete(sessionId)
      if (sessions.size === 0) this.activeSessions.delete(task.id)
      await this.agents.closeSession(sessionId).catch(() => undefined)
    }
  }

  private buildPlanPrompt(task: AgentTaskView): string {
    const team = task.teamAgentIds.map((id) => `- ${id}`).join('\n')
    const plain = task.mode === 'plain'
    const constraints = plain
      ? '约束：1-5 个步骤；每个步骤按顺序执行（dependsOn 依次串联）。纯调研、测试或汇总任务不需要 implement 步骤，按实际工作选择 research / implement / review 角色。'
      : '约束：1-5 个步骤；至少一个 implement 和一个 review；最终步骤必须是 review；审查 Agent 不能是实现 Agent；最多两轮 review；依赖必须存在且无环。'
    const scope = plain
      ? '工作目录是用户选择的普通文件夹（无 Git 隔离），改动直接生效，请谨慎描述涉及的操作。'
      : '工作目录是隔离的 Git worktree，可以安全实验。'
    return [
      '你是阳鸽任务的协调者。只制定计划，不要修改文件，不要执行实现。',
      '不要调用任何工具：不要读取文件、列目录、搜索或运行命令；直接输出 JSON 对象。',
      `用户目标：${task.prompt}`,
      scope,
      '可选团队成员：',
      team,
      '必须输出单个 JSON 对象，不要输出 Markdown 代码围栏或其他说明。',
      'JSON 格式：',
      '{"summary":"不超过100字","steps":[{"id":"唯一短ID","title":"步骤标题","role":"research|implement|review","agentId":"团队成员ID","dependsOn":["前序步骤ID"],"input":"交给该 Agent 的任务","expectedOutput":"完成条件"}]}',
      constraints
    ].join('\n')
  }

  private buildStepPrompt(
    task: AgentTaskView,
    step: AgentCoordinatorPlanStep,
    ordinal: number
  ): string {
    const allSteps = this.store.listSteps(task.id)
    const dependencies = step.dependsOn
      .map((dependencyId) => {
        const dependencyOrdinal = task.plan?.steps.findIndex((item) => item.id === dependencyId) ?? -1
        const dependency = allSteps.find((item) => item.ordinal === dependencyOrdinal)
        return dependency?.result
          ? `依赖 ${dependencyId} 的结果：\n${dependency.result}`
          : `依赖 ${dependencyId} 已完成`
      })
      .join('\n\n')
    const recentEvents = this.store
      .listEvents(task.id)
      .filter((event) => event.kind === 'agent' || event.kind === 'recovery')
      .slice(-12)
      .map(eventText)
      .join('\n')
    return truncateUtf8(
      [
        `你是阳鸽编码团队中的 ${step.role} Agent。你只负责当前步骤。`,
        `总目标：${task.prompt}`,
        `计划：${task.plan?.summary ?? ''}`,
        `当前步骤 ${ordinal + 1}/${task.plan?.steps.length ?? 0}：${step.title}`,
        `任务：${step.input}`,
        `完成条件：${step.expectedOutput}`,
        dependencies,
        `已保存的协调记录：\n${recentEvents}`,
        task.mode === 'plain'
          ? '用户选择的目录就是工作现场，改动直接生效且无法回滚，请谨慎操作。完成后说明改动、验证和遗留风险。'
          : '请直接在当前 worktree 内工作；不要提交、合并或推送。完成后说明改动、验证和遗留风险。'
      ]
        .filter(Boolean)
        .join('\n\n'),
      120 * 1024
    )
  }

  private appendRecoveryEvent(task: AgentTaskView): void {
    const transcript = this.store
      .listEvents(task.id)
      .filter((event) => event.kind === 'agent' || event.kind === 'system')
      .slice(-20)
      .map(eventText)
      .join('\n')
    const interrupted = this.store
      .listSteps(task.id)
      .filter((step) => step.status === 'queued' || step.status === 'running')
      .map((step) => step.title)
      .join('、')
    this.appendEvent(
      task,
      'recovery',
      `恢复未完成任务；中断步骤将使用新 ACP 会话重试：${interrupted || '无'}\n${transcript}`,
      null,
      null,
      this.idSequence(task.id)
    )
  }

  private appendEvent(
    task: AgentTaskView,
    kind: string,
    text: string,
    stepId: string | null,
    agentId: string | null,
    sequence: number
  ): AgentTaskEventView {
    const stable = createHash('sha1')
      .update(`${task.id}:${stepId ?? ''}:${kind}:${sequence}`)
      .digest('hex')
      .slice(0, 32)
    const event: AgentTaskEventView = {
      id: `evt_${stable}`,
      taskId: task.id,
      stepId,
      kind,
      agentId,
      text: truncateUtf8(text, MAX_EVENT_BYTES),
      createdAt: this.now()
    }
    this.store.appendEvent(event)
    const latest = this.store.getTask(task.id)
    if (latest) this.emitTask(IpcEvents.agentTaskUpdated, latest)
    this.emitTask(IpcEvents.agentTaskEvent, event)
    if (kind === 'error') {
      const failure: AgentTaskErrorEvent = {
        taskId: task.id,
        message: event.text
      }
      this.emitTask(IpcEvents.agentTaskError, failure)
    }
    return event
  }

  private launch(taskId: string, run: () => Promise<void>): void {
    this.operations.add(taskId)
    void run()
      .catch(async (error) => {
        const task = this.store.getTask(taskId)
        if (!task || task.status === 'cancelled' || task.status === 'paused') return
        const failed = this.store.updateTask(taskId, {
          status: 'failed',
          error: errorText(error),
          updatedAt: this.now()
        })
        if (failed) this.appendEvent(failed, 'error', errorText(error), null, null, 0)
      })
      .finally(() => {
        this.operations.delete(taskId)
      })
  }

  private handleAgentEvent(channel: string, payload: unknown): void {
    if (this.disposed || !isPlainObject(payload)) return
    const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'] : ''
    if (!sessionId) return
    if (channel === IpcEvents.agentUpdate) {
      const context = this.contexts.get(sessionId)
      const update = payload['update']
      if (!context || !isPlainObject(update)) return
      const kind = update['sessionUpdate']
      if (kind === 'agent_message_chunk') {
        const chunk = contentText(update['content'])
        if (chunk) {
          context.output = truncateUtf8(
            context.output + chunk,
            MAX_PLAN_OUTPUT_BYTES
          )
        }
        return
      }
      if (kind === 'plan' && Array.isArray(update['entries'])) {
        // 部分 Agent（如 Codex 计划模式）把计划放在 plan 更新里，作为 JSON 提取的兜底。
        const text = update['entries']
          .map((entry) =>
            isPlainObject(entry) && typeof entry['content'] === 'string' ? entry['content'] : ''
          )
          .filter(Boolean)
          .join('\n')
        if (text) {
          context.output = truncateUtf8(
            `${context.output}\n${text}`,
            MAX_PLAN_OUTPUT_BYTES
          )
        }
      }
      return
    }
    if (channel === IpcEvents.agentPermissionRequest) {
      const context = this.contexts.get(sessionId)
      const requestId = payload['requestId']
      if (!context || typeof requestId !== 'string') return
      this.pendingPermissions.set(requestId, {
        taskId: context.taskId,
        sessionId
      })
      const request = payload as unknown as AgentPermissionRequestView
      const taskRequest: AgentTaskPermissionRequestEvent = {
        taskId: context.taskId,
        request
      }
      this.emitTask(IpcEvents.agentTaskPermissionRequest, taskRequest)
      return
    }
    if (channel === IpcEvents.agentPermissionResolved) {
      const requestId = payload['requestId']
      if (typeof requestId === 'string') {
        const pending = this.pendingPermissions.get(requestId)
        this.pendingPermissions.delete(requestId)
        if (pending) {
          const outcome = payload['outcome'] === 'selected' ? 'selected' : 'cancelled'
          const resolved: AgentTaskPermissionResolvedEvent = {
            taskId: pending.taskId,
            requestId,
            outcome,
            optionId: typeof payload['optionId'] === 'string' ? payload['optionId'] : null
          }
          this.emitTask(IpcEvents.agentTaskPermissionResolved, resolved)
        }
      }
    }
  }

  private assertTaskAgentsAvailable(task: AgentTaskView): void {
    this.assertAgentsAvailable(task.coordinatorAgentId, task.teamAgentIds)
  }

  private assertAgentsAvailable(coordinatorAgentId: string, teamAgentIds: string[]): void {
    const available = new Set(this.agents.listAgents().filter((item) => item.enabled).map((item) => item.id))
    if (!available.has(coordinatorAgentId)) throw new Error('coordinator_agent_unavailable')
    if (teamAgentIds.some((id) => !available.has(id))) throw new Error('team_agent_unavailable')
  }

  private requireTask(taskId: string): AgentTaskView {
    if (typeof taskId !== 'string' || !STEP_ID_PATTERN.test(taskId)) {
      throw new Error('invalid_task_id')
    }
    const task = this.store.getTask(taskId)
    if (!task) throw new Error('task_not_found')
    return task
  }

  private stepId(taskId: string, ordinal: number): string {
    return `step_${taskId.slice(0, 24)}_${ordinal + 1}`
  }

  private idSequence(taskId: string): number {
    return this.store.listEvents(taskId, 2_000).filter((event) => event.kind === 'recovery').length + 1
  }
}
