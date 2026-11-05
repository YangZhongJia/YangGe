// 两节点任务共享验收：真实 SQLite、真实服务/同步层，消息队列用确定性内存实现。
// 真实 UDP/TCP messenger 的可靠投递与补发已由 messenger 回环测试覆盖；这里验证任务语义。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAPS,
  MSG_TYPES,
  type Envelope,
  type TaskSyncPayload
} from '../../shared/protocol'
import { makeEnvelope } from '../net/codec'
import { openDatabase } from './db'
import { WorkTaskRepo } from './work-task-repo'
import { WorkTaskService } from '../services/work-task-service'
import { WorkTaskSyncService } from '../services/work-task-sync'

class Network {
  readonly online = new Set<string>()
  private readonly queues = new Map<string, Envelope<TaskSyncPayload>[]>()
  private readonly syncs = new Map<string, WorkTaskSyncService>()
  private readonly messengers = new Map<string, NodeMessenger>()

  register(nodeId: string, sync: WorkTaskSyncService, messenger: NodeMessenger): void {
    this.syncs.set(nodeId, sync)
    this.messengers.set(nodeId, messenger)
  }

  async send(to: string, env: Envelope<TaskSyncPayload>): Promise<'sent' | 'queued'> {
    if (!this.online.has(to)) {
      const queue = this.queues.get(to) ?? []
      queue.push(env)
      this.queues.set(to, queue)
      return 'queued'
    }
    this.deliver(to, env)
    return 'sent'
  }

  flush(to: string): void {
    const queue = this.queues.get(to) ?? []
    this.queues.set(to, [])
    for (const env of queue) {
      this.deliver(to, env)
      this.messengers.get(env.from)?.emitStatus(env.id)
    }
  }

  private deliver(to: string, env: Envelope<TaskSyncPayload>): void {
    this.syncs.get(to)?.handleEnvelope(env)
  }
}

class NodeMessenger {
  private readonly listeners: Array<(messageId: string, status: 'sent') => void> = []

  constructor(private readonly network: Network) {}

  async sendUserMessage(
    peerId: string,
    env: Envelope<TaskSyncPayload>
  ): Promise<'sent' | 'queued'> {
    return this.network.send(peerId, env)
  }

  on(event: 'status', listener: (messageId: string, status: 'sent') => void): void {
    if (event === 'status') this.listeners.push(listener)
  }

  emitStatus(messageId: string): void {
    for (const listener of this.listeners) listener(messageId, 'sent')
  }
}

function node(
  nodeId: string,
  db: ReturnType<typeof openDatabase>,
  network: Network,
  peerCaps: (peerId: string) => string[] | null
) {
  const repo = new WorkTaskRepo(db)
  const messenger = new NodeMessenger(network)
  let service!: WorkTaskService
  const sync = new WorkTaskSyncService({
    selfId: nodeId,
    messenger,
    peerCaps,
    service: {
      applyRemoteUpsert: (snapshot) => service.applyRemoteUpsert(snapshot),
      applyRemoteRevoke: (ownerNodeId, taskId, revision) =>
        service.applyRemoteRevoke(ownerNodeId, taskId, revision),
      handleShareStatus: (messageId, state) => service.handleShareStatus(messageId, state),
      applyAssignmentAck: (from, taskId, revision, accept) =>
        service.applyAssignmentAck(from, taskId, revision, accept),
      applyAssignmentStatus: (from, taskId, revision, status) =>
        service.applyAssignmentStatus(from, taskId, revision, status)
    }
  })
  service = new WorkTaskService({ store: repo, selfId: nodeId, sync, emit: () => {} })
  network.register(nodeId, sync, messenger)
  return { repo, service, sync }
}

const directory = mkdtempSync(join(tmpdir(), 'yangge-work-task-sharing-'))
const dbA = openDatabase(join(directory, 'node-a.db'))
const dbB = openDatabase(join(directory, 'node-b.db'))
const network = new Network()
const nodeA = node('node-a', dbA, network, (peerId) =>
  peerId === 'node-b' ? [CAPS.taskSharing, CAPS.taskAssign] : null
)
const nodeB = node('node-b', dbB, network, (peerId) =>
  peerId === 'node-a' ? [CAPS.taskSharing, CAPS.taskAssign] : null
)

async function run(): Promise<void> {
  network.online.add('node-a')
  const project = nodeA.service.createProject('五期测试')
  const task = nodeA.service.createTask({
    projectId: project.id,
    title: '登录回归',
    description: '空密码与错误提示',
    startDate: null,
    dueDate: '2026-11-05'
  })

  network.online.delete('node-b')
  const shared = await nodeA.service.shareTask(task.id, ['node-b'])
  assert.equal(shared.shares[0]?.state, 'queued')
  assert.equal(nodeB.repo.listTasks({ scope: 'shared' }, 'node-b').length, 0)

  network.online.add('node-b')
  network.flush('node-b')
  let remote = nodeB.repo.listTasks({ scope: 'shared' }, 'node-b')[0]
  assert.equal(remote?.title, '登录回归')
  assert.equal(remote?.status, 'not_started')
  assert.equal(
    nodeA.repo.getTask('node-a', task.id)?.shares[0]?.state,
    'sent',
    '离线补发后创建者共享状态应回填为 sent'
  )

  await nodeA.service.updateTask(task.id, { status: 'in_progress', title: '登录回归（修订）' })
  remote = nodeB.repo.listTasks({ scope: 'shared' }, 'node-b')[0]
  assert.equal(remote?.title, '登录回归（修订）')
  assert.equal(remote?.status, 'in_progress')
  const currentRevision = remote!.revision

  const stale = makeEnvelope<TaskSyncPayload>(MSG_TYPES.task, 'node-a', {
    op: 'upsert',
    toNodeId: 'node-b',
    task: {
      id: remote!.id,
      ownerNodeId: 'node-a',
      projectId: remote!.projectId,
      title: '旧标题',
      description: '',
      startDate: null,
      dueDate: null,
      status: 'not_started',
      revision: currentRevision - 1,
      createdAt: remote!.createdAt,
      updatedAt: remote!.updatedAt
    },
    project: {
      id: project.id,
      ownerNodeId: 'node-a',
      name: '旧项目名',
      updatedAt: remote!.updatedAt
    }
  })
  assert.equal(nodeB.repo.listTasks({ scope: 'shared' }, 'node-b')[0]?.title, '登录回归（修订）')
  assert.equal(nodeB.sync.handleEnvelope(stale), false)
  assert.equal(nodeB.repo.listTasks({ scope: 'shared' }, 'node-b')[0]?.title, '登录回归（修订）')

  const spoofed = makeEnvelope<TaskSyncPayload>(MSG_TYPES.task, 'node-a', {
    op: 'upsert',
    toNodeId: 'node-b',
    task: {
      id: 'spoofed',
      ownerNodeId: 'node-c',
      projectId: 'spoofed-project',
      title: '伪造任务',
      description: '',
      startDate: null,
      dueDate: null,
      status: 'not_started',
      revision: 1,
      createdAt: 1,
      updatedAt: 1
    },
    project: {
      id: 'spoofed-project',
      ownerNodeId: 'node-c',
      name: '伪造项目',
      updatedAt: 1
    }
  })
  assert.equal(nodeB.sync.handleEnvelope(spoofed), false)
  assert.equal(nodeB.repo.getTask('node-c', 'spoofed', 'node-b'), null)

  network.online.delete('node-b')
  await nodeA.service.unshareTask(task.id, 'node-b')
  assert.equal(nodeB.repo.listTasks({ scope: 'shared' }, 'node-b').length, 1)
  network.online.add('node-b')
  network.flush('node-b')
  assert.equal(
    nodeB.repo.listTasks({ scope: 'shared' }, 'node-b').length,
    0,
    '撤销同步后接收端不再显示副本'
  )
  assert.equal(
    nodeA.repo.getTask('node-a', task.id)?.shares.length,
    0,
    '迟到的 upsert 送达回执不能把 revoked 共享翻回 sent'
  )
  await nodeA.service.updateTask(task.id, { title: '撤销后编辑' })
  assert.equal(
    nodeB.repo.listTasks({ scope: 'shared' }, 'node-b').length,
    0,
    '撤销后编辑不能重新发给已撤销的同事'
  )

  const reshared = await nodeA.service.shareTask(task.id, ['node-b'])
  assert.equal(reshared.shares[0]?.state, 'sent')
  remote = nodeB.repo.listTasks({ scope: 'shared' }, 'node-b')[0]
  assert.equal(remote?.title, '撤销后编辑')
  assert.ok(remote!.revision > currentRevision, '重新共享必须使用更高 revision')

  const assigned = await nodeA.service.assignTask(task.id, 'node-b')
  assert.equal(assigned.assigneeNodeId, 'node-b')
  assert.equal(assigned.assignmentState, 'pending')
  remote = nodeB.repo.listTasks({ scope: 'shared' }, 'node-b')[0]
  assert.equal(remote?.assignedToMe, true, '被指派方应识别自己为负责人')
  assert.equal(remote?.assignmentState, 'pending')

  await nodeB.service.respondAssignment(task.id, true)
  assert.equal(
    nodeA.repo.getTask('node-a', task.id)?.assignmentState,
    'accepted',
    'owner 收到接受回执后进入 accepted'
  )
  remote = nodeB.repo.listTasks({ scope: 'shared' }, 'node-b')[0]
  assert.equal(remote?.assignmentState, 'accepted')

  await nodeB.service.setAssignedStatus(task.id, 'completed')
  assert.equal(
    nodeA.repo.getTask('node-a', task.id)?.status,
    'completed',
    '负责人状态回传到 owner'
  )
  remote = nodeB.repo.listTasks({ scope: 'shared' }, 'node-b')[0]
  assert.equal(remote?.status, 'completed')

  await assert.rejects(
    nodeA.service.shareTask(task.id, ['node-c']),
    /该同事版本不支持任务共享/
  )
  await assert.rejects(nodeA.service.shareTask(task.id, []), /共享同事数量不合法/)

  console.log('[work-task-sharing-selftest] PASS —— 离线共享、补发、更新、指派接受/状态回传、伪造/旧版本拒绝、撤销与重新共享通过')
}

run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    dbA.close()
    dbB.close()
    rmSync(directory, { recursive: true, force: true })
  })
