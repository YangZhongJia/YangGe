import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'

// 本机 Agent 子进程统一出口。
// 约束：windowsHide、禁止 shell:true；Windows 的 .cmd/.bat 显式走 cmd.exe /d /s /c。

export interface AgentSpawnSpec {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}

export type AgentChildProcess = ChildProcessWithoutNullStreams

const VERSION_MAX_CHARS = 200
const VERSION_MAX_BYTES = 8 * 1024

function isWindowsBatch(command: string): boolean {
  const ext = extname(command).toLowerCase()
  return ext === '.cmd' || ext === '.bat'
}

/** cmd.exe 参数引号：拒绝换行/NUL，双引号内转义 `"`。 */
function quoteCmdToken(token: string): string {
  if (/[\r\n\0]/.test(token)) throw new Error('Agent 启动参数不能包含换行或 NUL')
  return `"${token.replace(/"/g, '\\"')}"`
}

export function buildCmdInvocation(command: string, args: string[]): string {
  return [quoteCmdToken(command), ...args.map(quoteCmdToken)].join(' ')
}

export function spawnAgentProcess(spec: AgentSpawnSpec): ChildProcessWithoutNullStreams {
  const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe']
  const base = {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    windowsHide: true,
    // 绝不使用 shell:true：参数可能来自用户/Agent，拼字符串会变成命令注入。
    shell: false,
    stdio
  }
  if (process.platform === 'win32' && isWindowsBatch(spec.command)) {
    const comspec = process.env['ComSpec'] || 'cmd.exe'
    // Node 文档要求 .cmd/.bat 必须经 shell；这里固定 cmd.exe，并把整条命令作为一个
    // 已加引号的参数传入，避免 shell:true 的隐式拼接。
    return spawn(
      comspec,
      ['/d', '/s', '/c', buildCmdInvocation(spec.command, spec.args)],
      { ...base, windowsVerbatimArguments: true }
    )
  }
  return spawn(spec.command, spec.args, base)
}

export async function killProcessTree(pid: number | undefined, graceMs = 1500): Promise<void> {
  if (!pid) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false
      })
      const timer = setTimeout(resolvePromise, graceMs)
      timer.unref?.()
      const done = (): void => {
        clearTimeout(timer)
        resolvePromise()
      }
      killer.once('exit', done)
      killer.once('error', done)
    })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已退出
  }
}

function cleanVersionLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, VERSION_MAX_CHARS)
}

export interface VersionProbe {
  ok: boolean
  version: string
  error: string
}

/**
 * 带超时的 `--version` 探测；stdout/stderr 都接受（不同 CLI 输出位置不一致）。
 * 超时/崩溃时清理整棵进程树，避免 npx/cmd 包装器留下孙进程。
 */
export function probeVersion(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<VersionProbe> {
  const timeoutMs = options.timeoutMs ?? 3500
  return new Promise<VersionProbe>((resolvePromise) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnAgentProcess({
        command,
        args,
        cwd: options.cwd && isAbsolute(options.cwd) ? options.cwd : process.cwd()
      })
    } catch (error) {
      resolvePromise({ ok: false, version: '', error: errorMessage(error) })
      return
    }

    let output = ''
    let bytes = 0
    let settled = false
    const finish = (result: VersionProbe): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }
    const timer = setTimeout(() => {
      void killProcessTree(child.pid).then(() =>
        finish({ ok: false, version: '', error: `--version 超时（${timeoutMs}ms）` })
      )
    }, timeoutMs)
    timer.unref?.()

    const collect = (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > VERSION_MAX_BYTES) {
        void killProcessTree(child.pid).then(() =>
          finish({ ok: false, version: '', error: '--version 输出过长' })
        )
        return
      }
      output += chunk.toString('utf8')
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', (error) => finish({ ok: false, version: '', error: errorMessage(error) }))
    child.once('exit', (code, signal) => {
      const lines = output.split(/\r?\n/).map(cleanVersionLine).filter(Boolean)
      const version = lines[0] ?? ''
      if (code === 0 || version) finish({ ok: true, version, error: '' })
      else finish({
        ok: false,
        version: '',
        error: `--version 退出码 ${code ?? 'null'}${signal ? `（${signal}）` : ''}`
      })
    })
  })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300)
  return String(error).slice(0, 300)
}

/** 可执行文件校验：绝对路径、文件存在、扩展名在白名单内（Windows）。 */
export function validateExecutable(
  input: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const path = resolve(input)
  if (!isAbsolute(input)) return null
  try {
    if (!statSync(path).isFile()) return null
    accessSync(path, fsConstants.F_OK)
  } catch {
    return null
  }
  if (platform === 'win32') {
    const ext = extname(path).toLowerCase()
    if (ext !== '.exe' && ext !== '.cmd' && ext !== '.bat') return null
  }
  return path
}
