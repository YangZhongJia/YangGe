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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mockAgent = join(root, 'scripts', 'acp-mock-agent.mjs')
const bundle = join(root, 'out', 'acp-integration-bundle.mjs')

class MemoryStore {
  constructor() {
    this.agents = new Map()
    this.sessions = new Map()
    this.runs = new Map()
    this.audits = []
  }
  listAgents() { return [...this.agents.values()] }
  getAgent(id) { return this.agents.get(id) ?? null }
  upsertAgents(list) {
    for (const agent of list) {
      const previous = this.agents.get(agent.id)
      this.agents.set(agent.id, previous ? { ...agent, enabled: previous.enabled } : agent)
    }
  }
  setEnabled(id, enabled) {
    const agent = this.agents.get(id)
    if (agent) agent.enabled = enabled
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
}

function separator(title) {
  console.log(`\n=== ${title} ===`)
}

await mkdir(dirname(bundle), { recursive: true })
await build({
  entryPoints: [join(root, 'src', 'main', 'services', 'agent', 'agent-service.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node16',
  outfile: bundle,
  logLevel: 'silent'
})
const { AcpAgentService } = await import(pathToFileURL(bundle).href)

const dir = await mkdtemp(join(tmpdir(), 'yangge-acp-integration-'))
const store = new MemoryStore()
const agent = {
  id: 'agent_mock',
  name: 'Mock ACP Agent',
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
store.upsertAgents([agent])
await writeFile(join(dir, 'sample.txt'), '来自集成测试的只读内容\n', 'utf8')

const events = []
let permissionDecision = 'allow_once'
let service = null
let permissionRequests = 0

service = new AcpAgentService({
  store,
  homeDir: dir,
  defaultCwd: dir,
  emit: (channel, payload) => {
    events.push({ channel, payload })
    if (channel === 'agent:permission-request') {
      permissionRequests += 1
      assert.ok(payload.options.some((option) => option.kind === 'allow_once'))
      assert.equal(payload.requestId, payload.requestId.slice(0, 128))
      void service.respondPermission(payload.requestId, permissionDecision).then((result) => {
        assert.equal(result.ok, true)
      })
    }
  },
  diagnostics: () => {}
})

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

  const allowedAudit = store.audits.filter((entry) => entry.decision === 'allowed').length
  const deniedAudit = store.audits.filter((entry) => entry.decision === 'denied').length
  assert.ok(allowedAudit >= 2)
  assert.ok(deniedAudit >= 1)
  console.log(`[audit] allowed=${allowedAudit} denied=${deniedAudit}`)

  console.log('\nPASS: ACP 服务端到端（mock agent）')
} finally {
  service.dispose()
  await rm(dir, { recursive: true, force: true })
}
