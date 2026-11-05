import type {
  WorkTaskCreateInput,
  WorkTaskFilter,
  WorkTaskPatch,
  WorkTaskProjectView,
  WorkTaskResult,
  WorkTaskView
} from '../../shared/ipc'
import { isWorkTaskDate, isWorkTaskStatus } from '../../shared/work-task'

const MAX_ID = 64
const MAX_TITLE = 200
const MAX_DESCRIPTION = 8_000
const MAX_PEER_IDS = 16

export interface WorkTaskIpcPort {
  listProjects(): WorkTaskProjectView[]
  listTasks(filter: WorkTaskFilter): WorkTaskView[]
  createProject(name: unknown): WorkTaskProjectView
  renameProject(projectId: unknown, name: unknown): Promise<WorkTaskProjectView>
  deleteProject(projectId: unknown): boolean
  createTask(input: WorkTaskCreateInput): WorkTaskView
  updateTask(taskId: unknown, patch: WorkTaskPatch): Promise<WorkTaskView>
  deleteTask(taskId: unknown): Promise<null>
  shareTask(taskId: unknown, peerIds: unknown): Promise<WorkTaskView>
  unshareTask(taskId: unknown, peerId: unknown): Promise<WorkTaskView>
  assignTask(taskId: unknown, peerId: unknown): Promise<WorkTaskView>
  respondAssignment(taskId: unknown, accept: boolean): Promise<null>
  setAssignedStatus(taskId: unknown, status: unknown): Promise<null>
}

function fail<T>(error: unknown): WorkTaskResult<T> {
  return {
    ok: false,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
  }
}

function ok<T>(value: T): WorkTaskResult<T> {
  return { ok: true, value }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID) {
    throw new Error('任务标识不合法')
  }
  return value
}

function readText(value: unknown, maxChars: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label}不能为空`)
  const text = value.trim()
  if (text.length > maxChars) throw new Error(`${label}不能超过 ${maxChars} 个字符`)
  return text
}

function readDescription(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (Buffer.byteLength(text, 'utf8') > MAX_DESCRIPTION) throw new Error('任务说明过长')
  return text
}

function readNullableDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (!isWorkTaskDate(value)) throw new Error(`${label}无效`)
  return value
}

function parseFilter(value: unknown): WorkTaskFilter {
  if (value === undefined) return { scope: 'all' }
  if (!isRecord(value)) throw new Error('任务筛选不合法')
  const scope = value['scope'] ?? 'all'
  if (scope !== 'all' && scope !== 'owned' && scope !== 'shared') {
    throw new Error('任务筛选不合法')
  }
  const filter: WorkTaskFilter = { scope }
  if (value['projectId'] !== undefined) filter.projectId = readId(value['projectId'])
  for (const key of ['startFrom', 'startTo', 'dueFrom', 'dueTo'] as const) {
    const date = value[key]
    if (date === undefined) continue
    if (!isWorkTaskDate(date)) throw new Error('日期筛选无效')
    filter[key] = date
  }
  return filter
}

function parseCreate(value: unknown): WorkTaskCreateInput {
  if (!isRecord(value)) throw new Error('任务设置不合法')
  return {
    projectId: readId(value['projectId']),
    title: readText(value['title'], MAX_TITLE, '任务标题'),
    description: readDescription(value['description']),
    startDate: readNullableDate(value['startDate'], '开始日期'),
    dueDate: readNullableDate(value['dueDate'], '截止日期')
  }
}

function parsePatch(value: unknown): WorkTaskPatch {
  if (!isRecord(value)) throw new Error('任务设置不合法')
  const patch: WorkTaskPatch = {}
  if (value['projectId'] !== undefined) patch.projectId = readId(value['projectId'])
  if (value['title'] !== undefined) patch.title = readText(value['title'], MAX_TITLE, '任务标题')
  if (value['description'] !== undefined) patch.description = readDescription(value['description'])
  if (value['startDate'] !== undefined) {
    patch.startDate = readNullableDate(value['startDate'], '开始日期')
  }
  if (value['dueDate'] !== undefined) {
    patch.dueDate = readNullableDate(value['dueDate'], '截止日期')
  }
  if (value['status'] !== undefined) {
    if (!isWorkTaskStatus(value['status'])) throw new Error('任务状态不合法')
    patch.status = value['status']
  }
  return patch
}

export class WorkTaskIpcController {
  constructor(private readonly service: WorkTaskIpcPort) {}

  listProjects(): WorkTaskProjectView[] {
    return this.service.listProjects()
  }

  listTasks(filter: unknown): WorkTaskView[] {
    try {
      return this.service.listTasks(parseFilter(filter))
    } catch {
      return []
    }
  }

  createProject(name: unknown): WorkTaskResult<WorkTaskProjectView> {
    try {
      return ok(this.service.createProject(readText(name, 100, '项目名')))
    } catch (error) {
      return fail(error)
    }
  }

  async renameProject(projectId: unknown, name: unknown): Promise<WorkTaskResult<WorkTaskProjectView>> {
    try {
      return ok(await this.service.renameProject(readId(projectId), readText(name, 100, '项目名')))
    } catch (error) {
      return fail(error)
    }
  }

  deleteProject(projectId: unknown): WorkTaskResult<null> {
    try {
      this.service.deleteProject(readId(projectId))
      return ok(null)
    } catch (error) {
      return fail(error)
    }
  }

  createTask(input: unknown): WorkTaskResult<WorkTaskView> {
    try {
      return ok(this.service.createTask(parseCreate(input)))
    } catch (error) {
      return fail(error)
    }
  }

  async updateTask(taskId: unknown, patch: unknown): Promise<WorkTaskResult<WorkTaskView>> {
    try {
      return ok(await this.service.updateTask(readId(taskId), parsePatch(patch)))
    } catch (error) {
      return fail(error)
    }
  }

  async deleteTask(taskId: unknown): Promise<WorkTaskResult<null>> {
    try {
      await this.service.deleteTask(readId(taskId))
      return ok(null)
    } catch (error) {
      return fail(error)
    }
  }

  async shareTask(taskId: unknown, peerIds: unknown): Promise<WorkTaskResult<WorkTaskView>> {
    try {
      if (
        !Array.isArray(peerIds) ||
        peerIds.length === 0 ||
        peerIds.length > MAX_PEER_IDS ||
        !peerIds.every((peerId) => typeof peerId === 'string' && peerId.length > 0 && peerId.length <= MAX_ID)
      ) {
        throw new Error('共享同事数量不合法')
      }
      return ok(await this.service.shareTask(readId(taskId), peerIds))
    } catch (error) {
      return fail(error)
    }
  }

  async assignTask(taskId: unknown, peerId: unknown): Promise<WorkTaskResult<WorkTaskView>> {
    try {
      if (
        peerId !== null &&
        (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > MAX_ID)
      ) {
        throw new Error('指派同事不合法')
      }
      return ok(await this.service.assignTask(readId(taskId), peerId))
    } catch (error) {
      return fail(error)
    }
  }

  async respondAssignment(taskId: unknown, accept: unknown): Promise<WorkTaskResult<null>> {
    try {
      if (typeof accept !== 'boolean') throw new Error('指派结果不合法')
      return ok(await this.service.respondAssignment(readId(taskId), accept))
    } catch (error) {
      return fail(error)
    }
  }

  async setAssignedStatus(taskId: unknown, status: unknown): Promise<WorkTaskResult<null>> {
    try {
      if (!isWorkTaskStatus(status)) throw new Error('任务状态不合法')
      return ok(await this.service.setAssignedStatus(readId(taskId), status))
    } catch (error) {
      return fail(error)
    }
  }

  async unshareTask(taskId: unknown, peerId: unknown): Promise<WorkTaskResult<WorkTaskView>> {
    try {
      if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > MAX_ID) {
        throw new Error('共享同事不合法')
      }
      return ok(await this.service.unshareTask(readId(taskId), peerId))
    } catch (error) {
      return fail(error)
    }
  }
}
