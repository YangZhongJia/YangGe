// WorkTaskRepo 自测经 Electron 内置 Node 运行，使用真实 better-sqlite3（与 app 同 ABI）。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './db'
import { WorkTaskRepo, type WorkTaskRecord } from './work-task-repo'

const directories: string[] = []

function makeDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yangge-work-task-'))
  directories.push(dir)
  return dir
}

function taskRecord(overrides: Partial<WorkTaskRecord> = {}): WorkTaskRecord {
  return {
    id: 'task-1',
    ownerNodeId: 'node-self',
    projectId: 'project-1',
    title: '五期回归测试',
    description: '覆盖登录与支付',
    startDate: '2026-11-01',
    dueDate: '2026-11-05',
    status: 'in_progress',
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

function assertPersistence(): void {
  const dir = makeDirectory()
  const dbPath = join(dir, 'tasks.db')
  const db = openDatabase(dbPath)
  const repo = new WorkTaskRepo(db)
  const project = repo.createProject({
    id: 'project-1',
    ownerNodeId: 'node-self',
    name: 'ADHD 五期',
    createdAt: 100,
    updatedAt: 100
  })
  assert.equal(project.name, 'ADHD 五期')
  assert.equal(project.isShared, false)
  repo.createTask(taskRecord())
  assert.equal(repo.listTasks({ scope: 'owned' }, 'node-self').length, 1)
  assert.equal(repo.listTasks({ scope: 'shared' }, 'node-self').length, 0)
  assert.equal(repo.countProjectTasks('node-self', 'project-1'), 1)

  // 归属标记由主进程按 viewer=appState.nodeId 计算；本机任务的视图必须是可编辑的，
  // 且以其他身份读取时只影响展示，不得改写库内 owner_node_id。
  assert.equal(repo.getTask('node-self', 'task-1', 'node-self')?.isShared, false)
  assert.equal(repo.getTask('node-self', 'task-1', 'node-other')?.isShared, true)
  assert.equal(repo.getTask('node-self', 'task-1')?.ownerNodeId, 'node-self')
  assert.equal(repo.listTasks({ scope: 'owned' }, 'node-self')[0]?.isShared, false)
  assert.equal(repo.listTasks({ scope: 'shared' }, 'node-other')[0]?.isShared, true)

  const updated = repo.updateOwnerTask(
    'node-self',
    'task-1',
    {
      title: '五期回归测试（修订）',
      dueDate: '2026-11-09',
      status: 'completed'
    },
    200
  )
  assert.equal(updated?.title, '五期回归测试（修订）')
  assert.equal(updated?.dueDate, '2026-11-09')
  assert.equal(updated?.status, 'completed')
  assert.equal(updated?.revision, 2)

  assert.equal(repo.updateOwnerTask('node-other', 'task-1', { title: '越权' }, 210), null)

  const filtered = repo.listTasks(
    { scope: 'owned', projectId: 'project-1', dueFrom: '2026-11-01', dueTo: '2026-11-30' },
    'node-self'
  )
  assert.equal(filtered.length, 1)
  assert.equal(
    repo.listTasks({ scope: 'owned', dueTo: '2026-11-01' }, 'node-self')
      .length,
    0
  )
  // 任务页只暴露一个“开始”和一个“截止”边界：开始 → startFrom，截止 → dueTo
  assert.equal(
    repo.listTasks({ scope: 'owned', startFrom: '2026-11-01', dueTo: '2026-11-09' }, 'node-self').length,
    1
  )
  assert.equal(repo.listTasks({ scope: 'owned', startFrom: '2026-11-02' }, 'node-self').length, 0)
  assert.equal(repo.listTasks({ scope: 'owned', dueTo: '2026-11-08' }, 'node-self').length, 0)
  db.close()

  const reopened = openDatabase(dbPath)
  try {
    const restored = new WorkTaskRepo(reopened)
    assert.equal(restored.listProjects('node-self').length, 1)
    const task = restored.getTask('node-self', 'task-1')
    assert.equal(task?.status, 'completed')
    assert.equal(task?.startDate, '2026-11-01')
    assert.equal(task?.dueDate, '2026-11-09')
    assert.equal(task?.revision, 2)
  } finally {
    reopened.close()
  }
}

function assertProjectRenameAndDelete(): void {
  const db = openDatabase(join(makeDirectory(), 'projects.db'))
  try {
    const repo = new WorkTaskRepo(db)
    repo.createProject({
      id: 'project-1',
      ownerNodeId: 'node-self',
      name: '旧项目名',
      createdAt: 100,
      updatedAt: 100
    })
    assert.equal(repo.renameProject('node-self', 'project-1', '新项目名', 110), true)
    assert.equal(repo.getProject('node-self', 'project-1')?.name, '新项目名')
    assert.equal(repo.renameProject('node-other', 'project-1', '越权', 120), false)
    assert.equal(repo.deleteProject('node-other', 'project-1'), false)
    repo.createTask(taskRecord())
    assert.equal(repo.deleteProject('node-self', 'project-1'), true)
    assert.equal(repo.getProject('node-self', 'project-1'), null)
  } finally {
    db.close()
  }
}

function assertRemoteSnapshots(): void {
  const db = openDatabase(join(makeDirectory(), 'remote.db'))
  try {
    const repo = new WorkTaskRepo(db)
    const snapshot = {
      project: {
        id: 'project-remote',
        ownerNodeId: 'node-peer',
        name: '同事的项目',
        updatedAt: 100
      },
      task: {
        id: 'task-remote',
        ownerNodeId: 'node-peer',
        projectId: 'project-remote',
        title: '共享任务',
        description: '只读副本',
        startDate: null,
        dueDate: '2026-11-04',
        status: 'not_started' as const,
        revision: 3,
        createdAt: 100,
        updatedAt: 100
      }
    }
    assert.equal(repo.applyRemoteSnapshot(snapshot, 500), true)
    const shared = repo.listTasks({ scope: 'shared' }, 'node-self')
    assert.equal(shared.length, 1)
    assert.equal(shared[0].title, '共享任务')
    assert.deepEqual(shared[0].shares, [])
    assert.equal(repo.listProjects('node-self').some((project) => project.isShared), true)

    assert.equal(repo.applyRemoteSnapshot(snapshot, 501), false)
    assert.equal(
      repo.applyRemoteSnapshot(
        { ...snapshot, task: { ...snapshot.task, revision: 2, title: '旧标题' } },
        502
      ),
      false
    )
    const updated = {
      ...snapshot,
      task: { ...snapshot.task, revision: 4, title: '新标题', status: 'completed' as const }
    }
    assert.equal(repo.applyRemoteSnapshot(updated, 503), true)
    const afterUpdate = repo.getTask('node-peer', 'task-remote', 'node-self')
    assert.equal(afterUpdate?.title, '新标题')
    assert.equal(afterUpdate?.status, 'completed')
    assert.equal(afterUpdate?.revision, 4)

    assert.equal(repo.applyRemoteRevoke('node-peer', 'task-remote', 3, 504), false)
    assert.equal(repo.applyRemoteRevoke('node-peer', 'task-remote', 4, 505), true)
    assert.equal(repo.listTasks({ scope: 'shared' }, 'node-self').length, 0)

    assert.equal(repo.applyRemoteSnapshot(updated, 506), false)
    const restored = repo.applyRemoteSnapshot(
      { ...snapshot, task: { ...snapshot.task, revision: 5, title: '重新共享' } },
      507
    )
    assert.equal(restored, true)
    assert.equal(repo.getTask('node-peer', 'task-remote', 'node-self')?.title, '重新共享')
  } finally {
    db.close()
  }
}

function assertShares(): void {
  const db = openDatabase(join(makeDirectory(), 'shares.db'))
  try {
    const repo = new WorkTaskRepo(db)
    repo.createProject({
      id: 'project-1',
      ownerNodeId: 'node-self',
      name: '项目',
      createdAt: 100,
      updatedAt: 100
    })
    repo.createTask(taskRecord())
    repo.upsertShare({
      taskId: 'task-1',
      peerId: 'node-peer',
      revision: 1,
      lastMessageId: 'msg-1',
      state: 'queued',
      createdAt: 100,
      updatedAt: 100
    })
    const shares = repo.listShares('task-1')
    assert.equal(shares.length, 1)
    assert.equal(shares[0].state, 'queued')
    assert.equal(repo.getTask('node-self', 'task-1')?.shares[0].state, 'queued')

    repo.upsertShare({
      taskId: 'task-1',
      peerId: 'node-peer',
      revision: 1,
      lastMessageId: 'msg-1',
      state: 'sent',
      createdAt: 100,
      updatedAt: 110
    })
    assert.equal(repo.listShares('task-1')[0].state, 'sent')
    repo.upsertShare({
      taskId: 'task-1',
      peerId: 'node-peer',
      revision: 2,
      lastMessageId: 'msg-2',
      state: 'queued',
      createdAt: 100,
      updatedAt: 120
    })
    assert.deepEqual(repo.updateShareByMessageId('msg-2', 'sent', 130), {
      taskId: 'task-1',
      peerId: 'node-peer'
    })
    assert.equal(repo.listShares('task-1')[0].state, 'sent')

    repo.markShareRevoked('task-1', 'node-peer', 140)
    assert.equal(repo.listShares('task-1').length, 0)
    assert.equal(repo.getTask('node-self', 'task-1')?.shares.length, 0)
  } finally {
    db.close()
  }
}

function assertReminders(): void {
  const db = openDatabase(join(makeDirectory(), 'reminders.db'))
  try {
    const repo = new WorkTaskRepo(db)
    repo.createProject({
      id: 'project-1',
      ownerNodeId: 'node-self',
      name: '提醒项目',
      createdAt: 100,
      updatedAt: 100
    })
    repo.createTask(taskRecord())
    let candidates = repo.listReminderCandidates()
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].dueRemindedOn, null)

    repo.markDueReminded(
      [{ ownerNodeId: 'node-self', id: 'task-1' }],
      '2026-11-05',
      200
    )
    assert.equal(repo.listReminderCandidates()[0].dueRemindedOn, '2026-11-05')

    repo.updateOwnerTask('node-self', 'task-1', { title: '只改标题' }, 210)
    assert.equal(
      repo.listReminderCandidates()[0].dueRemindedOn,
      '2026-11-05',
      '只改标题不应重置当天提醒'
    )
    repo.updateOwnerTask('node-self', 'task-1', { dueDate: '2026-11-06' }, 220)
    assert.equal(repo.listReminderCandidates()[0].dueRemindedOn, null, '改截止日应重置提醒')

    repo.setReminderState('overdue-digest', '2026-11-05', 230)
    assert.equal(repo.getReminderState('overdue-digest'), '2026-11-05')
    repo.setReminderState('overdue-digest', '2026-11-06', 240)
    assert.equal(repo.getReminderState('overdue-digest'), '2026-11-06')

    repo.updateOwnerTask('node-self', 'task-1', { status: 'completed' }, 250)
    assert.equal(repo.listReminderCandidates().length, 0, '已完成任务不参与提醒')

    const snapshot = {
      project: {
        id: 'remote-project',
        ownerNodeId: 'node-peer',
        name: '同事项目',
        updatedAt: 300
      },
      task: {
        id: 'remote-task',
        ownerNodeId: 'node-peer',
        projectId: 'remote-project',
        title: '共享任务',
        description: '',
        startDate: null,
        dueDate: '2026-12-01',
        status: 'not_started' as const,
        revision: 1,
        createdAt: 300,
        updatedAt: 300
      }
    }
    repo.applyRemoteSnapshot(snapshot, 300)
    repo.markDueReminded(
      [{ ownerNodeId: 'node-peer', id: 'remote-task' }],
      '2026-12-01',
      310
    )
    assert.equal(
      repo.listReminderCandidates().find((item) => item.id === 'remote-task')?.dueRemindedOn,
      '2026-12-01'
    )
    repo.applyRemoteSnapshot(
      { ...snapshot, task: { ...snapshot.task, revision: 2, title: '共享任务（改名）' } },
      320
    )
    assert.equal(
      repo.listReminderCandidates().find((item) => item.id === 'remote-task')?.dueRemindedOn,
      '2026-12-01',
      '远端只改标题不应重置提醒'
    )
    repo.applyRemoteSnapshot(
      {
        ...snapshot,
        task: { ...snapshot.task, revision: 3, dueDate: '2026-12-02' }
      },
      330
    )
    assert.equal(
      repo.listReminderCandidates().find((item) => item.id === 'remote-task')?.dueRemindedOn,
      null,
      '远端改截止日应重置提醒'
    )
  } finally {
    db.close()
  }
}

function assertInactiveLocalTask(): void {
  const db = openDatabase(join(makeDirectory(), 'inactive.db'))
  try {
    const repo = new WorkTaskRepo(db)
    repo.createProject({
      id: 'project-1',
      ownerNodeId: 'node-self',
      name: '项目',
      createdAt: 100,
      updatedAt: 100
    })
    repo.createTask(taskRecord())
    assert.equal(repo.markTaskInactive('node-self', 'task-1', 150), true)
    assert.equal(repo.listTasks({ scope: 'owned' }, 'node-self').length, 0)
    assert.equal(repo.getTask('node-self', 'task-1')?.active, false)
    assert.equal(repo.bumpTaskRevision('node-self', 'task-1', 160)?.revision, 3)
  } finally {
    db.close()
  }
}

try {
  assertPersistence()
  assertProjectRenameAndDelete()
  assertRemoteSnapshots()
  assertShares()
  assertReminders()
  assertInactiveLocalTask()
  console.log('[work-task-repo-selftest] PASS —— 项目、任务、revision、共享投递与持久化通过')
} finally {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
}
