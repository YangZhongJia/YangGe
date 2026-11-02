import { EventEmitter } from 'node:events'
import { promises as fsp } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type {
  AgentPermissionDecision,
  AgentPermissionOptionView
} from '../../../shared/ipc'
import { spawnAgentProcess, killProcessTree, type AgentChildProcess } from './agent-process'

// ACP v1 stdio 客户端（无第三方依赖）。
// 协议要点：stdout 每行一条 JSON-RPC 2.0 消息（UTF-8、\n 分隔），stderr 只作日志。

export const ACP_PROTOCOL_VERSION = 1
export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024
export const DEFAULT_MAX_FS_READ_BYTES = 2 * 1024 * 1024

/** 只声明基线读能力：不声明 terminal，也不声明 fs.writeTextFile。 */
export const ACP_CLIENT_CAPABILITIES = {
  fs: { readTextFile: true }
} as const

export class AcpError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'AcpError'
    this.code = code
    this.data = data
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function assertAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AcpError(-32602, `${label} 必须是非空字符串`)
  }
  if (!isAbsolute(value)) {
    throw new AcpError(-32602, `${label} 必须是绝对路径：${value}`)
  }
  return resolve(value)
}

function isInsidePortable(path: string, root: string): boolean {
  const target = resolve(path)
  const base = resolve(root)
  const rel = relative(base, target)
  if (process.platform === 'win32') {
    const lower = rel.toLowerCase()
    return lower === '' || (!!lower && !lower.startsWith('..') && !isAbsolute(lower))
  }
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 把字节流切成一行一条 JSON-RPC 消息。
 * 必须先按 0x0A 切 Buffer 再解码，不能按 chunk 直接 toString（会截断多字节字符）。
 */
export class JsonLineDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  readonly maxLineBytes: number

  constructor(options: { maxLineBytes?: number } = {}) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
  }

  push(chunk: Buffer | string): string[] {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes])
    const lines: string[] = []
    let newlineAt = this.buffer.indexOf(0x0a)
    while (newlineAt !== -1) {
      let line = this.buffer.subarray(0, newlineAt)
      this.buffer = this.buffer.subarray(newlineAt + 1)
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1)
      if (line.length > this.maxLineBytes) {
        throw new AcpError(-32700, `单条 ACP 消息超过 ${this.maxLineBytes} 字节上限`)
      }
      if (line.length > 0) lines.push(line.toString('utf8'))
      newlineAt = this.buffer.indexOf(0x0a)
    }
    if (this.buffer.length > this.maxLineBytes) {
      throw new AcpError(-32700, `单条 ACP 消息超过 ${this.maxLineBytes} 字节上限`)
    }
    return lines
  }

  /** 进程退出时交出最后一条不带换行的消息。 */
  flush(): string[] {
    const rest = this.buffer.toString('utf8').trim()
    this.buffer = Buffer.alloc(0)
    return rest ? [rest] : []
  }
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
}

export interface AcpPermissionOutcome {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
}

const ALLOW_KINDS: Record<string, true> = { allow_once: true, allow_always: true }
const REJECT_KINDS: Record<string, true> = { reject_once: true, reject_always: true }

function pickOption(
  options: AgentPermissionOptionView[],
  preferred: string[],
  allowedKinds: Record<string, true>
): AgentPermissionOptionView | null {
  for (const kind of preferred) {
    const found = options.find(
      (option) => option.kind === kind && allowedKinds[option.kind] === true
    )
    if (found) return found
  }
  return null
}

/**
 * UI 决策 → ACP outcome。
 * 只按 `kind` 选择；未知 kind、未知 optionId、缺失选项一律拒绝/取消，绝不自动批准。
 */
export function resolvePermissionOutcome(
  options: AgentPermissionOptionView[],
  decision: AgentPermissionDecision
): AcpPermissionOutcome {
  const allow = decision === 'allow_once' || decision === 'allow_session'
  const preferred = allow
    ? decision === 'allow_session'
      ? ['allow_always', 'allow_once']
      : ['allow_once', 'allow_always']
    : decision === 'reject_session'
      ? ['reject_always', 'reject_once']
      : ['reject_once', 'reject_always']
  const option = pickOption(options, preferred, allow ? ALLOW_KINDS : REJECT_KINDS)
  if (!option) {
    return { outcome: { outcome: 'cancelled' } }
  }
  return { outcome: { outcome: 'selected', optionId: option.optionId } }
}

export function sanitizePermissionOptions(value: unknown): AgentPermissionOptionView[] {
  if (!Array.isArray(value)) return []
  const options: AgentPermissionOptionView[] = []
  for (const item of value) {
    if (!isPlainObject(item)) continue
    if (typeof item.optionId !== 'string' || typeof item.kind !== 'string') continue
    options.push({
      optionId: item.optionId.slice(0, 200),
      name: typeof item.name === 'string' ? item.name.slice(0, 200) : item.kind,
      kind: item.kind.slice(0, 64)
    })
    if (options.length >= 16) break
  }
  return options
}

export type AcpPermissionHandler = (
  request: Record<string, unknown>
) => Promise<AcpPermissionOutcome> | AcpPermissionOutcome

export interface AcpClientOptions {
  command: string
  args?: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  /** fs/read_text_file 允许的根目录；默认 [cwd] */
  roots?: string[]
  onStderr?: (line: string) => void
  permissionHandler?: AcpPermissionHandler
  maxLineBytes?: number
  clientInfo?: { name: string; title: string; version: string }
  fsReadMaxBytes?: number
}

export interface AcpClientExitInfo {
  code: number | null
  signal: string | null
  at: number
}

export class AcpClient extends EventEmitter {
  readonly command: string
  readonly args: string[]
  readonly cwd: string
  readonly roots: string[]
  readonly clientInfo: { name: string; title: string; version: string }

  child: AgentChildProcess | null = null
  exitInfo: AcpClientExitInfo | null = null
  agentCapabilities: Record<string, unknown> = {}
  agentInfo: Record<string, unknown> | null = null
  authMethods: unknown[] = []

  private readonly env: NodeJS.ProcessEnv
  private readonly onStderr: (line: string) => void
  private permissionHandler: AcpPermissionHandler
  private readonly decoder: JsonLineDecoder
  private readonly fsReadMaxBytes: number
  private readonly sessions = new Set<string>()
  private readonly promptInFlight = new Set<string>()
  private readonly cancelledSessions = new Set<string>()
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private initialized = false
  private closed = false
  private exitResolve: ((info: AcpClientExitInfo) => void) | null = null
  private exitPromise: Promise<AcpClientExitInfo> | null = null
  private rejectOnExit: ((error: unknown) => void) | null = null

  constructor(options: AcpClientOptions) {
    super()
    if (!options.command) throw new TypeError('AcpClient 需要 command')
    this.command = options.command
    this.args = options.args ?? []
    this.cwd = resolve(options.cwd)
    this.roots = (options.roots ?? [this.cwd]).map((root) => resolve(root))
    this.env = options.env ?? {}
    this.onStderr = options.onStderr ?? (() => {})
    this.permissionHandler =
      options.permissionHandler ?? (() => ({ outcome: { outcome: 'cancelled' } }))
    this.decoder = new JsonLineDecoder({ maxLineBytes: options.maxLineBytes })
    this.clientInfo = options.clientInfo ?? {
      name: 'yangge',
      title: '阳鸽',
      version: '1.8.0'
    }
    this.fsReadMaxBytes = options.fsReadMaxBytes ?? DEFAULT_MAX_FS_READ_BYTES
  }

  get pendingCount(): number {
    return this.pending.size
  }

  get sessionIds(): string[] {
    return [...this.sessions]
  }

  get isClosed(): boolean {
    return this.closed
  }

  setPermissionHandler(handler: AcpPermissionHandler): void {
    this.permissionHandler = handler
  }

  async connect(): Promise<void> {
    if (this.child) return
    this.closed = false
    const child = spawnAgentProcess({
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      env: this.env
    })
    this.child = child
    this.exitPromise = new Promise<AcpClientExitInfo>((resolvePromise) => {
      this.exitResolve = resolvePromise
    })
    const exitFailure = new Promise<never>((_resolve, rejectPromise) => {
      this.rejectOnExit = rejectPromise
    })
    // 没有权限请求在等待时也要吞掉这个 rejection，避免 unhandledRejection。
    exitFailure.catch(() => {})

    child.once('exit', (code, signal) => this.handleExit(code, signal))
    child.once('error', (error) => {
      this.emit('process-error', error)
      this.failPending(error)
      this.handleExit(null, null)
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') this.emit('stdin-error', error)
    })
    child.stdout.on('data', (chunk: Buffer) => {
      let lines: string[]
      try {
        lines = this.decoder.push(chunk)
      } catch (error) {
        this.emit('protocol-error', error)
        // 超长帧视为滥用：结束进程，避免缓冲区继续增长。
        this.terminate()
        return
      }
      for (const line of lines) this.handleLine(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) this.onStderr(line.slice(0, 2000))
      }
    })

    await new Promise<void>((resolvePromise, rejectPromise) => {
      if (child.pid) {
        resolvePromise()
        return
      }
      child.once('spawn', resolvePromise)
      child.once('error', rejectPromise)
    })
  }

  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: ACP_CLIENT_CAPABILITIES,
        clientInfo: this.clientInfo
      },
      { timeoutMs: 15000 }
    )
    if (!isPlainObject(result)) throw new AcpError(-32603, 'initialize 响应不是对象')
    if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AcpError(
        -32000,
        `不支持的 ACP 协议版本：Agent=${String(result.protocolVersion)}，客户端=${ACP_PROTOCOL_VERSION}`
      )
    }
    this.initialized = true
    this.agentCapabilities = isPlainObject(result.agentCapabilities)
      ? result.agentCapabilities
      : {}
    this.agentInfo = isPlainObject(result.agentInfo) ? result.agentInfo : null
    this.authMethods = Array.isArray(result.authMethods) ? result.authMethods : []
    this.emit('initialized', result)
    return result
  }

  async newSession(cwd: string = this.cwd): Promise<{ sessionId: string }> {
    if (!this.initialized) throw new AcpError(-32000, '必须先完成 initialize')
    const absolute = assertAbsolutePath(cwd, 'cwd')
    const stat = await fsp.stat(absolute).catch(() => null)
    if (!stat || !stat.isDirectory()) {
      throw new AcpError(-32602, `会话 cwd 不存在或不是目录：${absolute}`)
    }
    const result = await this.request(
      'session/new',
      { cwd: absolute, mcpServers: [] },
      { timeoutMs: 30000 }
    )
    if (!isPlainObject(result) || typeof result.sessionId !== 'string' || !result.sessionId) {
      throw new AcpError(-32603, 'session/new 响应缺少 sessionId')
    }
    this.sessions.add(result.sessionId)
    this.emit('session', result)
    return { sessionId: result.sessionId }
  }

  async prompt(
    sessionId: string,
    text: string,
    options: { timeoutMs?: number } = {}
  ): Promise<{ stopReason: string }> {
    if (!this.sessions.has(sessionId)) throw new AcpError(-32002, `未知会话：${sessionId}`)
    if (this.promptInFlight.has(sessionId)) {
      throw new AcpError(-32600, '同一 ACP 会话已有进行中的 prompt')
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw new AcpError(-32602, 'prompt 文本不能为空')
    }
    this.promptInFlight.add(sessionId)
    this.cancelledSessions.delete(sessionId)
    try {
      const result = await this.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text }] },
        { timeoutMs: options.timeoutMs ?? 0 }
      )
      if (!isPlainObject(result) || typeof result.stopReason !== 'string') {
        throw new AcpError(-32603, 'session/prompt 响应缺少 stopReason')
      }
      return { stopReason: result.stopReason }
    } finally {
      this.promptInFlight.delete(sessionId)
    }
  }

  /** session/cancel 是通知，无响应；Agent 最终以 stopReason:"cancelled" 结束。 */
  cancel(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return
    this.cancelledSessions.add(sessionId)
    void this.writeMessage({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId }
    }).catch(() => {})
    this.emit('cancel-sent', { sessionId })
  }

  request(
    method: string,
    params: unknown,
    options: { timeoutMs?: number } = {}
  ): Promise<unknown> {
    if (!this.child || this.closed) {
      return Promise.reject(new AcpError(-32000, 'ACP 连接未建立或已关闭'))
    }
    const id = this.nextRequestId++
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      const entry: PendingRequest = {
        method,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer: null
      }
      const timeoutMs = options.timeoutMs ?? 0
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.has(id)) return
          this.pending.delete(id)
          rejectPromise(new AcpError(-32800, `${method} 超时（${timeoutMs}ms）`))
        }, timeoutMs)
        entry.timer.unref?.()
      }
      this.pending.set(id, entry)
    })
    void this.writeMessage({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    })
    return promise
  }

  async writeMessage(message: Record<string, unknown>): Promise<void> {
    if (!this.child || this.closed) throw new AcpError(-32000, 'ACP 连接未建立或已关闭')
    // JSON.stringify 会转义字符串内的换行，因此一条消息不会出现裸换行。
    const line = `${JSON.stringify(message)}\n`
    const ok = this.child.stdin.write(line, 'utf8')
    if (!ok) {
      await new Promise<void>((resolvePromise) => this.child?.stdin.once('drain', resolvePromise))
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.exitInfo) return
    const info: AcpClientExitInfo = { code, signal, at: Date.now() }
    this.exitInfo = info
    this.failPending(new AcpError(-32000, `ACP Agent 已退出（code=${code}, signal=${signal}）`))
    if (this.rejectOnExit) {
      this.rejectOnExit(new AcpError(-32000, 'ACP Agent 已退出，权限请求取消'))
      this.rejectOnExit = null
    }
    if (this.exitResolve) {
      this.exitResolve(info)
      this.exitResolve = null
    }
    this.emit('exit', info)
  }

  private failPending(error: unknown): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  private handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch (error) {
      this.emit(
        'protocol-error',
        new AcpError(-32700, `无法解析 ACP 消息：${error instanceof Error ? error.message : ''}`)
      )
      return
    }
    if (!isPlainObject(message) || message['jsonrpc'] !== '2.0') {
      this.emit('protocol-error', new AcpError(-32600, '非 JSON-RPC 2.0 消息'))
      return
    }
    const id = message['id']
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id')
    if (hasId && (Object.prototype.hasOwnProperty.call(message, 'result') ||
      Object.prototype.hasOwnProperty.call(message, 'error'))) {
      if (typeof id !== 'number') {
        this.emit('protocol-error', new AcpError(-32600, '响应 id 不是数字'))
        return
      }
      const entry = this.pending.get(id)
      if (!entry) {
        this.emit('protocol-error', new AcpError(-32600, `收到未知请求 id 的响应：${id}`))
        return
      }
      this.pending.delete(id)
      clearTimeout(entry.timer ?? undefined)
      const error = message['error']
      if (isPlainObject(error)) {
        entry.reject(
          new AcpError(
            typeof error['code'] === 'number' ? error['code'] : -32603,
            typeof error['message'] === 'string' ? error['message'] : 'Agent 返回错误',
            error['data']
          )
        )
      } else {
        entry.resolve(message['result'])
      }
      return
    }

    if (typeof message['method'] === 'string' && hasId) {
      void this.handleIncomingRequest(message)
      return
    }
    if (typeof message['method'] === 'string') {
      this.handleNotification(message)
      return
    }
    this.emit('protocol-error', new AcpError(-32600, '无法识别的 JSON-RPC 消息'))
  }

  private handleNotification(message: Record<string, unknown>): void {
    if (message['method'] !== 'session/update') {
      this.emit('notification', message)
      return
    }
    const params = message['params']
    if (!isPlainObject(params) || typeof params['sessionId'] !== 'string') {
      this.emit('protocol-error', new AcpError(-32602, 'session/update 参数不合法'))
      return
    }
    const update = params['update']
    if (!isPlainObject(update)) {
      this.emit('protocol-error', new AcpError(-32602, 'session/update 参数不合法'))
      return
    }
    const sessionId = params['sessionId']
    if (!this.sessions.has(sessionId)) {
      this.emit('protocol-error', new AcpError(-32602, `session/update 的 sessionId 未注册：${sessionId}`))
      return
    }
    this.emit('update', params)
    const kind = update['sessionUpdate']
    if (typeof kind === 'string') this.emit(`update:${kind}`, params)
  }

  private async handleIncomingRequest(message: Record<string, unknown>): Promise<void> {
    const id = message['id']
    const method = message['method']
    const params = message['params']
    try {
      let result: unknown
      switch (method) {
        case 'fs/read_text_file':
          result = await this.readTextFile(params)
          break
        case 'session/request_permission':
          result = await this.requestPermission(params)
          break
        default:
          throw new AcpError(-32601, `客户端未实现方法：${String(method)}`)
      }
      await this.writeMessage({ jsonrpc: '2.0', id, result })
    } catch (error) {
      const acpError = error instanceof AcpError
        ? error
        : new AcpError(-32603, error instanceof Error ? error.message : '客户端内部错误')
      await this.writeMessage({
        jsonrpc: '2.0',
        id,
        error: {
          code: acpError.code,
          message: acpError.message,
          ...(acpError.data === undefined ? {} : { data: acpError.data })
        }
      }).catch(() => {})
    }
  }

  private async requestPermission(params: unknown): Promise<AcpPermissionOutcome> {
    if (!isPlainObject(params) || typeof params['sessionId'] !== 'string') {
      throw new AcpError(-32602, 'session/request_permission 参数缺失')
    }
    const sessionId = params['sessionId']
    if (this.cancelledSessions.has(sessionId)) {
      return { outcome: { outcome: 'cancelled' } }
    }
    this.emit('permission-request', params)
    let decision: AcpPermissionOutcome
    try {
      decision = await this.withExitRace(this.permissionHandler(params))
    } catch (error) {
      this.emit('permission-handler-error', error)
      return { outcome: { outcome: 'cancelled' } }
    }
    const options = sanitizePermissionOptions(params['options'])
    const outcome = decision?.outcome
    if (!outcome || outcome.outcome === 'cancelled') {
      this.emit('permission-result', { ...params, decision: { outcome: { outcome: 'cancelled' } } })
      return { outcome: { outcome: 'cancelled' } }
    }
    if (typeof outcome.optionId !== 'string' ||
      !options.some((option) => option.optionId === outcome.optionId)) {
      // 不认识的选项一律按拒绝处理，不能当成批准。
      const reject = options.find((option) => REJECT_KINDS[option.kind] === true)
      const fallback: AcpPermissionOutcome = reject
        ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
        : { outcome: { outcome: 'cancelled' } }
      this.emit('permission-result', { ...params, decision: fallback })
      return fallback
    }
    this.emit('permission-result', { ...params, decision })
    return decision
  }

  /** 子进程退出时不让权限处理 promise 永久挂住。 */
  private withExitRace<T>(value: Promise<T> | T): Promise<T> {
    const exitFailure = new Promise<never>((_resolve, rejectPromise) => {
      this.rejectOnExit = rejectPromise
    })
    // 若与 exitFailure 并存且没有 exit，catch 分支不产生副作用。
    exitFailure.catch(() => {})
    return Promise.race([Promise.resolve(value), exitFailure])
  }

  private async readTextFile(params: unknown): Promise<{ content: string }> {
    if (!isPlainObject(params)) throw new AcpError(-32602, 'fs/read_text_file 参数缺失')
    const sessionId = params['sessionId']
    if (typeof sessionId !== 'string' || !this.sessions.has(sessionId)) {
      throw new AcpError(-32002, '未知会话', { sessionId })
    }
    const absolute = assertAbsolutePath(params['path'], 'path')
    const real = await this.realPathForCheck(absolute)
    const roots = await Promise.all(
      this.roots.map(async (root) => fsp.realpath(root).catch(() => resolve(root)))
    )
    if (!roots.some((root) => isInsidePortable(real, root))) {
      throw new AcpError(-32003, `路径超出会话根目录：${absolute}`)
    }
    const stat = await fsp.stat(real).catch(() => null)
    if (!stat || !stat.isFile()) throw new AcpError(-32002, `文件不存在：${absolute}`)
    if (stat.size > this.fsReadMaxBytes) {
      throw new AcpError(-32603, `文件超过读取上限（${this.fsReadMaxBytes} 字节）`)
    }
    let text = await fsp.readFile(real, 'utf8')
    const line = params['line']
    const limit = params['limit']
    if (Number.isInteger(line) || Number.isInteger(limit)) {
      const lines = text.split(/\r?\n/)
      const start = Number.isInteger(line) && (line as number) > 0 ? (line as number) - 1 : 0
      const count = Number.isInteger(limit) && (limit as number) >= 0 ? (limit as number) : lines.length
      text = lines.slice(start, start + count).join('\n')
    }
    return { content: text }
  }

  private async realPathForCheck(absolute: string): Promise<string> {
    try {
      return await fsp.realpath(absolute)
    } catch {
      const parent = await fsp.realpath(resolve(absolute, '..')).catch(() => resolve(absolute, '..'))
      return resolve(parent, basename(absolute))
    }
  }

  async close(options: { graceMs?: number } = {}): Promise<AcpClientExitInfo | null> {
    if (!this.child) return null
    if (this.closed) return this.exitPromise ?? Promise.resolve(this.exitInfo)
    this.closed = true
    const closingError = new AcpError(-32800, '客户端关闭，请求已取消')
    this.failPending(closingError)
    if (this.rejectOnExit) {
      this.rejectOnExit(closingError)
      this.rejectOnExit = null
    }
    try {
      this.child.stdin.end()
    } catch {
      // 已关闭
    }
    const exitPromise = this.exitPromise
    if (!exitPromise) return null
    const graceMs = options.graceMs ?? 2000
    await Promise.race([exitPromise, new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, graceMs)
      timer.unref?.()
    })])
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await killProcessTree(this.child.pid)
      await Promise.race([exitPromise, new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, 1000)
        timer.unref?.()
      })])
    }
    return this.exitInfo
  }

  /** 退出流程用的同步收口：不等优雅退出，直接清理。 */
  terminate(): void {
    this.closed = true
    this.failPending(new AcpError(-32800, '应用退出，Agent 会话已关闭'))
    if (this.rejectOnExit) {
      this.rejectOnExit(new AcpError(-32800, '应用退出，权限请求取消'))
      this.rejectOnExit = null
    }
    const child = this.child
    if (!child) return
    try {
      child.stdin.end()
    } catch {
      // ignore
    }
    void killProcessTree(child.pid)
  }
}
