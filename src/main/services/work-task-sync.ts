import { makeEnvelope } from '../net/codec'
import {
  CAPS,
  MSG_TYPES,
  type Envelope,
  type TaskSyncPayload,
  type WorkTaskSyncSnapshot
} from '../../shared/protocol'
import type { WorkTaskDeliveryState } from '../../shared/work-task'
import type { WorkTaskSyncPort } from './work-task-service'

/** messenger 窄接口：便于用内存实现验证离线队列与状态回填。 */
export interface WorkTaskSyncMessenger {
  sendUserMessage(peerId: string, env: Envelope<TaskSyncPayload>): Promise<'sent' | 'queued'>
  on(event: 'status', listener: (messageId: string, status: 'sent') => void): void
}

export interface WorkTaskSyncTaskService {
  applyRemoteUpsert(snapshot: WorkTaskSyncSnapshot): boolean
  applyRemoteRevoke(ownerNodeId: string, taskId: string, revision: number): boolean
  handleShareStatus(messageId: string, state: WorkTaskDeliveryState): boolean
  applyAssignmentAck(from: string, taskId: string, revision: number, accept: boolean): boolean
  applyAssignmentStatus(
    from: string,
    taskId: string,
    revision: number,
    status: 'not_started' | 'in_progress' | 'completed'
  ): boolean
}

export interface WorkTaskSyncOptions {
  selfId: string
  messenger: WorkTaskSyncMessenger
  service: WorkTaskSyncTaskService
  /** 联系人能力位；null/undefined 表示通讯录里没有该节点。 */
  peerCaps: (peerId: string) => string[] | null | undefined
}

export class WorkTaskSyncService implements WorkTaskSyncPort {
  private readonly selfId: string
  private readonly messenger: WorkTaskSyncMessenger
  private readonly service: WorkTaskSyncTaskService
  private readonly peerCaps: WorkTaskSyncOptions['peerCaps']

  constructor(options: WorkTaskSyncOptions) {
    this.selfId = options.selfId
    this.messenger = options.messenger
    this.service = options.service
    this.peerCaps = options.peerCaps
    this.messenger.on('status', (messageId, status) => {
      if (status === 'sent') this.service.handleShareStatus(messageId, 'sent')
    })
  }

  canShare(peerId: string): boolean {
    const caps = this.peerCaps(peerId)
    return Array.isArray(caps) && caps.includes(CAPS.taskSharing)
  }

  canAssign(peerId: string): boolean {
    const caps = this.peerCaps(peerId)
    return Array.isArray(caps) && caps.includes(CAPS.taskAssign)
  }

  async sendUpsert(
    peerId: string,
    snapshot: WorkTaskSyncSnapshot
  ): Promise<{ state: WorkTaskDeliveryState; messageId: string }> {
    if (!this.canShare(peerId)) return { state: 'unsupported', messageId: '' }
    const env = makeEnvelope<TaskSyncPayload>(MSG_TYPES.task, this.selfId, {
      op: 'upsert',
      toNodeId: peerId,
      task: snapshot.task,
      project: snapshot.project
    })
    try {
      const outcome = await this.messenger.sendUserMessage(peerId, env)
      return { state: outcome === 'sent' ? 'sent' : 'queued', messageId: env.id }
    } catch {
      return { state: 'failed', messageId: '' }
    }
  }

  async sendRevoke(
    peerId: string,
    taskId: string,
    revision: number
  ): Promise<WorkTaskDeliveryState> {
    if (!this.canShare(peerId)) return 'unsupported'
    const env = makeEnvelope<TaskSyncPayload>(MSG_TYPES.task, this.selfId, {
      op: 'revoke',
      toNodeId: peerId,
      ownerNodeId: this.selfId,
      taskId,
      revision
    })
    try {
      const outcome = await this.messenger.sendUserMessage(peerId, env)
      return outcome === 'sent' ? 'sent' : 'queued'
    } catch {
      return 'failed'
    }
  }

  async sendAssignmentAck(
    ownerNodeId: string,
    taskId: string,
    revision: number,
    accept: boolean
  ): Promise<boolean> {
    if (!this.canAssign(ownerNodeId)) return false
    const env = makeEnvelope<TaskSyncPayload>(MSG_TYPES.task, this.selfId, {
      op: 'assign-ack',
      toNodeId: ownerNodeId,
      taskId,
      revision,
      accept
    })
    try {
      const outcome = await this.messenger.sendUserMessage(ownerNodeId, env)
      return outcome === 'sent' || outcome === 'queued'
    } catch {
      return false
    }
  }

  async sendAssignmentStatus(
    ownerNodeId: string,
    taskId: string,
    revision: number,
    status: 'not_started' | 'in_progress' | 'completed'
  ): Promise<boolean> {
    if (!this.canAssign(ownerNodeId)) return false
    const env = makeEnvelope<TaskSyncPayload>(MSG_TYPES.task, this.selfId, {
      op: 'assign-status',
      toNodeId: ownerNodeId,
      taskId,
      revision,
      status
    })
    try {
      const outcome = await this.messenger.sendUserMessage(ownerNodeId, env)
      return outcome === 'sent' || outcome === 'queued'
    } catch {
      return false
    }
  }

  /**
   * 入站任务报文：目标必须是本机，发送者必须就是 owner 且声明 tsk1；
   * 指派回执由 assignee 发送，要求 tsk2 且由业务层核对负责人身份。
   */
  handleEnvelope(env: Envelope<TaskSyncPayload>): boolean {
    if (!env || env.type !== MSG_TYPES.task || env.from === this.selfId) return false
    const payload = env.payload
    if (!payload || typeof payload !== 'object') return false
    if (payload.toNodeId !== this.selfId) return false
    const caps = this.peerCaps(env.from)
    if (!Array.isArray(caps) || !caps.includes(CAPS.taskSharing)) return false
    if (payload.op === 'upsert') {
      if (
        !payload.task ||
        !payload.project ||
        payload.task.ownerNodeId !== env.from ||
        payload.project.ownerNodeId !== env.from
      ) {
        return false
      }
      return this.service.applyRemoteUpsert({
        task: payload.task,
        project: payload.project
      })
    }
    if (payload.op === 'revoke') {
      if (payload.ownerNodeId !== env.from) return false
      return this.service.applyRemoteRevoke(env.from, payload.taskId, payload.revision)
    }
    if (payload.op === 'assign-ack') {
      if (!this.canAssign(env.from)) return false
      return this.service.applyAssignmentAck(env.from, payload.taskId, payload.revision, payload.accept)
    }
    if (payload.op === 'assign-status') {
      if (!this.canAssign(env.from)) return false
      return this.service.applyAssignmentStatus(env.from, payload.taskId, payload.revision, payload.status)
    }
    return false
  }
}
