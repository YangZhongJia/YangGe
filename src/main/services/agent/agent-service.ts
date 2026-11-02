import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
  IpcEvents,
  type AgentAuditView,
  type AgentErrorEvent,
  type AgentExitEvent,
  type AgentPermissionDecision,
  type AgentPermissionRequestView,
  type AgentPermissionResolvedEvent,
  type AgentProbeResult,
  type AgentResult,
  type AgentRunResult,
  type AgentScanResult,
  type AgentSessionUpdate,
  type AgentSessionView,
  type AgentStatusEvent,
  type AgentToolLocation,
  type AgentUpdateEvent,
  type AgentView
} from '../../../shared/ipc'
import type { AgentStore } from '../../store/agent-repo'
import {
  AcpClient,
  resolvePermissionOutcome,
  sanitizePermissionOptions,
  type AcpClientExitInfo,
  type AcpPermissionOutcome
} from './acp-client'
import {
  discoverAgents,
  inspectManualAgent,
  type DiscoveredAgent
} from './agent-discovery'

// ACP Agent 用例层：启动配置、会话生命周期、prompt 串行化、权限路由与审计。
// 不依赖 Electron；IPC 层只做参数校验与转发，便于用 mock agent 独立集成测试。

const MAX_PROMPT_BYTES = 128 * 1024
const MAX_TITLE_CHARS = 500
const MAX_LOCATIONS = 20
const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000

export interface AgentServiceOptions {
  store: AgentStore
  emit: (channel: string, payload: unknown) => void
  homeDir: string
  defaultCwd?: string
  clientVersion?: string
  now?: () => number
  id?: () => string
  permissionTimeoutMs?: number
  diagnostics?: (event: 'agent.state', data?: Record<string, unknown>, error?: unknown) => void
}

interface ActiveSession {
  view: AgentSessionView
  agent: AgentView
  client: AcpClient
  autoAllow: boolean
  runId: string | null
  closing: boolean
}

interface PendingPermission {
  requestId: string
  sessionId: string
  runId: string | null
  options: ReturnType<typeof sanitizePermissionOptions>
  resolve: (decision: AgentPermissionDecision | null) => void
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500)
  return String(error).slice(0, 500)
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, max)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeLocations(value: unknown): AgentToolLocation[] {
  if (!Array.isArray(value)) return []
  const locations: AgentToolLocation[] = []
  for (const item of value) {
    if (!isPlainObject(item) || typeof item.path !== 'string') continue
    locations.push({
      path: item.path.slice(0, 1024),
      line: typeof item.line === 'number' && Number.isInteger(item.line) ? item.line : undefined
    })
    if (locations.length >= MAX_LOCATIONS) break
  }
  return locations
}

function ok<T>(value: T): AgentResult<T> {
  return { ok: true, value }
}

function fail<T>(error: unknown): AgentResult<T> {
  return { ok: false, error: errorText(error) }
}

export class AcpAgentService {
  private readonly store: AgentStore
  private readonly emitRaw: (channel: string, payload: unknown) => void
  private readonly defaultCwd: string
  private readonly clientVersion: string
  private readonly now: () => number
  private readonly id: () => string
  private readonly permissionTimeoutMs: number
  private readonly diagnostics: NonNullable<AgentServiceOptions['diagnostics']>

  private readonly sessions = new Map<string, ActiveSession>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private disposed = false

  constructor(options: AgentServiceOptions) {
    this.store = options.store
    this.emitRaw = options.emit
    this.defaultCwd = options.defaultCwd ?? options.homeDir
    this.clientVersion = options.clientVersion ?? '1.8.0'
    this.now = options.now ?? (() => Date.now())
    this.id = options.id ?? (() => randomUUID())
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
    this.diagnostics = options.diagnostics ?? (() => {})
  }

  listAgents(): AgentView[] {
    try {
      return this.store.listAgents()
    } catch (error) {
      this.diagnostics('agent.state', { status: 'failed' }, error)
      return []
    }
  }

  listSessions(limit = 50): AgentSessionView[] {
    try {
      return this.store.listSessions(limit)
    } catch (error) {
      this.diagnostics('agent.state', { status: 'failed' }, error)
      return []
    }
  }

  listAudit(limit = 100): AgentAuditView[] {
    try {
      return this.store.listAudit(limit)
    } catch {
      return []
    }
  }

  async scanAgents(): Promise<AgentResult<AgentScanResult>> {
    if (this.disposed) return fail('应用正在退出')
    try {
      const discovery = await discoverAgents()
      const scannedAt = this.now()
      const agents = discovery.agents.map((item) => this.toAgentView(item, scannedAt))
      this.store.upsertAgents(agents)
      return ok({
        agents: this.store.listAgents(),
        found: agents.length,
        failures: discovery.failures,
        scannedAt
      })
    } catch (error) {
      return fail(error)
    }
  }

  async probeAgent(path: string): Promise<AgentProbeResult> {
    if (this.disposed) return { ok: false, error: '应用正在退出' }
    if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
      return { ok: false, error: '路径不合法' }
    }
    const inspected = await inspectManualAgent(path)
    if (!inspected.ok || !inspected.agent) {
      return { ok: false, error: inspected.error || '无法识别该可执行文件' }
    }
    const view = this.toAgentView(inspected.agent, this.now())
    this.store.upsertAgents([view])
    const stored = this.store.getAgent(view.id)
    return { ok: true, agent: stored ?? view }
  }

  async newSession(agentId: string, cwd?: string): Promise<AgentResult<AgentSessionView>> {
    if (this.disposed) return fail('应用正在退出')
    if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 64) {
      return fail('Agent 标识不合法')
    }
    const agent = this.store.getAgent(agentId)
    if (!agent) return fail('Agent 不存在，请重新扫描')
    if (!agent.enabled) return fail('该 Agent 已停用')
    if (typeof cwd === 'string' && cwd.length > 4096) return fail('工作目录过长')

    const target = (cwd && cwd.trim()) || agent.cwd || this.defaultCwd
    if (!isAbsolute(target)) return fail('会话工作目录必须是绝对路径')
    const dir = resolve(target)
    try {
      if (!statSync(dir).isDirectory()) return fail('会话工作目录不是目录')
    } catch {
      return fail('会话工作目录不存在')
    }

    const at = this.now()
    const view: AgentSessionView = {
      id: this.id(),
      agentId: agent.id,
      agentName: agent.name,
      acpSessionId: null,
      cwd: dir,
      title: agent.name,
      status: 'starting',
      createdAt: at,
      updatedAt: at
    }
    try {
      this.store.createSession(view)
    } catch (error) {
      return fail(error)
    }

    let client: AcpClient
    try {
      client = new AcpClient({
        command: agent.command,
        args: agent.args,
        cwd: dir,
        roots: [dir],
        clientInfo: { name: 'yangge', title: '阳鸽', version: this.clientVersion }
      })
    } catch (error) {
      return fail(error)
    }

    const active: ActiveSession = {
      view,
      agent,
      client,
      autoAllow: false,
      runId: null,
      closing: false
    }
    this.sessions.set(view.id, active)
    this.bindClient(active)
    this.emitStatus(active)

    try {
      await client.connect()
      await client.initialize()
      const session = await client.newSession(dir)
      const updated = this.store.updateSession(view.id, {
        acpSessionId: session.sessionId,
        status: 'idle',
        updatedAt: this.now()
      })
      if (updated) active.view = updated
      this.store.touchAgent(agent.id, this.now())
      this.emitStatus(active)
      return ok(active.view)
    } catch (error) {
      this.diagnostics('agent.state', { status: 'failed' }, error)
      active.closing = true
      void client.close({ graceMs: 1200 }).catch(() => {})
      this.sessions.delete(view.id)
      const updated = this.safeUpdateSession(view.id, { status: 'failed' })
      if (updated) active.view = updated
      this.emitStatus(active)
      return fail(error)
    }
  }

  async prompt(sessionId: string, text: string): Promise<AgentResult<AgentRunResult>> {
    if (this.disposed) return fail('应用正在退出')
    const active = this.sessions.get(sessionId)
    if (!active) return fail('会话不存在或已关闭')
    const acpSessionId = active.view.acpSessionId
    if (!acpSessionId) return fail('会话尚未就绪')
    if (active.runId) return fail('该会话已有进行中的回复，请先停止')
    if (typeof text !== 'string' || text.trim().length === 0) return fail('消息不能为空')
    if (Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) return fail('消息过长')
    if (active.closing) return fail('会话正在关闭')

    const runId = this.id()
    try {
      this.store.createRun({ id: runId, sessionId, prompt: text, startedAt: this.now() })
    } catch (error) {
      return fail(error)
    }
    active.runId = runId
    active.view = this.safeUpdateSession(sessionId, { status: 'running' }) ?? active.view
    this.emitStatus(active)

    try {
      const result = await active.client.prompt(acpSessionId, text)
      if (active.runId === runId) {
        this.finishRunSafe(runId, { stopReason: result.stopReason, error: null })
      }
      return ok({ runId, stopReason: result.stopReason })
    } catch (error) {
      if (active.runId === runId) {
        this.finishRunSafe(runId, { stopReason: null, error: errorText(error) })
      }
      this.emitError(sessionId, error)
      return fail(error)
    } finally {
      active.runId = null
      if (!active.closing && !active.client.exitInfo) {
        active.view = this.safeUpdateSession(sessionId, { status: 'idle' }) ?? active.view
        this.emitStatus(active)
      }
    }
  }

  cancel(sessionId: string): void {
    const active = this.sessions.get(sessionId)
    if (!active || !active.view.acpSessionId) return
    this.resolvePendingForSession(sessionId)
    active.client.cancel(active.view.acpSessionId)
  }

  async respondPermission(
    requestId: string,
    decision: AgentPermissionDecision
  ): Promise<AgentResult<null>> {
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
      return fail('权限请求标识不合法')
    }
    if (!['allow_once', 'allow_session', 'reject_once', 'reject_session'].includes(decision)) {
      return fail('权限决策不合法')
    }
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return fail('权限请求已结束')
    this.pendingPermissions.delete(requestId)
    const active = this.sessions.get(pending.sessionId)
    if (active && decision === 'allow_session') active.autoAllow = true
    pending.resolve(decision)
    return ok(null)
  }

  async closeSession(sessionId: string): Promise<void> {
    const active = this.sessions.get(sessionId)
    if (!active) return
    active.closing = true
    this.resolvePendingForSession(sessionId)
    await active.client.close({ graceMs: 2000 }).catch(() => null)
    this.sessions.delete(sessionId)
    const updated = this.safeUpdateSession(sessionId, { status: 'closed' })
    if (updated) active.view = updated
    this.emitStatus(active)
  }

  /** before-quit 调用：同步收口，不依赖 DB 仍可用。 */
  dispose(): void {
    this.disposed = true
    for (const active of this.sessions.values()) {
      active.closing = true
      this.resolvePendingForSession(active.view.id)
      this.safeUpdateSession(active.view.id, { status: 'closed' })
      active.client.terminate()
    }
    this.sessions.clear()
    this.pendingPermissions.clear()
  }

  private bindClient(active: ActiveSession): void {
    active.client.setPermissionHandler((params) => this.handlePermissionRequest(active, params))
    active.client.on('update', (params: Record<string, unknown>) => {
      if (this.disposed) return
      const update = params['update']
      if (!isPlainObject(update)) return
      const event: AgentUpdateEvent = {
        sessionId: active.view.id,
        runId: active.runId,
        update: update as AgentSessionUpdate
      }
      this.emit(IpcEvents.agentUpdate, event)
    })
    active.client.on('exit', (info: AcpClientExitInfo) => this.handleClientExit(active, info))
    active.client.on('protocol-error', (error: unknown) => {
      this.diagnostics('agent.state', { sessionId: active.view.id }, error)
      this.emitError(active.view.id, error)
    })
    active.client.on('process-error', (error: unknown) => {
      this.diagnostics('agent.state', { sessionId: active.view.id }, error)
    })
    active.client.on('stdin-error', (error: unknown) => {
      this.diagnostics('agent.state', { sessionId: active.view.id }, error)
    })
  }

  private handleClientExit(active: ActiveSession, info: AcpClientExitInfo): void {
    this.resolvePendingForSession(active.view.id)
    this.sessions.delete(active.view.id)
    const expected = active.closing
    const status = expected ? 'closed' : 'failed'
    if (active.runId) {
      this.finishRunSafe(active.runId, {
        stopReason: 'cancelled',
        error: expected ? '会话已关闭' : `Agent 已退出（code=${info.code}）`
      })
      active.runId = null
    }
    const updated = this.safeUpdateSession(active.view.id, { status })
    if (updated) active.view = updated
    this.emitStatus(active)
    this.emitExit(active, info, expected)
    if (!expected) {
      this.emitError(active.view.id, `Agent 已退出（code=${info.code}, signal=${info.signal}）`)
    }
  }

  private async handlePermissionRequest(
    active: ActiveSession,
    params: Record<string, unknown>
  ): Promise<AcpPermissionOutcome> {
    if (active.closing || this.disposed) return { outcome: { outcome: 'cancelled' } }
    const options = sanitizePermissionOptions(params['options'])
    const toolCall = isPlainObject(params['toolCall']) ? params['toolCall'] : {}
    const runId = active.runId

    if (active.autoAllow) {
      const outcome = resolvePermissionOutcome(options, 'allow_once')
      this.audit(active, runId, 'session/request_permission', toolCall, options, outcome, 'allowed', 'session-policy')
      return outcome
    }

    const rawInput = isPlainObject(toolCall['rawInput']) ? toolCall['rawInput'] : {}
    const requestId = `perm_${this.id()}`
    const request: AgentPermissionRequestView = {
      requestId,
      sessionId: active.view.id,
      runId,
      toolCallId: cleanText(toolCall['toolCallId'], 200),
      title: cleanText(toolCall['title'], MAX_TITLE_CHARS),
      toolKind: cleanText(toolCall['kind'], 64),
      status: cleanText(toolCall['status'], 32),
      locations: sanitizeLocations(toolCall['locations']),
      command: cleanText(rawInput['command'], 2000),
      options,
      createdAt: this.now()
    }

    const decision = await new Promise<AgentPermissionDecision | null>((resolvePromise) => {
      const pending: PendingPermission = {
        requestId,
        sessionId: active.view.id,
        runId,
        options,
        resolve: resolvePromise
      }
      this.pendingPermissions.set(requestId, pending)
      this.emit(IpcEvents.agentPermissionRequest, request)
      const timer = setTimeout(() => {
        if (!this.pendingPermissions.delete(requestId)) return
        // 超时按默认拒绝处理；只有显式取消/关闭才回 cancelled。
        resolvePromise('reject_once')
      }, this.permissionTimeoutMs)
      timer.unref?.()
    })

    this.pendingPermissions.delete(requestId)
    const outcome: AcpPermissionOutcome = decision === null
      ? { outcome: { outcome: 'cancelled' } }
      : resolvePermissionOutcome(options, decision)
    const decisionLabel = decision === null
      ? 'cancelled'
      : decision.startsWith('allow') ? 'allowed' : 'denied'
    this.audit(active, runId, 'session/request_permission', toolCall, options, outcome, decisionLabel, decision ?? 'timeout')
    const resolved: AgentPermissionResolvedEvent = {
      requestId,
      sessionId: active.view.id,
      outcome: outcome.outcome.outcome === 'selected' ? 'selected' : 'cancelled',
      optionId: outcome.outcome.outcome === 'selected' ? outcome.outcome.optionId : null
    }
    this.emit(IpcEvents.agentPermissionResolved, resolved)
    return outcome
  }

  private resolvePendingForSession(sessionId: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.sessionId !== sessionId) continue
      this.pendingPermissions.delete(requestId)
      pending.resolve(null)
    }
  }

  private audit(
    active: ActiveSession,
    runId: string | null,
    method: string,
    toolCall: Record<string, unknown>,
    options: ReturnType<typeof sanitizePermissionOptions>,
    outcome: AcpPermissionOutcome,
    decision: string,
    detail: string
  ): void {
    const optionId = outcome.outcome.outcome === 'selected' ? outcome.outcome.optionId : ''
    const option = options.find((item) => item.optionId === optionId)
    const locations = sanitizeLocations(toolCall['locations'])
    const rawInput = isPlainObject(toolCall['rawInput']) ? toolCall['rawInput'] : {}
    try {
      this.store.addAudit({
        id: this.id(),
        runId: runId ?? '',
        ts: this.now(),
        method,
        toolCallId: cleanText(toolCall['toolCallId'], 200),
        optionKind: option?.kind ?? '',
        decision,
        path: locations[0]?.path ?? '',
        command: cleanText(rawInput['command'], 2000),
        detail: `${detail}; option=${optionId || 'cancelled'}`
      })
    } catch (error) {
      this.diagnostics('agent.state', { sessionId: active.view.id }, error)
    }
  }

  private emitStatus(active: ActiveSession): void {
    const event: AgentStatusEvent = {
      session: active.view,
      runId: active.runId,
      running: active.runId !== null
    }
    this.emit(IpcEvents.agentStatus, event)
  }

  private emitExit(active: ActiveSession, info: AcpClientExitInfo | null, expected: boolean): void {
    const event: AgentExitEvent = {
      sessionId: active.view.id,
      code: info?.code ?? null,
      signal: info?.signal ?? null,
      message: expected ? '会话已关闭' : 'Agent 意外退出',
      expected
    }
    this.emit(IpcEvents.agentExit, event)
  }

  private emitError(sessionId: string | null, error: unknown): void {
    const event: AgentErrorEvent = { sessionId, message: errorText(error) }
    this.emit(IpcEvents.agentError, event)
  }

  private emit(channel: string, payload: unknown): void {
    if (this.disposed) return
    try {
      this.emitRaw(channel, payload)
    } catch (error) {
      this.diagnostics('agent.state', { channel }, error)
    }
  }

  private safeUpdateSession(
    sessionId: string,
    patch: { status?: AgentSessionView['status']; acpSessionId?: string | null }
  ): AgentSessionView | null {
    try {
      return this.store.updateSession(sessionId, { ...patch, updatedAt: this.now() })
    } catch (error) {
      this.diagnostics('agent.state', { sessionId }, error)
      return null
    }
  }

  private finishRunSafe(
    runId: string,
    patch: { stopReason: string | null; error: string | null }
  ): void {
    try {
      this.store.finishRun(runId, patch)
    } catch (error) {
      this.diagnostics('agent.state', { runId }, error)
    }
  }

  private toAgentView(item: DiscoveredAgent, probeAt: number): AgentView {
    const id = `agent_${createHash('sha1').update(item.command.toLowerCase()).digest('hex').slice(0, 16)}`
    const existing = this.store.getAgent(id)
    return {
      id,
      name: item.name,
      command: item.command,
      args: item.args,
      cwd: existing?.cwd || this.defaultCwd,
      version: item.version,
      source: item.source,
      probeError: item.probeError,
      enabled: existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? probeAt,
      lastUsedAt: existing?.lastUsedAt ?? 0,
      lastProbeTs: probeAt
    }
  }
}
