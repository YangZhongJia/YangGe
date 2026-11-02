// AgentTaskRepo 自测经 Electron 内置 Node 运行，匹配 better-sqlite3 的 Electron ABI。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentTaskCreateInput,
  AgentTaskEventView,
  AgentTaskStepView
} from '../../shared/ipc'
import { AgentTaskRepo } from './agent-task-repo'
import { openDatabase } from './db'

const directories: string[] = []

function makeDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yangge-agent-task-'))
  directories.push(dir)
  return dir
}

function taskInput(id = 'task-1'): AgentTaskCreateInput {
  return {
    id,
    prompt: '修复登录流程',
    repoPath: 'C:\\project',
    sourceBranch: 'main',
    baseCommit: 'abc123',
    worktreePath: 'C:\\app-data\\agent-tasks\\task-1',
    taskBranch: 'yangge/task-1',
    coordinatorAgentId: 'agent-coordinator',
    teamAgentIds: ['agent-implementer', 'agent-reviewer'],
    createdAt: 100
  }
}

function makeStep(): AgentTaskStepView {
  return {
    id: 'step-1',
    taskId: 'task-1',
    ordinal: 0,
    role: 'implement',
    agentId: 'agent-implementer',
    title: '修复登录',
    input: '定位并修复登录失败',
    expectedOutput: '登录流程可用',
    dependsOn: [],
    status: 'queued',
    attempt: 0,
    sessionId: null,
    runId: null,
    result: '',
    error: null,
    createdAt: 101,
    updatedAt: 101
  }
}

function makeEvent(id: string, createdAt: number, text: string): AgentTaskEventView {
  return {
    id,
    taskId: 'task-1',
    stepId: 'step-1',
    kind: 'agent',
    agentId: 'agent-coordinator',
    text,
    createdAt
  }
}

function assertPersistence(): void {
  const dir = makeDirectory()
  const dbPath = join(dir, 'tasks.db')
  const db = openDatabase(dbPath)
  const repo = new AgentTaskRepo(db)
  repo.createTask(taskInput())
  repo.updateTask('task-1', { status: 'awaiting_approval', reviewRound: 0, updatedAt: 102 })
  repo.createStep(makeStep())
  repo.appendEvent(makeEvent('event-2', 104, '完成计划'))
  repo.appendEvent(makeEvent('event-1', 103, '开始规划'))
  db.close()

  const reopened = openDatabase(dbPath)
  try {
    const restored = new AgentTaskRepo(reopened)
    assert.deepEqual(restored.getTask('task-1'), {
      ...taskInput(),
      status: 'awaiting_approval',
      plan: null,
      reviewRound: 0,
      error: null,
      updatedAt: 102
    })
    assert.deepEqual(restored.listSteps('task-1'), [makeStep()])
    assert.deepEqual(restored.listEvents('task-1'), [
      makeEvent('event-1', 103, '开始规划'),
      makeEvent('event-2', 104, '完成计划')
    ])
  } finally {
    reopened.close()
  }
}

function assertValidationAndDeduplication(): void {
  const db = openDatabase(join(makeDirectory(), 'limits.db'))
  try {
    const repo = new AgentTaskRepo(db)
    assert.throws(() => repo.createTask(taskInput('x'.repeat(65))))
    repo.createTask(taskInput())
    assert.throws(() => repo.updateTask('task-1', { status: 'unknown' as never }))
    assert.throws(() =>
      repo.appendEvent(makeEvent('too-large', 105, 'x'.repeat(32_001)))
    )
    repo.createStep(makeStep())
    repo.appendEvent(makeEvent('event-1', 103, '开始规划'))
    repo.appendEvent(makeEvent('event-1', 103, '开始规划'))
    assert.equal(repo.listEvents('task-1').length, 1)
  } finally {
    db.close()
  }
}

try {
  console.log(
    `[agent-task-repo-selftest] runtime node=${process.versions.node} abi=${process.versions.modules}`
  )
  assertPersistence()
  assertValidationAndDeduplication()
  console.log('[agent-task-repo-selftest] PASS —— 任务、步骤、时间线与边界校验通过')
} finally {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true })
}
