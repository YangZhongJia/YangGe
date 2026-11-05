import { describe, expect, it } from 'vitest'
import type { Envelope } from '../../shared/protocol'
import { CAPS, MSG_TYPES, type TaskSyncPayload } from '../../shared/protocol'
import type { WorkTaskSyncSnapshot } from '../../shared/protocol'
import type { WorkTaskDeliveryState } from '../../shared/work-task'
import { WorkTaskSyncService, type WorkTaskSyncMessenger } from './work-task-sync'

class FakeMessenger implements WorkTaskSyncMessenger {
  readonly sent: Array<{ peerId: string; env: Envelope<TaskSyncPayload> }> = []
  outcome: 'sent' | 'queued' = 'sent'
  fail = false
  private listeners: Array<(messageId: string, status: 'sent') => void> = []

  async sendUserMessage(
    peerId: string,
    env: Envelope<TaskSyncPayload>
  ): Promise<'sent' | 'queued'> {
    if (this.fail) throw new Error('offline')
    this.sent.push({ peerId, env })
    return this.outcome
  }

  on(event: 'status', listener: (messageId: string, status: 'sent') => void): void {
    if (event === 'status') this.listeners.push(listener)
  }

  emitStatus(messageId: string): void {
    for (const listener of this.listeners) listener(messageId, 'sent')
  }
}

class FakeTaskService {
  readonly upserts: WorkTaskSyncSnapshot[] = []
  readonly revokes: Array<{ ownerNodeId: string; taskId: string; revision: number }> = []
  readonly statuses: Array<{ messageId: string; state: WorkTaskDeliveryState }> = []
  readonly assignmentAcks: Array<{ taskId: string; revision: number; accept: boolean }> = []
  readonly assignmentStatuses: Array<{ taskId: string; revision: number; status: string }> = []

  applyRemoteUpsert(snapshot: WorkTaskSyncSnapshot): boolean {
    this.upserts.push(snapshot)
    return true
  }

  applyRemoteRevoke(ownerNodeId: string, taskId: string, revision: number): boolean {
    this.revokes.push({ ownerNodeId, taskId, revision })
    return true
  }

  handleShareStatus(messageId: string, state: WorkTaskDeliveryState): boolean {
    this.statuses.push({ messageId, state })
    return true
  }

  applyAssignmentAck(_from: string, taskId: string, revision: number, accept: boolean): boolean {
    this.assignmentAcks.push({ taskId, revision, accept })
    return true
  }

  applyAssignmentStatus(
    _from: string,
    taskId: string,
    revision: number,
    status: string
  ): boolean {
    this.assignmentStatuses.push({ taskId, revision, status })
    return true
  }
}

const snapshot: WorkTaskSyncSnapshot = {
  project: {
    id: 'project-1',
    ownerNodeId: 'node-alice',
    name: '五期',
    updatedAt: 2000
  },
  task: {
    id: 'task-1',
    ownerNodeId: 'node-alice',
    projectId: 'project-1',
    title: '回归测试',
    description: '',
    startDate: null,
    dueDate: '2026-11-05',
    status: 'in_progress',
    revision: 2,
    createdAt: 1000,
    updatedAt: 2000
  }
}

function harness(
  options: { selfId?: string; caps?: string[] | null; peers?: Set<string> } = {}
) {
  const messenger = new FakeMessenger()
  const service = new FakeTaskService()
  const caps = options.caps === undefined ? [CAPS.taskSharing] : options.caps
  const peers = options.peers ?? new Set(['node-bob', 'node-alice'])
  const sync = new WorkTaskSyncService({
    selfId: options.selfId ?? 'node-alice',
    messenger,
    service,
    peerCaps: (peerId) => (peers.has(peerId) ? caps : null)
  })
  return { messenger, service, sync }
}

describe('WorkTaskSyncService 发送', () => {
  it('只向声明 tsk1 的联系人共享', async () => {
    const { sync, messenger } = harness({ caps: null })
    await expect(sync.sendUpsert('node-bob', snapshot)).resolves.toEqual({
      state: 'unsupported',
      messageId: ''
    })
    expect(messenger.sent).toHaveLength(0)
  })

  it('发送完整快照并返回 queued 状态与报文 id', async () => {
    const { sync, messenger } = harness()
    messenger.outcome = 'queued'
    const result = await sync.sendUpsert('node-bob', snapshot)
    expect(result.state).toBe('queued')
    expect(messenger.sent).toHaveLength(1)
    expect(messenger.sent[0].peerId).toBe('node-bob')
    expect(messenger.sent[0].env.type).toBe(MSG_TYPES.task)
    expect(messenger.sent[0].env.from).toBe('node-alice')
    expect(messenger.sent[0].env.payload).toMatchObject({
      op: 'upsert',
      toNodeId: 'node-bob',
      task: snapshot.task,
      project: snapshot.project
    })
    expect(result.messageId).toBe(messenger.sent[0].env.id)
  })

  it('发送失败标记 failed', async () => {
    const { sync, messenger } = harness()
    messenger.fail = true
    const result = await sync.sendUpsert('node-bob', snapshot)
    expect(result.state).toBe('failed')
    expect(result.messageId).toBe('')
  })

  it('撤销报文携带 owner、任务和 revision', async () => {
    const { sync, messenger } = harness()
    await expect(sync.sendRevoke('node-bob', 'task-1', 2)).resolves.toBe('sent')
    expect(messenger.sent[0].env.payload).toMatchObject({
      op: 'revoke',
      toNodeId: 'node-bob',
      ownerNodeId: 'node-alice',
      taskId: 'task-1',
      revision: 2
    })
  })
})

describe('WorkTaskSyncService 接收', () => {
  function envelope(payload: TaskSyncPayload, from = 'node-alice'): Envelope<TaskSyncPayload> {
    return {
      v: 1,
      type: MSG_TYPES.task,
      id: 'env-1',
      from,
      ts: 3000,
      payload
    }
  }

  it('只接受目标为本机、发送者即 owner 且声明 tsk1 的 upsert', () => {
    const { sync, service } = harness({ selfId: 'node-bob' })
    const payload: TaskSyncPayload = {
      op: 'upsert',
      toNodeId: 'node-bob',
      task: snapshot.task,
      project: snapshot.project
    }
    expect(sync.handleEnvelope(envelope(payload))).toBe(true)
    expect(service.upserts).toHaveLength(1)
    expect(sync.handleEnvelope(envelope({ ...payload, toNodeId: 'node-mallory' }))).toBe(false)
    expect(
      sync.handleEnvelope(
        envelope({ ...payload, task: { ...payload.task, ownerNodeId: 'node-mallory' } })
      )
    ).toBe(false)
    expect(sync.handleEnvelope(envelope(payload, 'node-mallory'))).toBe(false)
    expect(sync.handleEnvelope(envelope(payload, 'node-unknown'))).toBe(false)
  })

  it('拒绝未声明 tsk1 的发送者与错误报文类型', () => {
    const { sync, service } = harness({ selfId: 'node-bob', caps: [] })
    const payload: TaskSyncPayload = {
      op: 'upsert',
      toNodeId: 'node-bob',
      task: snapshot.task,
      project: snapshot.project
    }
    expect(sync.handleEnvelope(envelope(payload))).toBe(false)
    expect(
      sync.handleEnvelope({ ...envelope(payload), type: MSG_TYPES.msg })
    ).toBe(false)
    expect(service.upserts).toHaveLength(0)
  })

  it('撤销同样校验 owner，并把 revision 传给服务', () => {
    const { sync, service } = harness({ selfId: 'node-bob' })
    const payload: TaskSyncPayload = {
      op: 'revoke',
      toNodeId: 'node-bob',
      ownerNodeId: 'node-alice',
      taskId: 'task-1',
      revision: 4
    }
    expect(sync.handleEnvelope(envelope(payload))).toBe(true)
    expect(service.revokes).toEqual([
      { ownerNodeId: 'node-alice', taskId: 'task-1', revision: 4 }
    ])
    expect(
      sync.handleEnvelope(
        envelope({ ...payload, ownerNodeId: 'node-mallory' })
      )
    ).toBe(false)
  })

  it('tsk2 指派回执交给业务层；未声明 tsk2 的对端被忽略', () => {
    const { sync, service } = harness({
      selfId: 'node-alice',
      caps: [CAPS.taskSharing, CAPS.taskAssign]
    })
    const ack: TaskSyncPayload = {
      op: 'assign-ack',
      toNodeId: 'node-alice',
      taskId: 'task-1',
      revision: 3,
      accept: true
    }
    expect(sync.handleEnvelope(envelope(ack, 'node-bob'))).toBe(true)
    expect(service.assignmentAcks).toEqual([{ taskId: 'task-1', revision: 3, accept: true }])

    const status: TaskSyncPayload = {
      op: 'assign-status',
      toNodeId: 'node-alice',
      taskId: 'task-1',
      revision: 3,
      status: 'completed'
    }
    expect(sync.handleEnvelope(envelope(status, 'node-bob'))).toBe(true)
    expect(service.assignmentStatuses).toEqual([
      { taskId: 'task-1', revision: 3, status: 'completed' }
    ])

    const old = harness({ selfId: 'node-alice', caps: [CAPS.taskSharing] })
    expect(old.sync.handleEnvelope(envelope(ack, 'node-bob'))).toBe(false)
  })

  it('向 tsk2 对端发送接受与状态回传', async () => {
    const { sync, messenger } = harness({ caps: [CAPS.taskSharing, CAPS.taskAssign] })
    await expect(sync.sendAssignmentAck('node-bob', 'task-1', 3, true)).resolves.toBe(true)
    await expect(sync.sendAssignmentStatus('node-bob', 'task-1', 3, 'completed')).resolves.toBe(true)
    expect(messenger.sent.map((item) => item.env.payload)).toMatchObject([
      { op: 'assign-ack', toNodeId: 'node-bob', taskId: 'task-1', revision: 3, accept: true },
      { op: 'assign-status', toNodeId: 'node-bob', taskId: 'task-1', revision: 3, status: 'completed' }
    ])
  })

  it('messenger 补发成功事件回填共享状态', () => {
    const { service, messenger } = harness()
    messenger.emitStatus('msg-1')
    expect(service.statuses).toEqual([{ messageId: 'msg-1', state: 'sent' }])
  })
})
