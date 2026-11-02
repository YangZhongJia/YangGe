#!/usr/bin/env node
/**
 * ACP Agent 端到端集成脚本（不依赖 Electron）。
 *
 *   node scripts/acp-agent-integration.mjs
 *
 * 用 esbuild 把主进程的 AcpAgentService 打成临时 ESM，接上内存 Store 和
 * scripts/acp-mock-agent.mjs，验证：握手 → 流式更新 → 权限允许/拒绝 →
 * 本会话允许（自动批准）→ 关闭时挂起请求清理。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mockAgent = join(root, 'scripts', 'acp-mock-agent.mjs')
const bundleDir = join(root, 'out', 'acp-integration')
const execFileAsync = promisify(execFile)

class MemoryStore {
  constructor() {
    this.agents = new Map()
    this.sessions = new Map()
    this.runs = new Map()
    this.audits = []
    this.tasks = new Map()
    this.steps = new Map()
    this.taskEvents = new Map()
  }
  listAgents() { return [...this.agents.values()] }
  getAgent(id) { return this.agents.get(id) ?? null }
  upsertAgents(list) {
    for (const agent of list) {
      const previous = this.agents.get(agent.id)
      this.agents.set(
        agent.id,
        previous
          ? {
              ...agent,
              enabled: previous.enabled,
              cwd: previous.cwd,
              displayName: previous.displayName,
              description: previous.description,
              instructions: previous.instructions
            }
          : agent
      )
    }
  }
  setEnabled(id, enabled) {
    const agent = this.agents.get(id)
    if (agent) agent.enabled = enabled
  }
  updateAgentProfile(input) {
    const agent = this.agents.get(input.id)
    if (!agent) return null
    agent.displayName = input.displayName
    agent.description = input.description
    agent.instructions = input.instructions
    agent.enabled = input.enabled
    return structuredClone(agent)
  }
  touchAgent(id) {
    const agent = this.agents.get(id)
    if (agent) agent.lastUsedAt = Date.now()
  }
  createSession(session) { this.sessions.set(session.id, session) }
  updateSession(id, patch) {
    const session = this.sessions.get(id)
    if (!session) return null
    if (patch.status) session.status = patch.status
    if (patch.acpSessionId) session.acpSessionId = patch.acpSessionId
    if (patch.title) session.title = patch.title
    session.updatedAt = patch.updatedAt ?? Date.now()
    return { ...session }
  }
  getSession(id) { return this.sessions.get(id) ?? null }
  listSessions(limit = 50) { return [...this.sessions.values()].slice(0, limit) }
  createRun(run) { this.runs.set(run.id, { ...run, stopReason: null, endedAt: null, error: null }) }
  finishRun(id, patch) {
    const run = this.runs.get(id)
    if (!run) return
    run.stopReason = patch.stopReason
    run.error = patch.error
    run.endedAt = patch.endedAt ?? Date.now()
  }
  addAudit(entry) { this.audits.push(entry) }
  listAudit(limit = 100) { return this.audits.slice(-limit).reverse() }
  createTask(record) {
    const task = {
      ...record,
      status: 'draft',
      plan: null,
      reviewRound: 0,
      error: null,
      updatedAt: record.createdAt
    }
    this.tasks.set(task.id, task)
    return structuredClone(task)
  }
  getTask(id) {
    const task = this.tasks.get(id)
    return task ? structuredClone(task) : null
  }
  listTasks(limit = 50) {
    return [...this.tasks.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
      .map((task) => structuredClone(task))
  }
  updateTask(id, patch) {
    const task = this.tasks.get(id)
    if (!task) return null
    for (const key of ['status', 'plan', 'reviewRound', 'error', 'updatedAt']) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) task[key] = patch[key]
    }
    return structuredClone(task)
  }
  replacePlan(taskId, plan, steps, updatedAt = Date.now()) {
    const task = this.tasks.get(taskId)
    if (!task) return null
    task.status = 'awaiting_approval'
    task.plan = structuredClone(plan)
    task.reviewRound = 0
    task.error = null
    task.updatedAt = updatedAt
    for (const [id, step] of this.steps) {
      if (step.taskId === taskId) this.steps.delete(id)
    }
    for (const step of steps) this.steps.set(step.id, structuredClone(step))
    return structuredClone(task)
  }
  createStep(step) {
    this.steps.set(step.id, structuredClone(step))
    return structuredClone(step)
  }
  listSteps(taskId) {
    return [...this.steps.values()]
      .filter((step) => step.taskId === taskId)
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((step) => structuredClone(step))
  }
  updateStep(id, patch) {
    const step = this.steps.get(id)
    if (!step) return null
    for (const key of [
      'status',
      'attempt',
      'sessionId',
      'runId',
      'result',
      'error',
      'updatedAt'
    ]) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) step[key] = patch[key]
    }
    return structuredClone(step)
  }
  appendEvent(event) {
    if (!this.taskEvents.has(event.id)) {
      this.taskEvents.set(event.id, structuredClone(event))
    }
  }
  listEvents(taskId, limit = 500) {
    return [...this.taskEvents.values()]
      .filter((event) => event.taskId === taskId)
      .sort((left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id)
      )
      .slice(0, limit)
      .map((event) => structuredClone(event))
  }
}

function separator(title) {
  console.log(`\n=== ${title} ===`)
}

await mkdir(bundleDir, { recursive: true })
await build({
  entryPoints: {
    'agent-service': join(root, 'src', 'main', 'services', 'agent', 'agent-service.ts'),
    'agent-coordinator': join(root, 'src', 'main', 'services', 'agent', 'agent-coordinator.ts'),
    'git-worktree': join(root, 'src', 'main', 'services', 'agent', 'git-worktree.ts')
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node16',
  outdir: bundleDir,
  logLevel: 'silent'
})
const { AcpAgentService } = await import(
  pathToFileURL(join(bundleDir, 'agent-service.js')).href
)
const { AgentCoordinator } = await import(
  pathToFileURL(join(bundleDir, 'agent-coordinator.js')).href
)
const { GitTaskWorkspace } = await import(
  pathToFileURL(join(bundleDir, 'git-worktree.js')).href
)

const dir = await mkdtemp(join(tmpdir(), 'yangge-acp-integration-'))
const store = new MemoryStore()
function mockAgentView(id, name) {
  return {
    id,
    name,
    displayName: '',
    description: '',
    instructions: '',
    command: process.execPath,
    args: [mockAgent],
    cwd: dir,
    version: '0.1.0',
    source: 'manual',
    probeError: '',
    enabled: true,
    createdAt: Date.now(),
    lastUsedAt: 0,
    lastProbeTs: Date.now()
  }
}
const coordinatorAgentId = 'agent_mock_coordinator'
const implementerAgentId = 'agent_mock_implementer'
const reviewerAgentId = 'agent_mock_reviewer'
store.upsertAgents([
  mockAgentView('agent_mock', 'Mock ACP Agent'),
  mockAgentView(coordinatorAgentId, 'Mock Coordinator'),
  mockAgentView(implementerAgentId, 'Mock Implementer'),
  mockAgentView(reviewerAgentId, 'Mock Reviewer')
])
await writeFile(join(dir, 'sample.txt'), '来自集成测试的只读内容\n', 'utf8')

const events = []
let permissionDecision = 'allow_once'
let service = null
let permissionRequests = 0
const coordinators = []

function createAcpService() {
  const instance = new AcpAgentService({
    store,
    homeDir: dir,
    defaultCwd: dir,
    emit: (channel, payload) => {
      events.push({ channel, payload })
      if (channel === 'agent:permission-request') {
        permissionRequests += 1
        assert.ok(payload.options.some((option) => option.kind === 'allow_once'))
        assert.equal(payload.requestId, payload.requestId.slice(0, 128))
        void instance.respondPermission(payload.requestId, permissionDecision).then((result) => {
          assert.equal(result.ok, true)
        })
      }
    },
    diagnostics: () => {}
  })
  return instance
}

service = createAcpService()

function createCoordinator(currentService = service) {
  const workspaces = new GitTaskWorkspace(
    join(dir, 'worktrees'),
    (taskId) => store.getTask(taskId)
  )
  const coordinator = new AgentCoordinator({
    store,
    agents: currentService,
    workspaces
  })
  coordinators.push(coordinator)
  return { coordinator, workspaces }
}

function unwrap(result) {
  assert.equal(result.ok, true, result.ok ? '' : result.error)
  return result.value
}

async function waitFor(check, label, timeoutMs = 15_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
  throw new Error(`等待超时：${label}`)
}

async function runGit(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return stdout.trim()
}

async function createRepository(name) {
  const repository = join(dir, name)
  await mkdir(repository, { recursive: true })
  await runGit(repository, ['init'])
  await runGit(repository, ['config', 'user.email', 'integration@yangge.local'])
  await runGit(repository, ['config', 'user.name', 'YangGe Integration'])
  await writeFile(join(repository, 'README.md'), `# ${name}\n`, 'utf8')
  await runGit(repository, ['add', 'README.md'])
  await runGit(repository, ['commit', '-m', 'initial'])
  return repository
}

async function waitForTask(coordinator, taskId, status) {
  return waitFor(
    () => {
      const task = store.getTask(taskId)
      return task?.status === status ? task : null
    },
    `task ${taskId} -> ${status}`
  )
}

async function waitForEvent(taskId, kind) {
  return waitFor(
    () => store.listEvents(taskId).find((event) => event.kind === kind),
    `task ${taskId} event ${kind}`
  )
}

function taskInput(repository, prompt) {
  return {
    repoPath: repository,
    prompt,
    coordinatorAgentId,
    teamAgentIds: [implementerAgentId, reviewerAgentId]
  }
}

async function assertNoRunningSessions() {
  await waitFor(
    () => !store.listSessions(200).some((session) => session.status === 'running'),
    'all ACP sessions to stop'
  )
}

function updatesSince(index) {
  return events.slice(index)
    .filter((event) => event.channel === 'agent:update')
    .map((event) => event.payload.update)
}

function chunkText(updates) {
  return updates
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => update.content?.text ?? '')
    .join('')
}

let sessionId = null
try {
  separator('agent profile -> local description + role prompt injection + profile gating')
  const localOnlyDescription = 'LOCAL_ONLY_AGENT_DESCRIPTION'
  const normalProfileInstruction = 'NORMAL_PROFILE_INSTRUCTION：先阅读再回答。'
  const profiledAgent = unwrap(await service.updateAgentProfile({
    id: 'agent_mock',
    displayName: '档案助手',
    description: localOnlyDescription,
    instructions: normalProfileInstruction,
    enabled: true
  }))
  assert.equal(profiledAgent.displayName, '档案助手')
  const profileSession = unwrap(await service.newSession('agent_mock', dir))
  assert.equal(profileSession.agentName, '档案助手')
  const profileRunIds = new Set(store.runs.keys())
  const profilePrompt = await service.prompt(profileSession.id, '档案冒烟输入')
  assert.equal(profilePrompt.ok, true, profilePrompt.ok ? '' : profilePrompt.error)
  const profileRuns = [...store.runs.values()].filter((run) => !profileRunIds.has(run.id))
  assert.equal(profileRuns.length, 1)
  assert.ok(profileRuns[0].prompt.includes(normalProfileInstruction))
  assert.ok(profileRuns[0].prompt.includes('档案冒烟输入'))
  assert.ok(!profileRuns[0].prompt.includes(localOnlyDescription))

  unwrap(await service.updateAgentProfile({
    id: 'agent_mock',
    displayName: '档案助手',
    description: localOnlyDescription,
    instructions: normalProfileInstruction,
    enabled: false
  }))
  const rejectedSession = await service.newSession('agent_mock', dir)
  assert.equal(rejectedSession.ok, false)
  const runCountBeforeDisabledPrompt = store.runs.size
  const rejectedPrompt = await service.prompt(profileSession.id, '停用后不应发送')
  assert.equal(rejectedPrompt.ok, false)
  assert.equal(store.runs.size, runCountBeforeDisabledPrompt)
  unwrap(await service.updateAgentProfile({
    id: 'agent_mock',
    displayName: '',
    description: '',
    instructions: '',
    enabled: true
  }))
  await service.closeSession(profileSession.id)
  console.log('[profile] display name, prompt injection, local description, profile gating PASS')

  separator('reject plain CLI during manual registration')
  const plainCli = await service.probeAgent(process.execPath)
  assert.equal(plainCli.ok, false, '普通 CLI 不能通过 ACP Agent 探测')
  assert.match(plainCli.error, /ACP/i)
  console.log(`[probe] 普通 CLI 已拒绝：${plainCli.error}`)

  separator('initialize + session/new')
  const created = await service.newSession('agent_mock', dir)
  assert.equal(created.ok, true, created.ok ? '' : created.error)
  sessionId = created.value.id
  assert.ok(created.value.acpSessionId.startsWith('sess_mock_'))
  console.log(`[session/new] local=${sessionId.slice(0, 8)}… acp=${created.value.acpSessionId} cwd=${created.value.cwd}`)

  separator('prompt -> stream + permission allow_once')
  permissionDecision = 'allow_once'
  let mark = events.length
  const allowed = await service.prompt(sessionId, '请演示 ACP 流程')
  assert.equal(allowed.ok, true, allowed.ok ? '' : allowed.error)
  assert.equal(allowed.value.stopReason, 'end_turn')
  let updates = updatesSince(mark)
  const allowedText = chunkText(updates)
  assert.ok(allowedText.includes('你好，世界！'), '必须收到跨字节边界的首个 chunk')
  assert.ok(!allowedText.includes('\uFFFD'), '多字节字符不能被截断')
  assert.ok(allowedText.includes('已完成：文件已读取。'))
  const toolUpdates = updates.filter((update) => update.sessionUpdate === 'tool_call_update')
  assert.equal(toolUpdates.at(-1)?.status, 'completed')
  console.log(`[stream] ${allowedText.replace(/\n/g, ' ')}`)
  console.log(`[tool] ${toolUpdates.at(-1)?.status}`)
  console.log(`[permission] requests=${permissionRequests} decision=${permissionDecision}`)

  separator('prompt -> permission reject_once')
  permissionDecision = 'reject_once'
  mark = events.length
  const denied = await service.prompt(sessionId, '再读一次')
  assert.equal(denied.ok, true, denied.ok ? '' : denied.error)
  updates = updatesSince(mark)
  assert.ok(chunkText(updates).includes('已拒绝读取'))
  const deniedTool = updates.filter((update) => update.sessionUpdate === 'tool_call_update').at(-1)
  assert.equal(deniedTool?.status, 'failed')
  console.log(`[permission] decision=reject_once -> tool=${deniedTool?.status}`)

  separator('allow_session -> 后续权限自动批准')
  permissionDecision = 'allow_session'
  const beforeAuto = permissionRequests
  const auto1 = await service.prompt(sessionId, '本会话允许')
  assert.equal(auto1.ok, true, auto1.ok ? '' : auto1.error)
  const auto2 = await service.prompt(sessionId, '再次读取')
  assert.equal(auto2.ok, true, auto2.ok ? '' : auto2.error)
  assert.equal(permissionRequests, beforeAuto + 1, '第二个 prompt 不应再弹权限请求')
  console.log(`[permission] session-policy 生效，requests=${permissionRequests - beforeAuto}`)

  separator('close while prompt in flight')
  const hanging = service.prompt(sessionId, '[hang]')
  await service.closeSession(sessionId)
  const hung = await hanging
  assert.equal(hung.ok, false)
  assert.equal(store.sessions.get(sessionId)?.status, 'closed')
  console.log(`[cleanup] hung prompt rejected: ${hung.ok ? 'unexpected' : hung.error}`)

  separator('coordinator: create -> approve -> implement -> review -> diff -> apply')
  permissionDecision = 'allow_once'
  const coordinatorInstruction = 'COORDINATOR_PROFILE_INSTRUCTION'
  const implementerInstruction = 'IMPLEMENTER_PROFILE_INSTRUCTION'
  const reviewerInstruction = 'REVIEWER_PROFILE_INSTRUCTION'
  const localDescriptions = [
    'LOCAL_ONLY_COORDINATOR_DESCRIPTION',
    'LOCAL_ONLY_IMPLEMENTER_DESCRIPTION',
    'LOCAL_ONLY_REVIEWER_DESCRIPTION'
  ]
  for (const [id, instruction, description] of [
    [coordinatorAgentId, coordinatorInstruction, localDescriptions[0]],
    [implementerAgentId, implementerInstruction, localDescriptions[1]],
    [reviewerAgentId, reviewerInstruction, localDescriptions[2]]
  ]) {
    unwrap(await service.updateAgentProfile({
      id,
      displayName: `档案-${id}`,
      description,
      instructions: instruction,
      enabled: true
    }))
  }
  const taskRepository = await createRepository('task-repository')
  const { coordinator, workspaces } = createCoordinator()
  const createdTask = unwrap(await coordinator.createTask(
    taskInput(taskRepository, '创建一个协作结果文件')
  ))
  assert.equal(createdTask.status, 'draft')
  unwrap(await coordinator.start(createdTask.id))
  const plannedTask = await waitForTask(coordinator, createdTask.id, 'awaiting_approval')
  assert.equal(plannedTask.plan?.steps.length, 2)
  assert.deepEqual(
    plannedTask.plan?.steps.map((step) => step.role),
    ['implement', 'review']
  )
  unwrap(await coordinator.approvePlan(createdTask.id))
  const completedTask = await waitForTask(coordinator, createdTask.id, 'completed')
  assert.equal(completedTask.reviewRound, 1)
  assert.deepEqual(
    await workspaces.listChangedFiles(createdTask.id),
    ['coordinator-result.txt']
  )
  const patch = await workspaces.buildPatch(createdTask.id)
  assert.match(patch.toString('utf8'), /coordinator-result\.txt/)
  const sourceHead = await runGit(taskRepository, ['rev-parse', 'HEAD'])
  assert.equal(await runGit(taskRepository, ['rev-parse', 'HEAD']), sourceHead)
  unwrap(await coordinator.apply(createdTask.id))
  assert.match(
    await readFile(join(taskRepository, 'coordinator-result.txt'), 'utf8'),
    /阳鸽协作任务完成/
  )
  const taskRuns = [...store.runs.values()]
  const coordinatorRun = taskRuns.find((run) =>
    run.prompt.includes('你是阳鸽编码任务的协调者')
  )
  const implementerRun = taskRuns.find((run) =>
    run.prompt.includes('你是阳鸽编码团队中的 implement Agent')
  )
  const reviewerRun = taskRuns.find((run) =>
    run.prompt.includes('你是阳鸽编码团队中的 review Agent')
  )
  assert.equal((coordinatorRun?.prompt.match(/COORDINATOR_PROFILE_INSTRUCTION/g) ?? []).length, 1)
  assert.equal((implementerRun?.prompt.match(/IMPLEMENTER_PROFILE_INSTRUCTION/g) ?? []).length, 1)
  assert.equal((reviewerRun?.prompt.match(/REVIEWER_PROFILE_INSTRUCTION/g) ?? []).length, 1)
  assert.ok(taskRuns.every((run) =>
    localDescriptions.every((description) => !run.prompt.includes(description))
  ))
  assert.notEqual(
    await runGit(taskRepository, ['status', '--porcelain=v1']),
    '',
    '应用补丁后源仓库应保留未提交修改'
  )
  assert.equal(
    await runGit(taskRepository, ['rev-parse', 'HEAD']),
    sourceHead,
    '阳鸽不能自动创建提交'
  )
  console.log(`[apply] task=${createdTask.id} diff=${patch.length} bytes head=${sourceHead.slice(0, 8)}`)

  separator('coordinator: cancellation stops the active ACP turn')
  const cancelRepository = await createRepository('cancel-repository')
  const cancelHarness = createCoordinator()
  const cancelTask = unwrap(await cancelHarness.coordinator.createTask(
    taskInput(cancelRepository, '[mock-hang-plan] 取消这个任务')
  ))
  unwrap(await cancelHarness.coordinator.start(cancelTask.id))
  await waitForEvent(cancelTask.id, 'plan_request')
  const cancelledTask = unwrap(await cancelHarness.coordinator.cancel(cancelTask.id))
  assert.equal(cancelledTask.status, 'cancelled')
  await assertNoRunningSessions()
  assert.equal(store.getTask(cancelTask.id)?.status, 'cancelled')
  console.log(`[cancel] task=${cancelTask.id} status=${cancelledTask.status}`)

  separator('coordinator: restart recovery uses a new ACP session')
  const recoveryRepository = await createRepository('recovery-repository')
  let recoveryHarness = createCoordinator()
  const recoveryTask = unwrap(await recoveryHarness.coordinator.createTask(
    taskInput(recoveryRepository, '[mock-hang-implement] 重启后继续完成任务')
  ))
  unwrap(await recoveryHarness.coordinator.start(recoveryTask.id))
  await waitForTask(recoveryHarness.coordinator, recoveryTask.id, 'awaiting_approval')
  unwrap(await recoveryHarness.coordinator.approvePlan(recoveryTask.id))
  await waitForEvent(recoveryTask.id, 'step_request')
  await waitFor(
    () => store.listSessions(200).some((session) => session.status === 'running'),
    'implementation ACP turn to start'
  )
  const interruptedStep = store.listSteps(recoveryTask.id)[0]
  const interruptedSessionId = interruptedStep.sessionId
  recoveryHarness.coordinator.checkpointAndDispose()
  assert.equal(store.getTask(recoveryTask.id)?.status, 'failed')
  assert.equal(store.listSteps(recoveryTask.id)[0].status, 'queued')
  await assertNoRunningSessions()

  service.dispose()
  service = createAcpService()
  recoveryHarness = createCoordinator()
  unwrap(await recoveryHarness.coordinator.resume(recoveryTask.id))
  const recoveredTask = await waitForTask(
    recoveryHarness.coordinator,
    recoveryTask.id,
    'completed'
  )
  const recoveredStep = store.listSteps(recoveryTask.id)[0]
  assert.equal(recoveredTask.reviewRound, 1)
  assert.equal(recoveredStep.status, 'completed')
  assert.ok(recoveredStep.attempt >= 2)
  assert.ok(recoveredStep.sessionId)
  assert.notEqual(recoveredStep.sessionId, interruptedSessionId)
  assert.ok(
    store.listEvents(recoveryTask.id).some((event) => event.kind === 'recovery')
  )
  assert.match(
    await readFile(
      join(recoveredTask.worktreePath, 'coordinator-result.txt'),
      'utf8'
    ),
    /重启后继续完成任务/
  )
  console.log(
    `[recovery] task=${recoveryTask.id} old=${interruptedSessionId?.slice(0, 8)} new=${recoveredStep.sessionId.slice(0, 8)}`
  )

  const allowedAudit = store.audits.filter((entry) => entry.decision === 'allowed').length
  const deniedAudit = store.audits.filter((entry) => entry.decision === 'denied').length
  assert.ok(allowedAudit >= 2)
  assert.ok(deniedAudit >= 1)
  console.log(`[audit] allowed=${allowedAudit} denied=${deniedAudit}`)

  console.log('\nPASS: ACP 与协作任务端到端（mock agent）')
} finally {
  for (const coordinator of coordinators) coordinator.dispose()
  service?.dispose()
  await rm(dir, { recursive: true, force: true })
}
