// AgentTaskRepo 自测经 Electron 内置 Node 运行，匹配 better-sqlite3 的 Electron ABI。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentCoordinatorPlan,
  AgentTaskEventView,
  AgentTaskStepView,
  AgentView
} from '../../shared/ipc'
import { AgentTaskRepo, type AgentTaskRecordInput } from './agent-task-repo'
import { AgentRepo } from './agent-repo'
import { openDatabase } from './db'

const directories: string[] = []

function makeDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yangge-agent-task-'))
  directories.push(dir)
  return dir
}

function taskInput(id = 'task-1'): AgentTaskRecordInput {
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

function makeAgent(): AgentView {
  return {
    id: 'agent-1',
    name: 'Detected Agent',
    displayName: '',
    description: '',
    instructions: '',
    command: 'C:\\agents\\agent.exe',
    args: [],
    cwd: 'C:\\project',
    version: '1.0.0',
    source: 'manual',
    probeError: '',
    enabled: true,
    createdAt: 100,
    lastUsedAt: 0,
    lastProbeTs: 100
  }
}

function assertAgentProfilePersistence(): void {
  const dir = makeDirectory()
  const dbPath = join(dir, 'agents.db')
  const db = openDatabase(dbPath)
  const repo = new AgentRepo(db)
  repo.upsertAgents([makeAgent()])
  assert.deepEqual(repo.updateAgentProfile({
    id: 'agent-1',
    displayName: 'Builder',
    description: '测试与实现',
    instructions: '先写测试。',
    enabled: false
  }), {
    ...makeAgent(),
    displayName: 'Builder',
    description: '测试与实现',
    instructions: '先写测试。',
    enabled: false
  })
  repo.createSession({
    id: 'session-1',
    agentId: 'agent-1',
    agentName: 'ignored',
    acpSessionId: 'acp-session-1',
    cwd: 'C:\\project',
    title: 'Builder',
    status: 'idle',
    createdAt: 101,
    updatedAt: 102
  })
  assert.equal(repo.getSession('session-1')?.agentName, 'Builder')
  assert.equal(repo.listSessions()[0]?.agentName, 'Builder')
  repo.upsertAgents([{
    ...makeAgent(),
    name: 'Rescanned Agent',
    displayName: 'should-not-overwrite',
    description: 'should-not-overwrite',
    instructions: 'should-not-overwrite',
    enabled: true,
    cwd: 'C:\\changed',
    lastProbeTs: 200
  }])
  assert.deepEqual(repo.getAgent('agent-1'), {
    ...makeAgent(),
    name: 'Rescanned Agent',
    displayName: 'Builder',
    description: '测试与实现',
    instructions: '先写测试。',
    enabled: false,
    lastProbeTs: 200
  })
  db.close()

  const reopened = openDatabase(dbPath)
  try {
    assert.deepEqual(new AgentRepo(reopened).getAgent('agent-1'), {
      ...makeAgent(),
      name: 'Rescanned Agent',
      displayName: 'Builder',
      description: '测试与实现',
      instructions: '先写测试。',
      enabled: false,
      lastProbeTs: 200
    })
  } finally {
    reopened.close()
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

function assertPlanReplacementIsTransactional(): void {
  const db = openDatabase(join(makeDirectory(), 'plans.db'))
  try {
    const repo = new AgentTaskRepo(db)
    repo.createTask(taskInput())
    const oldStep = makeStep()
    repo.createStep(oldStep)
    repo.appendEvent(makeEvent('event-before-plan', 102, '旧计划'))

    const nextPlan: AgentCoordinatorPlan = {
      summary: '实现、审查并复审',
      steps: [
        {
          id: 'implement',
          title: '实现',
          role: 'implement',
          agentId: 'agent-implementer',
          dependsOn: [],
          input: '实现改动',
          expectedOutput: '代码完成'
        },
        {
          id: 'review',
          title: '审查',
          role: 'review',
          agentId: 'agent-reviewer',
          dependsOn: ['implement'],
          input: '审查改动',
          expectedOutput: '审查结论'
        }
      ]
    }
    const nextSteps: AgentTaskStepView[] = nextPlan.steps.map((step, ordinal) => ({
      ...makeStep(),
      id: `next-step-${ordinal}`,
      ordinal,
      role: step.role,
      agentId: step.agentId,
      title: step.title,
      input: step.input,
      expectedOutput: step.expectedOutput,
      dependsOn: step.dependsOn
    }))
    const replaced = repo.replacePlan('task-1', nextPlan, nextSteps, 103)
    assert.equal(replaced?.status, 'awaiting_approval')
    assert.deepEqual(replaced?.plan, nextPlan)
    assert.deepEqual(repo.listSteps('task-1'), nextSteps)
    assert.equal(repo.listEvents('task-1')[0].stepId, null, '删除旧步骤后事件保留并解除引用')

    assert.throws(() =>
      repo.replacePlan('task-1', nextPlan, Array.from({ length: 6 }, (_item, ordinal) => ({
        ...makeStep(),
        id: `too-many-${ordinal}`,
        ordinal
      })), 104)
    )
    assert.deepEqual(repo.listSteps('task-1'), nextSteps, '非法新计划不得删除已保存步骤')
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
  assertPlanReplacementIsTransactional()
  assertAgentProfilePersistence()
  console.log('[agent-task-repo-selftest] PASS —— 任务、步骤、时间线、Agent 档案与边界校验通过')
} finally {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true })
}
