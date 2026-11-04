import { isAbsolute } from 'node:path'
import type {
  AgentPermissionDecision,
  AgentResult,
  AgentTaskCreateInput,
  AgentTaskDetailView,
  AgentTaskDiffView,
  AgentTaskEventView,
  AgentTaskView
} from '../../../shared/ipc'
import type { AgentTaskStore } from '../../store/agent-task-repo'

const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const MAX_TASK_BYTES = 128 * 1024
const MAX_DIFF_BYTES = 16 * 1024 * 1024

interface AgentTaskCoordinatorPort {
  createTask(input: AgentTaskCreateInput): Promise<AgentResult<AgentTaskView>>
  start(taskId: string): Promise<AgentResult<AgentTaskView>>
  approvePlan(taskId: string): Promise<AgentResult<AgentTaskView>>
  pause(taskId: string): Promise<AgentResult<AgentTaskView>>
  resume(taskId: string): Promise<AgentResult<AgentTaskView>>
  cancel(taskId: string): Promise<AgentResult<AgentTaskView>>
  chat(taskId: string, text: string): Promise<AgentResult<AgentTaskEventView>>
  respondPermission(
    taskId: string,
    requestId: string,
    decision: AgentPermissionDecision
  ): Promise<AgentResult<null>>
  apply(taskId: string): Promise<AgentResult<null>>
  removeWorktree(taskId: string): Promise<AgentResult<null>>
  recoverInterruptedTasks(): number
}

interface AgentTaskWorkspacePort {
  buildPatch(taskId: string): Promise<Buffer>
  listChangedFiles(taskId: string): Promise<string[]>
}

export interface AgentTaskIpcControllerOptions {
  store: Pick<AgentTaskStore, 'listTasks' | 'getTask' | 'listSteps' | 'listEvents'>
  coordinator: AgentTaskCoordinatorPort
  workspaces: AgentTaskWorkspacePort
}

function fail<T>(error: unknown): AgentResult<T> {
  return {
    ok: false,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value)
}

function validAgentId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
}

function parseCreateInput(value: unknown): AgentTaskCreateInput {
  if (!isRecord(value)) throw new Error('invalid_task_payload')
  const { repoPath, prompt, coordinatorAgentId, teamAgentIds } = value
  const mode = value['mode'] === 'plain' ? 'plain' as const : 'git' as const
  if (typeof repoPath !== 'string' || repoPath.length > 4_096 || !isAbsolute(repoPath)) {
    throw new Error('repository_path_must_be_absolute')
  }
  if (
    typeof prompt !== 'string' ||
    prompt.trim().length === 0 ||
    Buffer.byteLength(prompt, 'utf8') > MAX_TASK_BYTES
  ) {
    throw new Error('task_prompt_invalid')
  }
  if (!validAgentId(coordinatorAgentId)) throw new Error('coordinator_agent_invalid')
  if (
    !Array.isArray(teamAgentIds) ||
    teamAgentIds.length < 2 ||
    teamAgentIds.length > 16 ||
    !teamAgentIds.every(validAgentId)
  ) {
    throw new Error('team_agents_invalid')
  }
  const uniqueTeam = new Set(teamAgentIds)
  if (uniqueTeam.size !== teamAgentIds.length) throw new Error('team_agents_duplicate')
  if (uniqueTeam.has(coordinatorAgentId)) throw new Error('coordinator_in_team')
  return {
    repoPath,
    prompt,
    coordinatorAgentId,
    teamAgentIds: [...teamAgentIds],
    mode
  }
}

function safeLimit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return fallback
  return Math.min(value, maximum)
}

export class AgentTaskIpcController {
  private readonly store: AgentTaskIpcControllerOptions['store']
  private readonly coordinator: AgentTaskCoordinatorPort
  private readonly workspaces: AgentTaskWorkspacePort

  constructor(options: AgentTaskIpcControllerOptions) {
    this.store = options.store
    this.coordinator = options.coordinator
    this.workspaces = options.workspaces
  }

  recoverInterrupted(): number {
    return this.coordinator.recoverInterruptedTasks()
  }

  list(limit: unknown = 50): AgentTaskView[] {
    return this.store.listTasks(safeLimit(limit, 50, 200))
  }

  async create(input: unknown): Promise<AgentResult<AgentTaskView>> {
    try {
      return await this.coordinator.createTask(parseCreateInput(input))
    } catch (error) {
      return fail(error)
    }
  }

  get(taskId: unknown): AgentTaskDetailView | null {
    if (!validTaskId(taskId)) return null
    const task = this.store.getTask(taskId)
    if (!task) return null
    return {
      task,
      steps: this.store.listSteps(taskId),
      events: this.store.listEvents(taskId)
    }
  }

  start(taskId: unknown): Promise<AgentResult<AgentTaskView>> {
    return this.taskAction(taskId, (id) => this.coordinator.start(id))
  }

  approvePlan(taskId: unknown): Promise<AgentResult<AgentTaskView>> {
    return this.taskAction(taskId, (id) => this.coordinator.approvePlan(id))
  }

  pause(taskId: unknown): Promise<AgentResult<AgentTaskView>> {
    return this.taskAction(taskId, (id) => this.coordinator.pause(id))
  }

  resume(taskId: unknown): Promise<AgentResult<AgentTaskView>> {
    return this.taskAction(taskId, (id) => this.coordinator.resume(id))
  }

  cancel(taskId: unknown): Promise<AgentResult<AgentTaskView>> {
    return this.taskAction(taskId, (id) => this.coordinator.cancel(id))
  }

  chat(taskId: unknown, text: unknown): Promise<AgentResult<AgentTaskEventView>> {
    if (!validTaskId(taskId)) return Promise.resolve(fail('invalid_task_id'))
    if (
      typeof text !== 'string' ||
      text.trim().length === 0 ||
      Buffer.byteLength(text, 'utf8') > MAX_TASK_BYTES
    ) {
      return Promise.resolve(fail('task_chat_invalid'))
    }
    return this.coordinator.chat(taskId, text)
  }

  apply(taskId: unknown): Promise<AgentResult<null>> {
    return this.taskAction(taskId, (id) => this.coordinator.apply(id))
  }

  removeWorktree(taskId: unknown): Promise<AgentResult<null>> {
    return this.taskAction(taskId, (id) => this.coordinator.removeWorktree(id))
  }

  respondPermission(
    taskId: unknown,
    requestId: unknown,
    decision: unknown
  ): Promise<AgentResult<null>> {
    if (!validTaskId(taskId)) return Promise.resolve(fail('invalid_task_id'))
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
      return Promise.resolve(fail('invalid_permission_request_id'))
    }
    if (
      decision !== 'allow_once' &&
      decision !== 'allow_session' &&
      decision !== 'reject_once' &&
      decision !== 'reject_session'
    ) {
      return Promise.resolve(fail('invalid_permission_decision'))
    }
    return this.coordinator.respondPermission(taskId, requestId, decision)
  }

  events(taskId: unknown, limit: unknown = 500): AgentTaskEventView[] {
    if (!validTaskId(taskId) || !this.store.getTask(taskId)) return []
    return this.store.listEvents(taskId, safeLimit(limit, 500, 2_000))
  }

  async diff(taskId: unknown): Promise<AgentResult<AgentTaskDiffView>> {
    if (!validTaskId(taskId)) return fail('invalid_task_id')
    const task = this.store.getTask(taskId)
    if (!task) return fail('task_not_found')
    if (task.mode === 'plain') return fail('patch_unsupported_plain_directory')
    try {
      const [patch, changedFiles] = await Promise.all([
        this.workspaces.buildPatch(taskId),
        this.workspaces.listChangedFiles(taskId)
      ])
      if (patch.length === 0) return fail('patch_empty')
      const truncated = patch.length > MAX_DIFF_BYTES
      const bytes = truncated ? patch.subarray(0, MAX_DIFF_BYTES) : patch
      return {
        ok: true,
        value: {
          taskId,
          patch: bytes.toString('utf8'),
          changedFiles,
          bytes: patch.length,
          truncated
        }
      }
    } catch (error) {
      return fail(error)
    }
  }

  private taskAction<T>(
    taskId: unknown,
    action: (id: string) => Promise<AgentResult<T>>
  ): Promise<AgentResult<T>> {
    if (!validTaskId(taskId)) return Promise.resolve(fail('invalid_task_id'))
    if (!this.store.getTask(taskId)) return Promise.resolve(fail('task_not_found'))
    return action(taskId)
  }
}
