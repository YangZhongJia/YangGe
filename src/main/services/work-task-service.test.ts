import { describe, expect, it } from 'vitest'
import type {
  WorkTaskFilter,
  WorkTaskProjectView,
  WorkTaskShareView,
  WorkTaskView
} from '../../shared/ipc'
import type { WorkTaskSyncSnapshot } from '../../shared/protocol'
import type { WorkTaskDeliveryState } from '../../shared/work-task'
import type {
  WorkTaskShareRecord,
  WorkTaskStorePort,
  WorkTaskSyncPort,
  WorkTaskTaskRecord
} from './work-task-service'
import { WorkTaskService } from './work-task-service'

class MemoryStore implements WorkTaskStorePort {
  private projects = new Map<string, WorkTaskProjectView>()
  private tasks = new Map<string, WorkTaskView>()
  private shares = new Map<string, WorkTaskShareRecord>()

  private key(owner: string, id: string): string {
    return `${owner}|${id}`
  }

  listProjects(viewerNodeId: string): WorkTaskProjectView[] {
    return [...this.projects.values()]
      .filter(
        (project) =>
          project.ownerNodeId === viewerNodeId ||
          [...this.tasks.values()].some(
            (task) =>
              task.active &&
              task.ownerNodeId !== viewerNodeId &&
              task.ownerNodeId === project.ownerNodeId &&
              task.projectId === project.id
          )
      )
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  getProject(ownerNodeId: string, id: string): WorkTaskProjectView | null {
    return this.projects.get(this.key(ownerNodeId, id)) ?? null
  }

  createProject(record: {
    id: string
    ownerNodeId: string
    name: string
    createdAt: number
    updatedAt: number
  }): WorkTaskProjectView {
    const view = { ...record, isShared: false }
    this.projects.set(this.key(record.ownerNodeId, record.id), view)
    return view
  }

  renameProject(ownerNodeId: string, id: string, name: string, updatedAt: number): boolean {
    const project = this.projects.get(this.key(ownerNodeId, id))
    if (!project) return false
    project.name = name
    project.updatedAt = updatedAt
    return true
  }

  deleteProject(ownerNodeId: string, id: string): boolean {
    return this.projects.delete(this.key(ownerNodeId, id))
  }

  countProjectTasks(ownerNodeId: string, projectId: string): number {
    return [...this.tasks.values()].filter(
      (task) => task.active && task.ownerNodeId === ownerNodeId && task.projectId === projectId
    ).length
  }

  listTasks(filter: WorkTaskFilter, viewerNodeId: string): WorkTaskView[] {
    return [...this.tasks.values()]
      .filter((task) => {
        if (!task.active) return false
        if (filter.scope === 'owned' && task.ownerNodeId !== viewerNodeId) return false
        if (filter.scope === 'shared' && task.ownerNodeId === viewerNodeId) return false
        if (filter.projectId && task.projectId !== filter.projectId) return false
        if (filter.startFrom && (!task.startDate || task.startDate < filter.startFrom)) return false
        if (filter.startTo && (!task.startDate || task.startDate > filter.startTo)) return false
        if (filter.dueFrom && (!task.dueDate || task.dueDate < filter.dueFrom)) return false
        if (filter.dueTo && (!task.dueDate || task.dueDate > filter.dueTo)) return false
        return true
      })
      .map((task) => this.withShares(task, viewerNodeId))
  }

  getTask(ownerNodeId: string, id: string, viewerNodeId = ownerNodeId): WorkTaskView | null {
    const task = this.tasks.get(this.key(ownerNodeId, id))
    return task ? this.withShares(task, viewerNodeId) : null
  }

  private withShares(task: WorkTaskView, viewerNodeId: string): WorkTaskView {
    const shares =
      task.ownerNodeId === viewerNodeId
        ? [...this.shares.values()]
            .filter(
              (share) => share.taskId === task.id && share.state !== 'revoked'
            )
            .map((share): WorkTaskShareView => ({
              peerId: share.peerId,
              state: share.state,
              revision: share.revision,
              updatedAt: share.updatedAt
            }))
        : []
    return {
      ...task,
      isShared: task.ownerNodeId !== viewerNodeId,
      assignedToMe: Boolean(task.assigneeNodeId && task.assigneeNodeId === viewerNodeId),
      shares
    }
  }

  createTask(record: WorkTaskTaskRecord): WorkTaskView {
    this.tasks.set(this.key(record.ownerNodeId, record.id), {
      ...record,
      assigneeNodeId: record.assigneeNodeId ?? null,
      assignmentState: record.assignmentState ?? null,
      assignedToMe: false,
      active: true,
      isShared: false,
      shares: []
    })
    return this.getTask(record.ownerNodeId, record.id)!
  }

  updateOwnerTask(
    ownerNodeId: string,
    id: string,
    patch: {
      projectId?: string
      title?: string
      description?: string
      startDate?: string | null
      dueDate?: string | null
      status?: WorkTaskView['status']
    },
    updatedAt: number
  ): WorkTaskView | null {
    const task = this.tasks.get(this.key(ownerNodeId, id))
    if (!task) return null
    if (patch.projectId !== undefined) task.projectId = patch.projectId
    if (patch.title !== undefined) task.title = patch.title
    if (patch.description !== undefined) task.description = patch.description
    if (patch.startDate !== undefined) task.startDate = patch.startDate
    if (patch.dueDate !== undefined) task.dueDate = patch.dueDate
    if (patch.status !== undefined) task.status = patch.status
    task.revision += 1
    task.updatedAt = updatedAt
    return this.getTask(ownerNodeId, id, ownerNodeId)
  }

  setTaskAssignment(
    ownerNodeId: string,
    id: string,
    assigneeNodeId: string | null,
    assignmentState: 'pending' | 'accepted' | 'declined' | null,
    updatedAt: number
  ): WorkTaskView | null {
    const task = this.tasks.get(this.key(ownerNodeId, id))
    if (!task) return null
    task.assigneeNodeId = assigneeNodeId
    task.assignmentState = assignmentState
    task.revision += 1
    task.updatedAt = updatedAt
    return this.getTask(ownerNodeId, id, ownerNodeId)
  }

  bumpTaskRevision(ownerNodeId: string, id: string, updatedAt: number): WorkTaskView | null {
    const task = this.tasks.get(this.key(ownerNodeId, id))
    if (!task) return null
    task.revision += 1
    task.updatedAt = updatedAt
    return this.getTask(ownerNodeId, id, ownerNodeId)
  }

  markTaskInactive(ownerNodeId: string, id: string, updatedAt: number): boolean {
    const task = this.tasks.get(this.key(ownerNodeId, id))
    if (!task) return false
    task.active = false
    task.revision += 1
    task.updatedAt = updatedAt
    return true
  }

  applyRemoteSnapshot(snapshot: WorkTaskSyncSnapshot, receivedAt: number): boolean {
    const { task, project } = snapshot
    const existing = this.tasks.get(this.key(task.ownerNodeId, task.id))
    if (existing && existing.revision >= task.revision) return false
    this.projects.set(this.key(project.ownerNodeId, project.id), {
      ...project,
      isShared: true,
      createdAt: project.updatedAt
    })
    this.tasks.set(this.key(task.ownerNodeId, task.id), {
      ...task,
      assigneeNodeId: task.assigneeNodeId ?? null,
      assignmentState: task.assignmentState ?? null,
      assignedToMe: false,
      active: true,
      isShared: true,
      shares: [],
      updatedAt: receivedAt
    })
    return true
  }

  applyRemoteRevoke(
    ownerNodeId: string,
    taskId: string,
    revision: number,
    receivedAt: number
  ): boolean {
    const task = this.tasks.get(this.key(ownerNodeId, taskId))
    if (!task || task.revision > revision) return false
    task.active = false
    task.revision = revision
    task.updatedAt = receivedAt
    return true
  }

  listShares(taskId: string): WorkTaskShareView[] {
    return [...this.shares.values()]
      .filter((share) => share.taskId === taskId && share.state !== 'revoked')
      .map((share) => ({
        peerId: share.peerId,
        state: share.state,
        revision: share.revision,
        updatedAt: share.updatedAt
      }))
  }

  listShareRecords(taskId: string): WorkTaskShareRecord[] {
    return [...this.shares.values()].filter(
      (share) => share.taskId === taskId && share.state !== 'revoked'
    )
  }

  upsertShare(record: WorkTaskShareRecord): void {
    this.shares.set(record.taskId + '|' + record.peerId, { ...record })
  }

  updateShareByMessageId(
    messageId: string,
    state: WorkTaskDeliveryState,
    updatedAt: number
  ): { taskId: string; peerId: string } | null {
    for (const share of this.shares.values()) {
      if (share.lastMessageId !== messageId || share.state === 'revoked') continue
      share.state = state
      share.updatedAt = updatedAt
      return { taskId: share.taskId, peerId: share.peerId }
    }
    return null
  }

  markShareRevoked(taskId: string, peerId: string, updatedAt: number): void {
    const share = this.shares.get(taskId + '|' + peerId)
    if (!share) return
    share.state = 'revoked'
    share.updatedAt = updatedAt
  }
}

class FakeSync implements WorkTaskSyncPort {
  readonly capable = new Set<string>()
  readonly assignable = new Set<string>()
  readonly assignmentCalls: Array<{ kind: 'ack' | 'status'; taskId: string; revision: number }> = []
  readonly calls: Array<{
    kind: 'upsert' | 'revoke'
    peerId: string
    snapshot?: WorkTaskSyncSnapshot
    taskId?: string
    revision?: number
  }> = []
  nextState: WorkTaskDeliveryState = 'sent'
  private messageSeq = 0

  canShare(peerId: string): boolean {
    return this.capable.has(peerId)
  }

  async sendUpsert(
    peerId: string,
    snapshot: WorkTaskSyncSnapshot
  ): Promise<{ state: WorkTaskDeliveryState; messageId: string }> {
    this.calls.push({ kind: 'upsert', peerId, snapshot })
    this.messageSeq += 1
    return { state: this.nextState, messageId: `msg-${this.messageSeq}` }
  }

  async sendRevoke(
    peerId: string,
    taskId: string,
    revision: number
  ): Promise<WorkTaskDeliveryState> {
    this.calls.push({ kind: 'revoke', peerId, taskId, revision })
    return this.nextState
  }

  canAssign(peerId: string): boolean {
    return this.assignable.has(peerId)
  }

  async sendAssignmentAck(
    _ownerNodeId: string,
    taskId: string,
    revision: number,
    _accept: boolean
  ): Promise<boolean> {
    this.assignmentCalls.push({ kind: 'ack', taskId, revision })
    return this.nextState !== 'failed'
  }

  async sendAssignmentStatus(
    _ownerNodeId: string,
    taskId: string,
    revision: number,
    _status: string
  ): Promise<boolean> {
    this.assignmentCalls.push({ kind: 'status', taskId, revision })
    return this.nextState !== 'failed'
  }
}

function harness() {
  const store = new MemoryStore()
  const sync = new FakeSync()
  const emitted: WorkTaskView[] = []
  let sequence = 0
  const service = new WorkTaskService({
    store,
    selfId: 'node-self',
    sync,
    emit: (task) => emitted.push(task),
    now: () => 1000 + ++sequence,
    id: () => `id-${++sequence}`
  })
  return { service, store, sync, emitted }
}

function createTask(service: WorkTaskService): { project: WorkTaskProjectView; task: WorkTaskView } {
  const project = service.createProject('五期项目')
  const task = service.createTask({
    projectId: project.id,
    title: '回归测试',
    description: '覆盖登录',
    startDate: '2026-11-01',
    dueDate: '2026-11-03'
  })
  return { project, task }
}

describe('WorkTaskService 校验', () => {
  it('拒绝空的本机身份，避免把所有本机任务误判为共享只读', () => {
    const store = new MemoryStore()
    const sync = new FakeSync()
    expect(
      () =>
        new WorkTaskService({
          store,
          selfId: '',
          sync,
          emit: () => {}
        })
    ).toThrow('任务服务缺少本机身份')
  })

  it('本机创建的任务标记为可编辑，不依赖渲染层身份', () => {
    const { service, emitted } = harness()
    const { task } = createTask(service)
    expect(task.isShared).toBe(false)
    expect(task.ownerNodeId).toBe('node-self')
    expect(emitted.at(-1)?.isShared).toBe(false)
  })

  it('拒绝空标题、超长标题、未知项目和倒置日期', () => {
    const { service } = harness()
    const { project } = createTask(service)
    expect(() =>
      service.createTask({
        projectId: project.id,
        title: '   ',
        description: '',
        startDate: null,
        dueDate: null
      })
    ).toThrow('任务标题不能为空')
    expect(() =>
      service.createTask({
        projectId: project.id,
        title: 'x'.repeat(201),
        description: '',
        startDate: null,
        dueDate: null
      })
    ).toThrow('任务标题不能超过 200 个字符')
    expect(() =>
      service.createTask({
        projectId: 'missing',
        title: '任务',
        description: '',
        startDate: null,
        dueDate: null
      })
    ).toThrow('项目不存在')
    expect(() =>
      service.createTask({
        projectId: project.id,
        title: '任务',
        description: '',
        startDate: '2026-11-05',
        dueDate: '2026-11-04'
      })
    ).toThrow('截止日期不能早于开始日期')
  })

  it('拒绝修改共享给自己的只读任务', async () => {
    const { service, store } = harness()
    store.applyRemoteSnapshot(
      {
        project: {
          id: 'remote-project',
          ownerNodeId: 'node-peer',
          name: '同事项目',
          updatedAt: 1
        },
        task: {
          id: 'remote-task',
          ownerNodeId: 'node-peer',
          projectId: 'remote-project',
          title: '共享任务',
          description: '',
          startDate: null,
          dueDate: null,
          status: 'not_started',
          revision: 1,
          createdAt: 1,
          updatedAt: 1
        }
      },
      1
    )
    await expect(service.updateTask('remote-task', { title: '改名' })).rejects.toThrow(
      '任务不存在或只读'
    )
  })

  it('有任务的项目不能删除，空项目可删除', async () => {
    const { service } = harness()
    const { project, task } = createTask(service)
    expect(() => service.deleteProject(project.id)).toThrow('项目下还有任务，不能删除')
    await service.deleteTask(task.id)
    expect(service.deleteProject(project.id)).toBe(true)
  })
})

describe('WorkTaskService 共享', () => {
  it('只允许能力兼容的同事，并记录投递状态', async () => {
    const { service, sync } = harness()
    const { task } = createTask(service)
    sync.capable.add('node-a')
    sync.capable.add('node-b')
    sync.nextState = 'queued'
    const shared = await service.shareTask(task.id, ['node-a', 'node-b'])
    expect(shared.shares.map((share) => share.peerId).sort()).toEqual(['node-a', 'node-b'])
    expect(shared.shares.every((share) => share.state === 'queued')).toBe(true)
    expect(sync.calls).toHaveLength(2)
    await expect(service.shareTask(task.id, ['node-old'])).rejects.toThrow(
      '该同事版本不支持任务共享'
    )
  })

  it('更新任务会向仍共享的同事发布新 revision', async () => {
    const { service, sync } = harness()
    const { task } = createTask(service)
    sync.capable.add('node-a')
    sync.nextState = 'sent'
    await service.shareTask(task.id, ['node-a'])
    sync.calls.length = 0
    const updated = await service.updateTask(task.id, { status: 'completed', dueDate: '2026-11-10' })
    expect(updated.revision).toBe(3)
    expect(sync.calls).toHaveLength(1)
    expect(sync.calls[0].snapshot?.task.revision).toBe(3)
    expect(sync.calls[0].snapshot?.task.status).toBe('completed')
    expect(updated.shares[0].revision).toBe(3)
  })

  it('删除任务先撤销共享，再将任务标为 inactive', async () => {
    const { service, sync, store } = harness()
    const { task } = createTask(service)
    sync.capable.add('node-a')
    await service.shareTask(task.id, ['node-a'])
    sync.calls.length = 0
    await service.deleteTask(task.id)
    expect(sync.calls.map((call) => call.kind)).toEqual(['revoke'])
    expect(store.getTask('node-self', task.id)?.active).toBe(false)
    expect(store.listShares(task.id)).toHaveLength(0)
  })

  it('项目改名会重新发布项目下已共享任务', async () => {
    const { service, sync } = harness()
    const { project, task } = createTask(service)
    sync.capable.add('node-a')
    await service.shareTask(task.id, ['node-a'])
    sync.calls.length = 0
    const renamed = await service.renameProject(project.id, '新项目名')
    expect(renamed.name).toBe('新项目名')
    expect(sync.calls).toHaveLength(1)
  })
})

describe('WorkTaskService 接收共享', () => {
  it('幂等应用远端快照与撤销，并拒绝自称为本机所有者的快照', () => {
    const { service, emitted } = harness()
    const snapshot: WorkTaskSyncSnapshot = {
      project: {
        id: 'remote-project',
        ownerNodeId: 'node-peer',
        name: '共享项目',
        updatedAt: 1
      },
      task: {
        id: 'remote-task',
        ownerNodeId: 'node-peer',
        projectId: 'remote-project',
        title: '远端任务',
        description: '',
        startDate: null,
        dueDate: null,
        status: 'not_started',
        revision: 2,
        createdAt: 1,
        updatedAt: 1
      }
    }
    expect(service.applyRemoteUpsert(snapshot)).toBe(true)
    expect(emitted.at(-1)?.title).toBe('远端任务')
    expect(emitted.at(-1)?.isShared).toBe(true)
    expect(service.applyRemoteUpsert(snapshot)).toBe(false)
    expect(service.applyRemoteRevoke('node-peer', 'remote-task', 1)).toBe(false)
    expect(service.applyRemoteRevoke('node-peer', 'remote-task', 2)).toBe(true)
    expect(service.applyRemoteUpsert({ ...snapshot, task: { ...snapshot.task, ownerNodeId: 'node-self' } }))
      .toBe(false)
  })

  it('撤销后迟到的送达事件不能重新激活共享', async () => {
    const { service, sync, store } = harness()
    const { task } = createTask(service)
    sync.capable.add('node-a')
    sync.nextState = 'queued'
    await service.shareTask(task.id, ['node-a'])
    await service.unshareTask(task.id, 'node-a')
    expect(service.handleShareStatus('msg-1', 'sent')).toBe(false)
    expect(store.listShares(task.id)).toHaveLength(0)
    sync.calls.length = 0
    await service.updateTask(task.id, { title: '撤销后编辑' })
    expect(sync.calls).toHaveLength(0)
  })

  it('收到 messenger 的送达状态后回填共享记录', async () => {
    const { service, sync, store } = harness()
    const { task } = createTask(service)
    sync.capable.add('node-a')
    sync.nextState = 'queued'
    await service.shareTask(task.id, ['node-a'])
    const messageId = 'msg-1'
    expect(service.handleShareStatus(messageId, 'sent')).toBe(true)
    expect(store.listShares(task.id)[0].state).toBe('sent')
  })
})


describe('WorkTaskService 任务指派', () => {
  it('指派后生成待接受快照；接受和状态回传由 owner 收敛', async () => {
    const { service, sync, store } = harness()
    sync.capable.add('node-bob')
    sync.assignable.add('node-bob')
    const { task } = createTask(service)

    const assigned = await service.assignTask(task.id, 'node-bob')
    expect(assigned).toMatchObject({
      assigneeNodeId: 'node-bob',
      assignmentState: 'pending',
      assignedToMe: false
    })
    const snapshot = sync.calls.find(
      (call) => call.kind === 'upsert' && call.peerId === 'node-bob'
    )?.snapshot
    expect(snapshot?.task).toMatchObject({
      assigneeNodeId: 'node-bob',
      assignmentState: 'pending'
    })

    expect(service.applyAssignmentAck('node-bob', task.id, assigned.revision, true)).toBe(true)
    const accepted = store.getTask('node-self', task.id, 'node-self')!
    expect(accepted).toMatchObject({ assignmentState: 'accepted', assigneeNodeId: 'node-bob' })

    expect(
      service.applyAssignmentStatus('node-bob', task.id, accepted.revision, 'in_progress')
    ).toBe(true)
    expect(store.getTask('node-self', task.id, 'node-self')?.status).toBe('in_progress')
  })

  it('拒绝指派、取消指派和不支持指派的同事', async () => {
    const { service, sync, store } = harness()
    sync.capable.add('node-bob')
    sync.assignable.add('node-bob')
    const { task } = createTask(service)

    await expect(service.assignTask(task.id, 'node-old')).rejects.toThrow('不支持任务指派')

    const assigned = await service.assignTask(task.id, 'node-bob')
    expect(service.applyAssignmentAck('node-bob', task.id, assigned.revision, false)).toBe(true)
    expect(store.getTask('node-self', task.id, 'node-self')?.assignmentState).toBe('declined')

    const cleared = await service.assignTask(task.id, null)
    expect(cleared).toMatchObject({ assigneeNodeId: null, assignmentState: null })
  })

  it('错误 revision 或非负责人不能更新指派状态', async () => {
    const { service, sync, store } = harness()
    sync.capable.add('node-bob')
    sync.assignable.add('node-bob')
    const { task } = createTask(service)
    const assigned = await service.assignTask(task.id, 'node-bob')

    expect(service.applyAssignmentAck('node-mallory', task.id, assigned.revision, true)).toBe(false)
    expect(service.applyAssignmentAck('node-bob', task.id, assigned.revision + 99, true)).toBe(false)

    expect(service.applyAssignmentAck('node-bob', task.id, assigned.revision, true)).toBe(true)
    const accepted = store.getTask('node-self', task.id, 'node-self')!
    expect(service.applyAssignmentStatus('node-mallory', task.id, accepted.revision, 'completed')).toBe(false)
    expect(service.applyAssignmentStatus('node-bob', task.id, accepted.revision + 1, 'completed')).toBe(false)
  })
})
