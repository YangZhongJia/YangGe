import { randomUUID } from 'node:crypto'
import type {
  WorkTaskCreateInput,
  WorkTaskFilter,
  WorkTaskPatch,
  WorkTaskProjectView,
  WorkTaskShareView,
  WorkTaskView
} from '../../shared/ipc'
import type {
  WorkTaskSyncProject,
  WorkTaskSyncSnapshot,
  WorkTaskSyncTask
} from '../../shared/protocol'
import {
  isWorkTaskDate,
  isWorkTaskStatus,
  isValidWorkTaskDateRange,
  WORK_TASK_LIMITS,
  type WorkTaskDeliveryState,
  type WorkTaskStatus
} from '../../shared/work-task'
import type { WorkTaskShareRecord } from '../store/work-task-repo'

export type { WorkTaskShareRecord } from '../store/work-task-repo'

const MAX_SHARE_PEERS = 16

export interface WorkTaskTaskRecord {
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

/** 服务只依赖这些窄接口，测试可用内存实现，生产由 WorkTaskRepo 满足。 */
export interface WorkTaskStorePort {
  listProjects(viewerNodeId: string): WorkTaskProjectView[]
  getProject(ownerNodeId: string, id: string): WorkTaskProjectView | null
  createProject(record: {
    id: string
    ownerNodeId: string
    name: string
    createdAt: number
    updatedAt: number
  }): WorkTaskProjectView
  renameProject(ownerNodeId: string, id: string, name: string, updatedAt: number): boolean
  deleteProject(ownerNodeId: string, id: string): boolean
  countProjectTasks(ownerNodeId: string, projectId: string): number
  listTasks(filter: WorkTaskFilter, viewerNodeId: string): WorkTaskView[]
  getTask(ownerNodeId: string, id: string, viewerNodeId?: string): WorkTaskView | null
  createTask(record: WorkTaskTaskRecord): WorkTaskView
  updateOwnerTask(
    ownerNodeId: string,
    id: string,
    patch: WorkTaskOwnerPatch,
    updatedAt: number
  ): WorkTaskView | null
  bumpTaskRevision(ownerNodeId: string, id: string, updatedAt: number): WorkTaskView | null
  markTaskInactive(ownerNodeId: string, id: string, updatedAt: number): boolean
  applyRemoteSnapshot(snapshot: WorkTaskSyncSnapshot, receivedAt: number): boolean
  applyRemoteRevoke(
    ownerNodeId: string,
    taskId: string,
    revision: number,
    receivedAt: number
  ): boolean
  listShares(taskId: string): WorkTaskShareView[]
  listShareRecords(taskId: string): WorkTaskShareRecord[]
  upsertShare(record: WorkTaskShareRecord): void
  updateShareByMessageId(
    messageId: string,
    state: WorkTaskDeliveryState,
    updatedAt: number
  ): { taskId: string; peerId: string } | null
  markShareRevoked(taskId: string, peerId: string, updatedAt: number): void
}

export interface WorkTaskSyncPort {
  /** 对端是否声明了 tsk1 能力。 */
  canShare(peerId: string): boolean
  /** 返回投递状态与报文 id；报文 id 用于把离线补发结果回填到共享记录。 */
  sendUpsert(
    peerId: string,
    snapshot: WorkTaskSyncSnapshot
  ): Promise<{ state: WorkTaskDeliveryState; messageId: string }>
  sendRevoke(peerId: string, taskId: string, revision: number): Promise<WorkTaskDeliveryState>
}

export interface WorkTaskServiceOptions {
  store: WorkTaskStorePort
  selfId: string
  sync: WorkTaskSyncPort
  emit: (task: WorkTaskView) => void
  now?: () => number
  id?: () => string
}

function requireTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('任务标题不能为空')
  }
  const title = value.trim()
  if (title.length > WORK_TASK_LIMITS.title) {
    throw new Error(`任务标题不能超过 ${WORK_TASK_LIMITS.title} 个字符`)
  }
  return title
}

function requireDescription(value: unknown): string {
  const description = typeof value === 'string' ? value.trim() : ''
  if (Buffer.byteLength(description, 'utf8') > WORK_TASK_LIMITS.descriptionBytes) {
    throw new Error('任务说明过长')
  }
  return description
}

function requireProjectName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('项目名不能为空')
  }
  const name = value.trim()
  if (name.length > WORK_TASK_LIMITS.projectName) {
    throw new Error(`项目名不能超过 ${WORK_TASK_LIMITS.projectName} 个字符`)
  }
  return name
}

function optionalDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (!isWorkTaskDate(value)) throw new Error(`${label}无效`)
  return value
}

function requireTaskId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new Error('任务标识不合法')
  }
  return value
}

function toSyncTask(task: WorkTaskView): WorkTaskSyncTask {
  return {
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
    updatedAt: task.updatedAt
  }
}

function toSyncProject(project: WorkTaskProjectView): WorkTaskSyncProject {
  return {
    id: project.id,
    ownerNodeId: project.ownerNodeId,
    name: project.name,
    updatedAt: project.updatedAt
  }
}

export class WorkTaskService {
  private readonly store: WorkTaskStorePort
  private readonly selfId: string
  private readonly sync: WorkTaskSyncPort
  private readonly emit: (task: WorkTaskView) => void
  private readonly now: () => number
  private readonly id: () => string

  constructor(options: WorkTaskServiceOptions) {
    // 归属判定只认主进程的 appState.nodeId。空身份会把所有本机任务误判为共享只读，
    // 因此这里直接拒绝，绝不以空字符串作为 viewer 继续运行。
    if (
      typeof options.selfId !== 'string' ||
      options.selfId.length === 0 ||
      options.selfId.length > 64
    ) {
      throw new Error('任务服务缺少本机身份')
    }
    this.store = options.store
    this.selfId = options.selfId
    this.sync = options.sync
    this.emit = options.emit
    this.now = options.now ?? Date.now
    this.id = options.id ?? (() => randomUUID())
  }

  listProjects(): WorkTaskProjectView[] {
    return this.store.listProjects(this.selfId)
  }

  listTasks(filter: WorkTaskFilter): WorkTaskView[] {
    return this.store.listTasks(this.normalizeFilter(filter), this.selfId)
  }

  createProject(name: unknown): WorkTaskProjectView {
    const clean = requireProjectName(name)
    const stamp = this.now()
    return this.store.createProject({
      id: this.id(),
      ownerNodeId: this.selfId,
      name: clean,
      createdAt: stamp,
      updatedAt: stamp
    })
  }

  async renameProject(projectId: unknown, name: unknown): Promise<WorkTaskProjectView> {
    const id = requireTaskId(projectId)
    const project = this.store.getProject(this.selfId, id)
    if (!project) throw new Error('项目不存在')
    const clean = requireProjectName(name)
    const stamp = this.now()
    if (!this.store.renameProject(this.selfId, id, clean, stamp)) {
      throw new Error('项目不存在')
    }
    // 项目名随任务快照同步；改名后重发项目下所有已共享任务。
    const tasks = this.store.listTasks({ scope: 'owned', projectId: id }, this.selfId)
    for (const task of tasks) {
      if (task.shares.length === 0) continue
      const bumped = this.store.bumpTaskRevision(this.selfId, task.id, stamp)
      if (!bumped) continue
      await this.publishShares(bumped)
      const latest = this.store.getTask(this.selfId, task.id, this.selfId)
      if (latest) this.emit(latest)
    }
    return this.store.getProject(this.selfId, id)!
  }

  deleteProject(projectId: unknown): boolean {
    const id = requireTaskId(projectId)
    if (!this.store.getProject(this.selfId, id)) throw new Error('项目不存在')
    if (this.store.countProjectTasks(this.selfId, id) > 0) {
      throw new Error('项目下还有任务，不能删除')
    }
    return this.store.deleteProject(this.selfId, id)
  }

  createTask(input: WorkTaskCreateInput): WorkTaskView {
    const title = requireTitle(input.title)
    const description = requireDescription(input.description)
    const projectId = requireTaskId(input.projectId)
    if (!this.store.getProject(this.selfId, projectId)) throw new Error('项目不存在')
    const startDate = optionalDate(input.startDate, '开始日期')
    const dueDate = optionalDate(input.dueDate, '截止日期')
    if (!isValidWorkTaskDateRange(startDate, dueDate)) {
      throw new Error('截止日期不能早于开始日期')
    }
    const stamp = this.now()
    const task = this.store.createTask({
      id: this.id(),
      ownerNodeId: this.selfId,
      projectId,
      title,
      description,
      startDate,
      dueDate,
      status: 'not_started',
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp
    })
    this.emit(task)
    return task
  }

  async updateTask(taskId: unknown, patch: WorkTaskPatch): Promise<WorkTaskView> {
    const id = requireTaskId(taskId)
    const task = this.store.getTask(this.selfId, id, this.selfId)
    if (!task || !task.active) throw new Error('任务不存在或只读')

    const next: WorkTaskOwnerPatch = {}
    if (patch.projectId !== undefined) {
      const projectId = requireTaskId(patch.projectId)
      if (!this.store.getProject(this.selfId, projectId)) throw new Error('项目不存在')
      next.projectId = projectId
    }
    if (patch.title !== undefined) next.title = requireTitle(patch.title)
    if (patch.description !== undefined) next.description = requireDescription(patch.description)
    if (patch.status !== undefined) {
      if (!isWorkTaskStatus(patch.status)) throw new Error('任务状态不合法')
      next.status = patch.status
    }
    const startDate =
      patch.startDate !== undefined ? optionalDate(patch.startDate, '开始日期') : task.startDate
    const dueDate = patch.dueDate !== undefined ? optionalDate(patch.dueDate, '截止日期') : task.dueDate
    if (!isValidWorkTaskDateRange(startDate, dueDate)) {
      throw new Error('截止日期不能早于开始日期')
    }
    if (patch.startDate !== undefined) next.startDate = startDate
    if (patch.dueDate !== undefined) next.dueDate = dueDate

    const updated = this.store.updateOwnerTask(this.selfId, id, next, this.now())
    if (!updated) throw new Error('任务不存在或只读')
    await this.publishShares(updated)
    const latest = this.store.getTask(this.selfId, id, this.selfId)!
    this.emit(latest)
    return latest
  }

  async deleteTask(taskId: unknown): Promise<null> {
    const id = requireTaskId(taskId)
    const task = this.store.getTask(this.selfId, id, this.selfId)
    if (!task) throw new Error('任务不存在或只读')
    for (const share of this.store.listShareRecords(id)) {
      try {
        await this.sync.sendRevoke(share.peerId, id, task.revision)
      } catch {
        // 撤销报文失败仍要隐藏本地任务；对端保留旧副本是 P2P 的既定限制。
      }
      this.store.markShareRevoked(id, share.peerId, this.now())
    }
    this.store.markTaskInactive(this.selfId, id, this.now())
    const latest = this.store.getTask(this.selfId, id, this.selfId)
    if (latest) this.emit(latest)
    return null
  }

  async shareTask(taskId: unknown, peerIds: unknown): Promise<WorkTaskView> {
    const id = requireTaskId(taskId)
    const task = this.store.getTask(this.selfId, id, this.selfId)
    if (!task || !task.active) throw new Error('任务不存在或只读')
    if (
      !Array.isArray(peerIds) ||
      peerIds.length === 0 ||
      peerIds.length > MAX_SHARE_PEERS ||
      !peerIds.every((peerId) => typeof peerId === 'string' && peerId.length > 0 && peerId.length <= 64)
    ) {
      throw new Error('共享同事数量不合法')
    }
    const peers = [...new Set(peerIds)]
    for (const peerId of peers) {
      if (!this.sync.canShare(peerId)) throw new Error('该同事版本不支持任务共享')
    }
    const project = this.store.getProject(this.selfId, task.projectId)
    if (!project) throw new Error('项目不存在')
    // 递增 revision：撤销后重新共享时，接收端本地 revision 已推进，必须用更高版本覆盖。
    const bumped = this.store.bumpTaskRevision(this.selfId, id, this.now())
    if (!bumped) throw new Error('任务不存在或只读')
    const snapshot = this.buildSnapshot(bumped, project)
    const stamp = this.now()
    for (const peerId of peers) {
      this.store.upsertShare({
        taskId: bumped.id,
        peerId,
        revision: bumped.revision,
        lastMessageId: null,
        state: 'queued',
        createdAt: stamp,
        updatedAt: stamp
      })
      let state: WorkTaskDeliveryState = 'failed'
      let messageId: string | null = null
      try {
        const result = await this.sync.sendUpsert(peerId, snapshot)
        state = result.state
        messageId = result.messageId
      } catch {
        // 网络不可用时保留 failed 状态，用户可稍后重新共享。
      }
      this.store.upsertShare({
        taskId: bumped.id,
        peerId,
        revision: bumped.revision,
        lastMessageId: messageId,
        state,
        createdAt: stamp,
        updatedAt: this.now()
      })
    }
    const latest = this.store.getTask(this.selfId, id, this.selfId)!
    this.emit(latest)
    return latest
  }

  async unshareTask(taskId: unknown, peerId: unknown): Promise<WorkTaskView> {
    const id = requireTaskId(taskId)
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 64) {
      throw new Error('共享同事不合法')
    }
    const task = this.store.getTask(this.selfId, id, this.selfId)
    if (!task || !task.active) throw new Error('任务不存在或只读')
    try {
      await this.sync.sendRevoke(peerId, id, task.revision)
    } catch {
      // 撤销失败仍从本地活动共享中移除；对端会在下次同步前保留副本。
    }
    this.store.markShareRevoked(id, peerId, this.now())
    const latest = this.store.getTask(this.selfId, id, this.selfId)!
    this.emit(latest)
    return latest
  }

  /** 收到 messenger status 事件后，把 queued 更新为 sent。 */
  handleShareStatus(messageId: string, state: WorkTaskDeliveryState): boolean {
    const matched = this.store.updateShareByMessageId(messageId, state, this.now())
    if (!matched) return false
    const task = this.store.getTask(this.selfId, matched.taskId, this.selfId)
    if (task) this.emit(task)
    return true
  }

  applyRemoteUpsert(snapshot: WorkTaskSyncSnapshot): boolean {
    if (!this.isValidSnapshot(snapshot)) return false
    const applied = this.store.applyRemoteSnapshot(snapshot, this.now())
    if (!applied) return false
    const task = this.store.getTask(snapshot.task.ownerNodeId, snapshot.task.id, this.selfId)
    if (task) this.emit(task)
    return true
  }

  applyRemoteRevoke(ownerNodeId: string, taskId: string, revision: number): boolean {
    if (
      ownerNodeId === this.selfId ||
      typeof ownerNodeId !== 'string' ||
      ownerNodeId.length === 0 ||
      ownerNodeId.length > 64 ||
      typeof taskId !== 'string' ||
      taskId.length === 0 ||
      taskId.length > 64 ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    ) {
      return false
    }
    const applied = this.store.applyRemoteRevoke(ownerNodeId, taskId, revision, this.now())
    if (!applied) return false
    const task = this.store.getTask(ownerNodeId, taskId, this.selfId)
    if (task) this.emit(task)
    return true
  }

  private async publishShares(task: WorkTaskView): Promise<void> {
    const records = this.store.listShareRecords(task.id)
    if (records.length === 0) return
    const project = this.store.getProject(this.selfId, task.projectId)
    if (!project) return
    const snapshot = this.buildSnapshot(task, project)
    for (const record of records) {
      let state: WorkTaskDeliveryState = 'failed'
      let messageId: string | null = null
      try {
        const result = await this.sync.sendUpsert(record.peerId, snapshot)
        state = result.state
        messageId = result.messageId
      } catch {
        // 单个同事发送失败不阻断其他共享。
      }
      this.store.upsertShare({
        taskId: task.id,
        peerId: record.peerId,
        revision: task.revision,
        lastMessageId: messageId,
        state,
        createdAt: record.createdAt,
        updatedAt: this.now()
      })
    }
  }

  private buildSnapshot(task: WorkTaskView, project: WorkTaskProjectView): WorkTaskSyncSnapshot {
    return { task: toSyncTask(task), project: toSyncProject(project) }
  }

  private normalizeFilter(filter: WorkTaskFilter): WorkTaskFilter {
    const scope = filter?.scope
    if (scope !== 'all' && scope !== 'owned' && scope !== 'shared') {
      throw new Error('任务筛选不合法')
    }
    const normalized: WorkTaskFilter = { scope }
    if (filter.projectId !== undefined) normalized.projectId = requireTaskId(filter.projectId)
    for (const key of ['startFrom', 'startTo', 'dueFrom', 'dueTo'] as const) {
      const value = filter[key]
      if (value === undefined) continue
      if (!isWorkTaskDate(value)) throw new Error('日期筛选无效')
      normalized[key] = value
    }
    return normalized
  }

  private isValidSnapshot(snapshot: WorkTaskSyncSnapshot): boolean {
    if (!snapshot || typeof snapshot !== 'object') return false
    const { task, project } = snapshot
    if (!task || !project || typeof task !== 'object' || typeof project !== 'object') return false
    if (task.ownerNodeId === this.selfId) return false
    if (
      typeof task.ownerNodeId !== 'string' ||
      task.ownerNodeId.length === 0 ||
      task.ownerNodeId.length > 64 ||
      typeof task.id !== 'string' ||
      task.id.length === 0 ||
      task.id.length > 64 ||
      typeof task.projectId !== 'string' ||
      task.projectId.length === 0 ||
      task.projectId.length > 64 ||
      task.ownerNodeId !== project.ownerNodeId ||
      task.projectId !== project.id
    ) {
      return false
    }
    if (typeof project.id !== 'string' || project.id.length === 0 || project.id.length > 64) {
      return false
    }
    try {
      requireProjectName(project.name)
      requireTitle(task.title)
      requireDescription(task.description)
    } catch {
      return false
    }
    const startDate = optionalDate(task.startDate, '开始日期')
    const dueDate = optionalDate(task.dueDate, '截止日期')
    if (!isValidWorkTaskDateRange(startDate, dueDate)) return false
    if (!isWorkTaskStatus(task.status)) return false
    if (!Number.isSafeInteger(task.revision) || task.revision < 1) return false
    if (!Number.isSafeInteger(task.createdAt) || task.createdAt <= 0) return false
    if (!Number.isSafeInteger(task.updatedAt) || task.updatedAt <= 0) return false
    if (!Number.isSafeInteger(project.updatedAt) || project.updatedAt <= 0) return false
    return true
  }
}
