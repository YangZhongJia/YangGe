import type DatabaseT from 'better-sqlite3'
import type {
  AgentCoordinatorPlan,
  AgentTaskCreateInput,
  AgentTaskEventView,
  AgentTaskRole,
  AgentTaskStatus,
  AgentTaskStepStatus,
  AgentTaskStepView,
  AgentTaskView
} from '../../shared/ipc'

const MAX_PROMPT_BYTES = 128 * 1024
const MAX_EVENT_BYTES = 32 * 1024
const MAX_STEPS = 5

interface TaskRow {
  id: string
  prompt: string
  repo_root: string
  source_branch: string
  base_commit: string
  worktree_path: string
  task_branch: string
  coordinator_agent_id: string
  team_agent_ids: string
  status: string
  plan_json: string | null
  review_round: number
  error: string | null
  created_ts: number
  updated_ts: number
}

interface StepRow {
  id: string
  task_id: string
  ordinal: number
  role: string
  agent_id: string
  title: string
  input: string
  expected_output: string
  depends_on: string
  status: string
  attempt: number
  session_id: string | null
  run_id: string | null
  result: string
  error: string | null
  created_ts: number
  updated_ts: number
}

interface EventRow {
  id: string
  task_id: string
  step_id: string | null
  kind: string
  agent_id: string | null
  text: string
  created_ts: number
}

function parseStrings(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : []
  } catch {
    return []
  }
}

function parsePlan(value: string | null): AgentCoordinatorPlan | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as AgentCoordinatorPlan : null
  } catch {
    return null
  }
}

function toTask(row: TaskRow): AgentTaskView {
  return {
    id: row.id,
    prompt: row.prompt,
    repoPath: row.repo_root,
    sourceBranch: row.source_branch,
    baseCommit: row.base_commit,
    worktreePath: row.worktree_path,
    taskBranch: row.task_branch,
    coordinatorAgentId: row.coordinator_agent_id,
    teamAgentIds: parseStrings(row.team_agent_ids),
    status: row.status as AgentTaskStatus,
    plan: parsePlan(row.plan_json),
    reviewRound: row.review_round,
    error: row.error,
    createdAt: row.created_ts,
    updatedAt: row.updated_ts
  }
}

function toStep(row: StepRow): AgentTaskStepView {
  return {
    id: row.id,
    taskId: row.task_id,
    ordinal: row.ordinal,
    role: row.role as Exclude<AgentTaskRole, 'coordinator'>,
    agentId: row.agent_id,
    title: row.title,
    input: row.input,
    expectedOutput: row.expected_output,
    dependsOn: parseStrings(row.depends_on),
    status: row.status as AgentTaskStepStatus,
    attempt: row.attempt,
    sessionId: row.session_id,
    runId: row.run_id,
    result: row.result,
    error: row.error,
    createdAt: row.created_ts,
    updatedAt: row.updated_ts
  }
}

function toEvent(row: EventRow): AgentTaskEventView {
  return {
    id: row.id,
    taskId: row.task_id,
    stepId: row.step_id,
    kind: row.kind,
    agentId: row.agent_id,
    text: row.text,
    createdAt: row.created_ts
  }
}

export class AgentTaskRepo {
  private readonly insertTaskStmt: DatabaseT.Statement
  private readonly selectTaskStmt: DatabaseT.Statement
  private readonly selectTasksStmt: DatabaseT.Statement
  private readonly updateTaskStmt: DatabaseT.Statement
  private readonly insertStepStmt: DatabaseT.Statement
  private readonly selectStepStmt: DatabaseT.Statement
  private readonly selectStepsStmt: DatabaseT.Statement
  private readonly updateStepStmt: DatabaseT.Statement
  private readonly insertEventStmt: DatabaseT.Statement
  private readonly selectEventsStmt: DatabaseT.Statement

  constructor(db: DatabaseT.Database) {
    this.insertTaskStmt = db.prepare(`
      INSERT INTO agent_tasks (
        id, prompt, repo_root, source_branch, base_commit, worktree_path,
        task_branch, coordinator_agent_id, team_agent_ids, status, created_ts, updated_ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `)
    this.selectTaskStmt = db.prepare('SELECT * FROM agent_tasks WHERE id = ?')
    this.selectTasksStmt = db.prepare('SELECT * FROM agent_tasks ORDER BY updated_ts DESC LIMIT ?')
    this.updateTaskStmt = db.prepare(`
      UPDATE agent_tasks SET
        status = CASE WHEN @hasStatus THEN @status ELSE status END,
        plan_json = CASE WHEN @hasPlan THEN @planJson ELSE plan_json END,
        review_round = CASE WHEN @hasReviewRound THEN @reviewRound ELSE review_round END,
        error = CASE WHEN @hasError THEN @error ELSE error END,
        updated_ts = @updatedAt
      WHERE id = @id
    `)
    this.insertStepStmt = db.prepare(`
      INSERT INTO agent_task_steps (
        id, task_id, ordinal, role, agent_id, title, input, expected_output,
        depends_on, status, attempt, session_id, run_id, result, error, created_ts, updated_ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.selectStepStmt = db.prepare('SELECT * FROM agent_task_steps WHERE id = ?')
    this.selectStepsStmt = db.prepare('SELECT * FROM agent_task_steps WHERE task_id = ? ORDER BY ordinal')
    this.updateStepStmt = db.prepare(`
      UPDATE agent_task_steps SET
        status = CASE WHEN @hasStatus THEN @status ELSE status END,
        attempt = CASE WHEN @hasAttempt THEN @attempt ELSE attempt END,
        session_id = CASE WHEN @hasSessionId THEN @sessionId ELSE session_id END,
        run_id = CASE WHEN @hasRunId THEN @runId ELSE run_id END,
        result = CASE WHEN @hasResult THEN @result ELSE result END,
        error = CASE WHEN @hasError THEN @error ELSE error END,
        updated_ts = @updatedAt
      WHERE id = @id
    `)
    this.insertEventStmt = db.prepare(`
      INSERT INTO agent_task_events (id, task_id, step_id, kind, agent_id, text, created_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `)
    this.selectEventsStmt = db.prepare(`
      SELECT * FROM agent_task_events WHERE task_id = ? ORDER BY created_ts, id LIMIT ?
    `)
  }

  createTask(task: AgentTaskCreateInput): AgentTaskView {
    if (Buffer.byteLength(task.prompt, 'utf8') > MAX_PROMPT_BYTES) throw new Error('任务描述过长')
    if (task.teamAgentIds.length > 16) throw new Error('每个任务最多选择 16 个 Agent')
    this.insertTaskStmt.run(
      task.id,
      task.prompt,
      task.repoPath,
      task.sourceBranch,
      task.baseCommit,
      task.worktreePath,
      task.taskBranch,
      task.coordinatorAgentId,
      JSON.stringify(task.teamAgentIds),
      task.createdAt,
      task.createdAt
    )
    return this.getTask(task.id)!
  }

  getTask(id: string): AgentTaskView | null {
    const row = this.selectTaskStmt.get(id) as TaskRow | undefined
    return row ? toTask(row) : null
  }

  listTasks(limit = 50): AgentTaskView[] {
    const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50
    return (this.selectTasksStmt.all(safeLimit) as TaskRow[]).map(toTask)
  }

  updateTask(
    id: string,
    patch: {
      status?: AgentTaskStatus
      plan?: AgentCoordinatorPlan | null
      reviewRound?: number
      error?: string | null
      updatedAt?: number
    }
  ): AgentTaskView | null {
    const hasPlan = Object.prototype.hasOwnProperty.call(patch, 'plan')
    const hasError = Object.prototype.hasOwnProperty.call(patch, 'error')
    this.updateTaskStmt.run({
      id,
      hasStatus: patch.status !== undefined ? 1 : 0,
      status: patch.status ?? null,
      hasPlan: hasPlan ? 1 : 0,
      planJson: hasPlan && patch.plan ? JSON.stringify(patch.plan) : null,
      hasReviewRound: patch.reviewRound !== undefined ? 1 : 0,
      reviewRound: patch.reviewRound ?? null,
      hasError: hasError ? 1 : 0,
      error: patch.error ?? null,
      updatedAt: patch.updatedAt ?? Date.now()
    })
    return this.getTask(id)
  }

  createStep(step: AgentTaskStepView): AgentTaskStepView {
    if (step.ordinal < 0 || step.ordinal >= MAX_STEPS) throw new Error('任务步骤序号越界')
    if (Buffer.byteLength(step.input, 'utf8') > 32 * 1024) throw new Error('步骤输入过长')
    this.insertStepStmt.run(
      step.id,
      step.taskId,
      step.ordinal,
      step.role,
      step.agentId,
      step.title,
      step.input,
      step.expectedOutput,
      JSON.stringify(step.dependsOn),
      step.status,
      step.attempt,
      step.sessionId,
      step.runId,
      step.result,
      step.error,
      step.createdAt,
      step.updatedAt
    )
    return this.getStep(step.id)!
  }

  private getStep(id: string): AgentTaskStepView | null {
    const row = this.selectStepStmt.get(id) as StepRow | undefined
    return row ? toStep(row) : null
  }

  listSteps(taskId: string): AgentTaskStepView[] {
    return (this.selectStepsStmt.all(taskId) as StepRow[]).map(toStep)
  }

  updateStep(
    id: string,
    patch: {
      status?: AgentTaskStepStatus
      attempt?: number
      sessionId?: string | null
      runId?: string | null
      result?: string
      error?: string | null
      updatedAt?: number
    }
  ): AgentTaskStepView | null {
    const has = (key: keyof typeof patch): number => Object.prototype.hasOwnProperty.call(patch, key) ? 1 : 0
    this.updateStepStmt.run({
      id,
      hasStatus: has('status'),
      status: patch.status ?? null,
      hasAttempt: has('attempt'),
      attempt: patch.attempt ?? null,
      hasSessionId: has('sessionId'),
      sessionId: patch.sessionId ?? null,
      hasRunId: has('runId'),
      runId: patch.runId ?? null,
      hasResult: has('result'),
      result: patch.result ?? null,
      hasError: has('error'),
      error: patch.error ?? null,
      updatedAt: patch.updatedAt ?? Date.now()
    })
    return this.getStep(id)
  }

  appendEvent(event: AgentTaskEventView): void {
    if (Buffer.byteLength(event.text, 'utf8') > MAX_EVENT_BYTES) throw new Error('任务事件过长')
    this.insertEventStmt.run(
      event.id,
      event.taskId,
      event.stepId,
      event.kind,
      event.agentId,
      event.text,
      event.createdAt
    )
  }

  listEvents(taskId: string, limit = 500): AgentTaskEventView[] {
    const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 2000 ? limit : 500
    return (this.selectEventsStmt.all(taskId, safeLimit) as EventRow[]).map(toEvent)
  }
}
