import { accessSync, constants as fsConstants, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, join } from 'node:path'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  PiEvent,
  PiModelView,
  PiRouterView,
  PiStartInput,
  PiStartResult,
  PiStateView
} from '../../../shared/ipc'
import { JsonLineDecoder } from '../agent/acp-client'
import { killProcessTree, spawnAgentProcess } from '../agent/agent-process'

// Pi 编程：不复用阳鸽旧 ACP Agent。每个项目直接驱动 `pi --mode rpc`，
// 由主进程做 JSONL 转发；Pi 自己负责模型、工具、会话和扩展。
// 约束：Pi 需要 Node 22.19+，所以这里是外部子进程，不在 Electron 内 import Pi。

const REQUEST_TIMEOUT_MS = 30_000
const MAX_ERROR_CHARS = 400

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface PiState {
  projectPath: string
  router: PiRouterView
  models: PiModelView[]
  currentModel: PiModelView | null
  running: boolean
}

export interface PiServiceOptions {
  userDataDir: string
  emit: (event: PiEvent) => void
  diagnostics?: (event: string, data?: Record<string, unknown>, error?: unknown) => void
}

export class PiService {
  private child: ChildProcessWithoutNullStreams | null = null
  private state: PiState | null = null
  private pending = new Map<string, PendingRequest>()
  private seq = 0
  private stderrTail = ''
  private disposed = false

  constructor(private readonly options: PiServiceOptions) {}

  async start(input: PiStartInput): Promise<PiStartResult> {
    if (this.disposed) return { ok: false, error: '应用正在退出' }
    const projectPath = input.projectPath.trim()
    if (!projectPath || !existsSync(projectPath)) {
      return { ok: false, error: '项目目录不存在' }
    }
    try {
      if (!statSync(projectPath).isDirectory()) return { ok: false, error: '请选择一个项目文件夹' }
      const command = resolvePiCommand()
      if (!command) {
        return {
          ok: false,
          error: '未找到 Pi。请先安装 Pi（需要 Node 22.19+），或把 pi 加入 PATH。'
        }
      }
      await this.stop()
      const router = normalizeRouter(input.router)
      if (router.mode === 'magpie') {
        const models = await listMagpieModels(router.baseUrl, router.apiKey)
        if (models.length === 0) {
          return { ok: false, error: 'Magpie 没有返回可用模型，请检查网关地址和登录状态' }
        }
        const model = router.modelId ? models.find((item) => item.id === router.modelId) : null
        if (router.modelId && !model) {
          return { ok: false, error: `Magpie 模型不存在：${router.modelId}` }
        }
        const configDir = join(this.options.userDataDir, 'pi-router')
        mkdirSync(configDir, { recursive: true })
        writeFileSync(
          join(configDir, 'models.json'),
          JSON.stringify(
            {
              providers: {
                magpie: {
                  baseUrl: router.baseUrl.replace(/\/+$/, ''),
                  api: 'openai-completions',
                  apiKey: router.apiKey || 'magpie',
                  models: models.map((item) => ({ id: item.id, name: item.name || item.id }))
                }
              }
            },
            null,
            2
          ),
          'utf8'
        )
        this.spawn(command, projectPath, {
          PI_CODING_AGENT_DIR: configDir,
          PI_OFFLINE: '1'
        })
        const available = await this.getAvailableModels()
        const wanted = model ?? available[0]
        if (wanted) {
          // state 尚未建立，不能走会检查 state 的 setModel()。
          await this.request('set_model', { provider: wanted.provider, modelId: wanted.id })
        }
        const current = await this.readCurrentModel()
        this.state = {
          projectPath,
          router,
          models: available,
          currentModel: current ?? wanted ?? null,
          running: true
        }
        if (current) this.emit({ type: 'status', message: `已连接 Pi · ${current.name || current.id}` })
        return { ok: true, state: this.view() }
      }

      this.spawn(command, projectPath, {})
      const available = await this.getAvailableModels()
      const current = await this.readCurrentModel()
      this.state = {
        projectPath,
        router,
        models: available,
        currentModel: current ?? available[0] ?? null,
        running: true
      }
      if (current) this.emit({ type: 'status', message: `已连接 Pi · ${current.name || current.id}` })
      return { ok: true, state: this.view() }
    } catch (error) {
      const message = errorText(error)
      await this.stop()
      this.options.diagnostics?.('pi.start', { projectPath }, error)
      return { ok: false, error: message }
    }
  }

  async prompt(text: string): Promise<PiStartResult> {
    if (!this.child || !this.state) return { ok: false, error: 'Pi 尚未启动' }
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, error: '输入不能为空' }
    try {
      const response = await this.request('prompt', { message: trimmed })
      const data = response as { disposition?: string } | null
      const disposition = data?.disposition
      if (disposition === 'started' || disposition === 'queued') {
        this.state.running = true
      }
      return { ok: true, state: this.view() }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  }

  async abort(): Promise<boolean> {
    if (!this.child) return false
    try {
      await this.request('abort')
      this.state && (this.state.running = false)
      return true
    } catch {
      return false
    }
  }

  async setModel(provider: string, modelId: string): Promise<PiStartResult> {
    if (!this.child || !this.state) return { ok: false, error: 'Pi 尚未启动' }
    try {
      const response = await this.request('set_model', { provider, modelId })
      const model = normalizeModel(response)
      if (model) this.state.currentModel = model
      return { ok: true, state: this.view() }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.state = null
    this.stderrTail = ''
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Pi 已停止'))
    }
    this.pending.clear()
    if (!child) return
    try {
      if (!child.stdin.destroyed) child.stdin.end()
    } catch {
      // ignore
    }
    await killProcessTree(child.pid)
  }

  dispose(): void {
    this.disposed = true
    void this.stop()
  }

  private spawn(command: string, cwd: string, extraEnv: NodeJS.ProcessEnv): void {
    const child = spawnAgentProcess({
      command,
      args: ['--mode', 'rpc', '--no-session', '--no-approve'],
      cwd,
      env: extraEnv
    })
    this.child = child
    this.stderrTail = ''
    const decoder = new JsonLineDecoder()
    child.stdout.on('data', (chunk: Buffer) => {
      let lines: string[] = []
      try {
        lines = decoder.push(chunk)
      } catch (error) {
        this.emit({ type: 'error', message: errorText(error) })
        return
      }
      for (const line of lines) this.onLine(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000)
      this.options.diagnostics?.('pi.stderr', { text: this.stderrTail.slice(-400) })
    })
    child.once('error', (error) => {
      this.emit({ type: 'error', message: errorText(error) })
    })
    child.once('exit', (code, signal) => {
      const wasCurrent = this.child === child
      if (wasCurrent) this.child = null
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`Pi 已退出（${code ?? signal ?? 'unknown'}）`))
      }
      this.pending.clear()
      if (wasCurrent && !this.disposed) {
        const tail = this.stderrTail.trim()
        this.emit({
          type: 'error',
          message: tail
            ? `Pi 已退出：${tail.slice(-MAX_ERROR_CHARS)}`
            : `Pi 已退出（${code ?? signal ?? 'unknown'}）`
        })
      }
    })
  }

  private onLine(line: string): void {
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id)
      if (!pending) return
      this.pending.delete(record.id)
      clearTimeout(pending.timer)
      if (record.success === false) pending.reject(new Error(String(record.error ?? 'Pi 命令失败')))
      else pending.resolve(record.data ?? null)
      return
    }
    this.onEvent(record)
  }

  private onEvent(record: Record<string, unknown>): void {
    const type = record.type
    if (type === 'message_update') {
      const update = record.assistantMessageEvent as Record<string, unknown> | undefined
      if (update?.type === 'text_delta' && typeof update.delta === 'string') {
        this.emit({ type: 'assistant_delta', delta: update.delta })
      }
      return
    }
    if (type === 'message_end') {
      const message = record.message as Record<string, unknown> | undefined
      if (message?.role === 'assistant') {
        const text = messageText(message)
        if (text) this.emit({ type: 'assistant_end', text })
      }
      return
    }
    if (type === 'tool_execution_start') {
      this.emit({
        type: 'tool_start',
        toolCallId: String(record.toolCallId ?? ''),
        toolName: String(record.toolName ?? 'tool'),
        args: record.args
      })
      return
    }
    if (type === 'tool_execution_end') {
      this.emit({
        type: 'tool_end',
        toolCallId: String(record.toolCallId ?? ''),
        toolName: String(record.toolName ?? 'tool'),
        isError: record.isError === true
      })
      return
    }
    if (type === 'agent_settled') {
      if (this.state) this.state.running = false
      this.emit({ type: 'settled', aborted: record.aborted === true })
    }
  }

  private request(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new Error('Pi 尚未启动'))
    const id = `pi-${++this.seq}`
    const message = { id, type, ...payload }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi 命令超时：${type}`))
      }, REQUEST_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8')
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private async getAvailableModels(): Promise<PiModelView[]> {
    const response = await this.request('get_available_models')
    const raw = (response as { models?: unknown })?.models
    if (!Array.isArray(raw)) return []
    return raw.map(normalizeModel).filter((item): item is PiModelView => item !== null)
  }

  private async readCurrentModel(): Promise<PiModelView | null> {
    try {
      const response = await this.request('get_state')
      return normalizeModel((response as { model?: unknown })?.model)
    } catch {
      return null
    }
  }

  private view(): PiStateView {
    const state = this.state
    return {
      projectPath: state?.projectPath ?? '',
      models: state?.models ?? [],
      currentModel: state?.currentModel ?? null,
      running: state?.running === true
    }
  }

  private emit(event: PiEvent): void {
    this.options.emit(event)
  }
}

export function normalizeRouter(input: PiRouterView): PiRouterView {
  return {
    mode: input.mode === 'magpie' ? 'magpie' : 'pi',
    baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '',
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : '',
    modelId: typeof input.modelId === 'string' ? input.modelId.trim() : ''
  }
}

export async function listMagpieModels(baseUrl: string, apiKey: string): Promise<PiModelView[]> {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) throw new Error('Magpie 地址必须是 http(s) URL')
  const endpoint = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
  const url = new URL(endpoint)
  const get = url.protocol === 'https:' ? httpsGet : httpGet
  return new Promise((resolve, reject) => {
    const req = get(
      url,
      {
        headers: {
          accept: 'application/json',
          ...(apiKey.trim() ? { authorization: `Bearer ${apiKey.trim()}` } : {})
        },
        timeout: 6000
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
          if (text.length > 2_000_000) req.destroy(new Error('Magpie 模型列表过大'))
        })
        res.on('end', () => {
          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
            reject(new Error(`Magpie HTTP ${res.statusCode ?? 0}`))
            return
          }
          try {
            const parsed = JSON.parse(text) as { data?: unknown }
            const data = Array.isArray(parsed.data) ? parsed.data : []
            resolve(
              data
                .map((item) => {
                  if (!item || typeof item !== 'object') return null
                  const raw = item as Record<string, unknown>
                  const id = typeof raw.id === 'string' ? raw.id : ''
                  if (!id) return null
                  return {
                    provider: 'magpie',
                    id,
                    name:
                      typeof raw.display_name === 'string'
                        ? raw.display_name
                        : typeof raw.name === 'string'
                          ? raw.name
                          : id
                  } satisfies PiModelView
                })
                .filter((item): item is PiModelView => item !== null)
            )
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('Magpie 连接超时')))
    req.on('error', reject)
  })
}

function normalizeModel(value: unknown): PiModelView | null {
  if (!value || typeof value !== 'object') return null
  const model = value as Record<string, unknown>
  const provider = typeof model.provider === 'string' ? model.provider : ''
  const id = typeof model.id === 'string' ? model.id : ''
  if (!provider || !id) return null
  return {
    provider,
    id,
    name: typeof model.name === 'string' && model.name ? model.name : id
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, MAX_ERROR_CHARS)
  return String(error).slice(0, MAX_ERROR_CHARS)
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const raw = block as Record<string, unknown>
      return raw.type === 'text' && typeof raw.text === 'string' ? raw.text : ''
    })
    .join('')
}

function resolvePiCommand(): string | null {
  const names = process.platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi'] : ['pi']
  const dirs = (process.env.PATH ?? process.env.Path ?? '')
    .split(delimiter)
    .filter(Boolean)
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    const localAppData = process.env.LOCALAPPDATA
    if (appData) dirs.push(join(appData, 'npm'))
    if (localAppData) dirs.push(join(localAppData, 'npm'))
    if (process.env.PNPM_HOME) dirs.push(process.env.PNPM_HOME)
  } else {
    dirs.push(join(homedir(), '.local', 'bin'), '/usr/local/bin', '/usr/bin')
  }
  for (const dir of dirs) {
    for (const name of names) {
      const path = join(dir, name)
      try {
        accessSync(path, fsConstants.F_OK)
        if (extname(path) === '.cmd' || extname(path) === '.exe' || process.platform !== 'win32') {
          return path
        }
      } catch {
        // next
      }
    }
  }
  return null
}
