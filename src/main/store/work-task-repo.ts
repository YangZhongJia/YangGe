import type DatabaseT from 'better-sqlite3'
import type {
  WorkTaskFilter,
  WorkTaskProjectView,
  WorkTaskShareView,
  WorkTaskView
} from '../../shared/ipc'
import type { WorkTaskSyncSnapshot } from '../../shared/protocol'
import type { WorkTaskDeliveryState, WorkTaskStatus } from '../../shared/work-task'

export interface WorkTaskProjectRecord {
  id: string
  ownerNodeId: string
  name: string
  createdAt: number
  updatedAt: number
}

export interface WorkTaskRecord {
  id: string
  ownerNodeId: string
  projectId: string
  title: string
  description: string
  startDate: string | null
  dueDate: string | null
  status: WorkTaskStatus
  revision: number
  createdAt: number
  updatedAt: number
}

export interface WorkTaskOwnerPatch {
  projectId?: string
  title?: string
  description?: string
  startDate?: string | null
  dueDate?: string | null
  status?: WorkTaskStatus
}

export interface WorkTaskReminderCandidate {
  id: string
  ownerNodeId: string
  title: string
  dueDate: string
  status: WorkTaskStatus
  dueRemindedOn: string | null
}

export interface WorkTaskShareRecord {
  taskId: string
  peerId: string
  revision: number
  lastMessageId: string | null
  state: WorkTaskDeliveryState
  createdAt: number
  updatedAt: number
}

interface ProjectRow {
  id: string
  owner_node_id: string
  name: string
  created_ts: number
  updated_ts: number
}

interface TaskRow {
  id: string
  owner_node_id: string
  project_id: string
  title: string
  description: string
  start_date: string | null
  due_date: string | null
  status: string
  revision: number
  active: number
  due_reminded_on: string | null
  created_ts: number
  updated_ts: number
}

interface ShareRow {
  task_id: string
  peer_id: string
  revision: number
  last_message_id: string | null
  delivery_state: string
  created_ts: number
  updated_ts: number
}

function toProject(row: ProjectRow, viewerNodeId: string): WorkTaskProjectView {
  return {
    id: row.id,
    ownerNodeId: row.owner_node_id,
    name: row.name,
    isShared: row.owner_node_id !== viewerNodeId,
    createdAt: row.created_ts,
    updatedAt: row.updated_ts
  }
}

function toShare(row: ShareRow): WorkTaskShareView {
  return {
    peerId: row.peer_id,
    state: row.delivery_state as WorkTaskDeliveryState,
    revision: row.revision,
    updatedAt: row.updated_ts
  }
}

function toShareRecord(row: ShareRow): WorkTaskShareRecord {
  return {
    taskId: row.task_id,
    peerId: row.peer_id,
    revision: row.revision,
    lastMessageId: row.last_message_id,
    state: row.delivery_state as WorkTaskDeliveryState,
    createdAt: row.created_ts,
    updatedAt: row.updated_ts
  }
}

function toTask(row: TaskRow, shares: WorkTaskShareView[], viewerNodeId: string): WorkTaskView {
  return {
    id: row.id,
    ownerNodeId: row.owner_node_id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    startDate: row.start_date,
    dueDate: row.due_date,
    status: row.status as WorkTaskStatus,
    revision: row.revision,
    active: row.active === 1,
    isShared: row.owner_node_id !== viewerNodeId,
    createdAt: row.created_ts,
    updatedAt: row.updated_ts,
    shares: row.owner_node_id === viewerNodeId ? shares : []
  }
}

export class WorkTaskRepo {
  private readonly insertProjectStmt: DatabaseT.Statement
  private readonly selectProjectStmt: DatabaseT.Statement
  private readonly selectProjectsStmt: DatabaseT.Statement
  private readonly renameProjectStmt: DatabaseT.Statement
  private readonly deleteProjectStmt: DatabaseT.Statement
  private readonly countProjectTasksStmt: DatabaseT.Statement
  private readonly upsertRemoteProjectStmt: DatabaseT.Statement
  private readonly insertTaskStmt: DatabaseT.Statement
  private readonly selectTaskStmt: DatabaseT.Statement
  private readonly selectTasksStmt: DatabaseT.Statement
  private readonly selectReminderCandidatesStmt: DatabaseT.Statement
  private readonly markDueRemindedStmt: DatabaseT.Statement
  private readonly selectReminderStateStmt: DatabaseT.Statement
  private readonly setReminderStateStmt: DatabaseT.Statement
  private readonly updateTaskStmt: DatabaseT.Statement
  private readonly bumpRevisionStmt: DatabaseT.Statement
  private readonly deactivateTaskStmt: DatabaseT.Statement
  private readonly upsertRemoteTaskStmt: DatabaseT.Statement
  private readonly revokeRemoteTaskStmt: DatabaseT.Statement
  private readonly insertShareStmt: DatabaseT.Statement
  private readonly updateShareStmt: DatabaseT.Statement
  private readonly selectSharesStmt: DatabaseT.Statement
  private readonly updateShareByMessageStmt: DatabaseT.Statement
  private readonly selectShareByMessageStmt: DatabaseT.Statement
  private readonly revokeShareStmt: DatabaseT.Statement

  constructor(private readonly db: DatabaseT.Database) {
    this.insertProjectStmt = db.prepare(`
      INSERT INTO work_task_projects (id, owner_node_id, name, created_ts, updated_ts)
      VALUES (@id, @ownerNodeId, @name, @createdAt, @updatedAt)
    `)
    this.selectProjectStmt = db.prepare(
      'SELECT * FROM work_task_projects WHERE owner_node_id = ? AND id = ?'
    )
    // 本机项目 + 仍有活动共享任务引用的远端项目影子记录。
    this.selectProjectsStmt = db.prepare(`
      SELECT p.* FROM work_task_projects p
      WHERE p.owner_node_id = @viewer
        OR EXISTS (
          SELECT 1 FROM work_tasks t
          WHERE t.owner_node_id = p.owner_node_id
            AND t.project_id = p.id
            AND t.active = 1
            AND t.owner_node_id <> @viewer
        )
      ORDER BY p.name COLLATE NOCASE ASC
    `)
    this.renameProjectStmt = db.prepare(`
      UPDATE work_task_projects SET name = @name, updated_ts = @updatedAt
      WHERE owner_node_id = @ownerNodeId AND id = @id
    `)
    this.deleteProjectStmt = db.prepare(
      'DELETE FROM work_task_projects WHERE owner_node_id = ? AND id = ?'
    )
    this.countProjectTasksStmt = db.prepare(
      'SELECT COUNT(*) AS count FROM work_tasks WHERE owner_node_id = ? AND project_id = ? AND active = 1'
    )
    this.upsertRemoteProjectStmt = db.prepare(`
      INSERT INTO work_task_projects (id, owner_node_id, name, created_ts, updated_ts)
      VALUES (@id, @ownerNodeId, @name, @updatedAt, @updatedAt)
      ON CONFLICT(owner_node_id, id) DO UPDATE SET
        name = excluded.name,
        updated_ts = excluded.updated_ts
      WHERE excluded.updated_ts >= work_task_projects.updated_ts
    `)
    this.insertTaskStmt = db.prepare(`
      INSERT INTO work_tasks (
        id, owner_node_id, project_id, title, description, start_date, due_date,
        status, revision, active, created_ts, updated_ts
      ) VALUES (
        @id, @ownerNodeId, @projectId, @title, @description, @startDate, @dueDate,
        @status, @revision, 1, @createdAt, @updatedAt
      )
    `)
    this.selectTaskStmt = db.prepare(
      'SELECT * FROM work_tasks WHERE owner_node_id = ? AND id = ?'
    )
    this.selectReminderCandidatesStmt = db.prepare(`
      SELECT id, owner_node_id, title, due_date, status, due_reminded_on
      FROM work_tasks
      WHERE active = 1 AND status <> 'completed' AND due_date IS NOT NULL
      ORDER BY due_date ASC, updated_ts DESC
    `)
    this.markDueRemindedStmt = db.prepare(`
      UPDATE work_tasks SET due_reminded_on = @date, updated_ts = @updatedAt
      WHERE owner_node_id = @ownerNodeId AND id = @id
    `)
    this.selectReminderStateStmt = db.prepare(
      'SELECT value FROM work_task_reminder_state WHERE key = ?'
    )
    this.setReminderStateStmt = db.prepare(`
      INSERT INTO work_task_reminder_state (key, value, updated_ts)
      VALUES (@key, @value, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ts = excluded.updated_ts
    `)
    this.selectTasksStmt = db.prepare(`
      SELECT * FROM work_tasks
      WHERE active = 1
        AND (
          @scope = 'all'
          OR (@scope = 'owned' AND owner_node_id = @viewer)
          OR (@scope = 'shared' AND owner_node_id <> @viewer)
        )
        AND (@projectId IS NULL OR project_id = @projectId)
        AND (@startFrom IS NULL OR (start_date IS NOT NULL AND start_date >= @startFrom))
        AND (@startTo IS NULL OR (start_date IS NOT NULL AND start_date <= @startTo))
        AND (@dueFrom IS NULL OR (due_date IS NOT NULL AND due_date >= @dueFrom))
        AND (@dueTo IS NULL OR (due_date IS NOT NULL AND due_date <= @dueTo))
      ORDER BY (due_date IS NULL) ASC, due_date ASC, updated_ts DESC
    `)
    this.updateTaskStmt = db.prepare(`
      UPDATE work_tasks SET
        project_id = CASE WHEN @hasProjectId THEN @projectId ELSE project_id END,
        title = CASE WHEN @hasTitle THEN @title ELSE title END,
        description = CASE WHEN @hasDescription THEN @description ELSE description END,
        start_date = CASE WHEN @hasStartDate THEN @startDate ELSE start_date END,
        due_date = CASE WHEN @hasDueDate THEN @dueDate ELSE due_date END,
        status = CASE WHEN @hasStatus THEN @status ELSE status END,
        due_reminded_on = CASE WHEN @hasDueDate THEN NULL ELSE due_reminded_on END,
        revision = revision + 1,
        updated_ts = @updatedAt
      WHERE owner_node_id = @ownerNodeId AND id = @id
    `)
    this.bumpRevisionStmt = db.prepare(`
      UPDATE work_tasks SET revision = revision + 1, updated_ts = @updatedAt
      WHERE owner_node_id = @ownerNodeId AND id = @id
    `)
    this.deactivateTaskStmt = db.prepare(`
      UPDATE work_tasks SET active = 0, revision = revision + 1, updated_ts = @updatedAt
      WHERE owner_node_id = @ownerNodeId AND id = @id
    `)
    this.upsertRemoteTaskStmt = db.prepare(`
      INSERT INTO work_tasks (
        id, owner_node_id, project_id, title, description, start_date, due_date,
        status, revision, active, created_ts, updated_ts
      ) VALUES (
        @id, @ownerNodeId, @projectId, @title, @description, @startDate, @dueDate,
        @status, @revision, 1, @createdAt, @updatedAt
      )
      ON CONFLICT(owner_node_id, id) DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        description = excluded.description,
        start_date = excluded.start_date,
        due_date = excluded.due_date,
        status = excluded.status,
        revision = excluded.revision,
        active = 1,
        due_reminded_on = CASE
          WHEN work_tasks.due_date IS excluded.due_date THEN work_tasks.due_reminded_on
          ELSE NULL
        END,
        updated_ts = excluded.updated_ts
      WHERE excluded.revision > work_tasks.revision
    `)
    this.revokeRemoteTaskStmt = db.prepare(`
      UPDATE work_tasks SET active = 0, revision = @revision, updated_ts = @updatedAt
      WHERE owner_node_id = @ownerNodeId AND id = @id AND revision <= @revision
    `)
    this.insertShareStmt = db.prepare(`
      INSERT INTO work_task_shares (
        task_id, peer_id, revision, last_message_id, delivery_state, created_ts, updated_ts
      ) VALUES (@taskId, @peerId, @revision, @lastMessageId, @state, @createdAt, @updatedAt)
      ON CONFLICT(task_id, peer_id) DO UPDATE SET
        revision = excluded.revision,
        last_message_id = excluded.last_message_id,
        delivery_state = excluded.delivery_state,
        updated_ts = excluded.updated_ts
    `)
    this.updateShareStmt = db.prepare(`
      UPDATE work_task_shares SET
        revision = @revision,
        last_message_id = @lastMessageId,
        delivery_state = @state,
        updated_ts = @updatedAt
      WHERE task_id = @taskId AND peer_id = @peerId
    `)
    this.selectSharesStmt = db.prepare(`
      SELECT * FROM work_task_shares
      WHERE task_id = @taskId AND delivery_state <> 'revoked'
      ORDER BY updated_ts DESC
    `)
    this.selectShareByMessageStmt = db.prepare(`
      SELECT task_id, peer_id FROM work_task_shares
      WHERE last_message_id = ? AND delivery_state <> 'revoked'
      LIMIT 1
    `)
    this.updateShareByMessageStmt = db.prepare(`
      UPDATE work_task_shares SET delivery_state = @state, updated_ts = @updatedAt
      WHERE last_message_id = @messageId AND delivery_state <> 'revoked'
    `)
    this.revokeShareStmt = db.prepare(`
      UPDATE work_task_shares SET delivery_state = 'revoked', updated_ts = @updatedAt
      WHERE task_id = @taskId AND peer_id = @peerId
    `)
  }

  listProjects(viewerNodeId: string): WorkTaskProjectView[] {
    return (this.selectProjectsStmt.all({ viewer: viewerNodeId }) as ProjectRow[]).map((row) =>
      toProject(row, viewerNodeId)
    )
  }

  getProject(ownerNodeId: string, id: string): WorkTaskProjectView | null {
    const row = this.selectProjectStmt.get(ownerNodeId, id) as ProjectRow | undefined
    return row ? toProject(row, ownerNodeId) : null
  }

  createProject(record: WorkTaskProjectRecord): WorkTaskProjectView {
    this.insertProjectStmt.run(record)
    const row = this.selectProjectStmt.get(record.ownerNodeId, record.id) as ProjectRow
    return toProject(row, record.ownerNodeId)
  }

  renameProject(ownerNodeId: string, id: string, name: string, updatedAt: number): boolean {
    return this.renameProjectStmt.run({ ownerNodeId, id, name, updatedAt }).changes > 0
  }

  deleteProject(ownerNodeId: string, id: string): boolean {
    return this.deleteProjectStmt.run(ownerNodeId, id).changes > 0
  }

  countProjectTasks(ownerNodeId: string, projectId: string): number {
    const row = this.countProjectTasksStmt.get(ownerNodeId, projectId) as { count: number }
    return row.count
  }

  listTasks(filter: WorkTaskFilter, viewerNodeId: string): WorkTaskView[] {
    const rows = this.selectTasksStmt.all({
      scope: filter.scope,
      viewer: viewerNodeId,
      projectId: filter.projectId ?? null,
      startFrom: filter.startFrom ?? null,
      startTo: filter.startTo ?? null,
      dueFrom: filter.dueFrom ?? null,
      dueTo: filter.dueTo ?? null
    }) as TaskRow[]
    return rows.map((row) =>
      toTask(row, row.owner_node_id === viewerNodeId ? this.listShares(row.id) : [], viewerNodeId)
    )
  }

  listReminderCandidates(): WorkTaskReminderCandidate[] {
    return (
      this.selectReminderCandidatesStmt.all() as Array<{
        id: string
        owner_node_id: string
        title: string
        due_date: string
        status: string
        due_reminded_on: string | null
      }>
    ).map((row) => ({
      id: row.id,
      ownerNodeId: row.owner_node_id,
      title: row.title,
      dueDate: row.due_date,
      status: row.status as WorkTaskStatus,
      dueRemindedOn: row.due_reminded_on
    }))
  }

  markDueReminded(
    entries: Array<{ ownerNodeId: string; id: string }>,
    date: string,
    updatedAt: number
  ): void {
    const transaction = this.db.transaction(() => {
      for (const entry of entries) {
        this.markDueRemindedStmt.run({
          ownerNodeId: entry.ownerNodeId,
          id: entry.id,
          date,
          updatedAt
        })
      }
    })
    transaction()
  }

  getReminderState(key: string): string | null {
    const row = this.selectReminderStateStmt.get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setReminderState(key: string, value: string, updatedAt: number): void {
    this.setReminderStateStmt.run({ key, value, updatedAt })
  }

  getTask(ownerNodeId: string, id: string, viewerNodeId = ownerNodeId): WorkTaskView | null {
    const row = this.selectTaskStmt.get(ownerNodeId, id) as TaskRow | undefined
    if (!row) return null
    return toTask(row, row.owner_node_id === viewerNodeId ? this.listShares(row.id) : [], viewerNodeId)
  }

  createTask(record: WorkTaskRecord): WorkTaskView {
    this.insertTaskStmt.run(record)
    return this.getTask(record.ownerNodeId, record.id)!
  }

  updateOwnerTask(
    ownerNodeId: string,
    id: string,
    patch: WorkTaskOwnerPatch,
    updatedAt: number
  ): WorkTaskView | null {
    const result = this.updateTaskStmt.run({
      ownerNodeId,
      id,
      hasProjectId: patch.projectId !== undefined ? 1 : 0,
      projectId: patch.projectId ?? '',
      hasTitle: patch.title !== undefined ? 1 : 0,
      title: patch.title ?? '',
      hasDescription: patch.description !== undefined ? 1 : 0,
      description: patch.description ?? '',
      hasStartDate: patch.startDate !== undefined ? 1 : 0,
      startDate: patch.startDate ?? null,
      hasDueDate: patch.dueDate !== undefined ? 1 : 0,
      dueDate: patch.dueDate ?? null,
      hasStatus: patch.status !== undefined ? 1 : 0,
      status: patch.status ?? 'not_started',
      updatedAt
    })
    if (result.changes === 0) return null
    return this.getTask(ownerNodeId, id, ownerNodeId)
  }

  bumpTaskRevision(ownerNodeId: string, id: string, updatedAt: number): WorkTaskView | null {
    const result = this.bumpRevisionStmt.run({ ownerNodeId, id, updatedAt })
    if (result.changes === 0) return null
    return this.getTask(ownerNodeId, id, ownerNodeId)
  }

  markTaskInactive(ownerNodeId: string, id: string, updatedAt: number): boolean {
    return this.deactivateTaskStmt.run({ ownerNodeId, id, updatedAt }).changes > 0
  }

  /** 幂等接收共享快照；只有严格更新的 revision 才会覆盖本地副本。 */
  applyRemoteSnapshot(snapshot: WorkTaskSyncSnapshot, receivedAt: number): boolean {
    const { task, project } = snapshot
    const transaction = this.db.transaction(() => {
      this.upsertRemoteProjectStmt.run({
        id: project.id,
        ownerNodeId: project.ownerNodeId,
        name: project.name,
        updatedAt: project.updatedAt
      })
      const result = this.upsertRemoteTaskStmt.run({
        id: task.id,
        ownerNodeId: task.ownerNodeId,
        projectId: task.projectId,
        title: task.title,
        description: task.description,
        startDate: task.startDate,
        dueDate: task.dueDate,
        status: task.status,
        revision: task.revision,
        createdAt: task.createdAt,
        updatedAt: receivedAt
      })
      return result.changes > 0
    })
    return transaction()
  }

  /** 撤销共享只隐藏副本；相等 revision 也接受，保证重复 revoke 幂等。 */
  applyRemoteRevoke(
    ownerNodeId: string,
    taskId: string,
    revision: number,
    receivedAt: number
  ): boolean {
    return this.revokeRemoteTaskStmt.run({ ownerNodeId, id: taskId, revision, updatedAt: receivedAt })
      .changes > 0
  }

  listShares(taskId: string): WorkTaskShareView[] {
    return (this.selectSharesStmt.all({ taskId }) as ShareRow[]).map(toShare)
  }

  listShareRecords(taskId: string): WorkTaskShareRecord[] {
    return (this.selectSharesStmt.all({ taskId }) as ShareRow[]).map(toShareRecord)
  }

  upsertShare(record: WorkTaskShareRecord): void {
    this.insertShareStmt.run(record)
  }

  updateShare(
    taskId: string,
    peerId: string,
    patch: {
      revision: number
      lastMessageId: string | null
      state: WorkTaskDeliveryState
      updatedAt: number
    }
  ): void {
    this.updateShareStmt.run({ taskId, peerId, ...patch })
  }

  /** 离线补发成功后由 messenger status 事件回填最终状态。 */
  updateShareByMessageId(
    messageId: string,
    state: WorkTaskDeliveryState,
    updatedAt: number
  ): { taskId: string; peerId: string } | null {
    const row = this.selectShareByMessageStmt.get(messageId) as
      | { task_id: string; peer_id: string }
      | undefined
    if (!row) return null
    this.updateShareByMessageStmt.run({ messageId, state, updatedAt })
    return { taskId: row.task_id, peerId: row.peer_id }
  }

  markShareRevoked(taskId: string, peerId: string, updatedAt: number): void {
    this.revokeShareStmt.run({ taskId, peerId, updatedAt })
  }
}
