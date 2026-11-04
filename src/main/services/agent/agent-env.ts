import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Windows 桌面进程的环境变量是启动瞬间的快照：用户在阳鸽启动之后才安装/升级
// Agent CLI 时，注册表里的 PATH 已经变了，但本进程看不到，于是「扫描」一直找不到
// 新装的 CLI，只有重启应用才恢复。扫描前重新读一次用户/系统 PATH 并合并进本进程，
// 让「安装后重新扫描」真的生效。
//
// 读取方式用 `reg export` 落盘再按 UTF-16LE 解析，而不是 `reg query` 的控制台文本：
// reg query 使用控制台代码页（中文系统为 GBK），Node 按 UTF-8 解码会把中文用户名
// 目录变成乱码，导致注册表里的 PATH 完全用不上。

export type RegistryRunner = (key: string) => string | null

export interface RefreshPathOptions {
  platform?: NodeJS.Platform
  /** 测试注入；生产环境使用 reg.exe 读取注册表。 */
  run?: RegistryRunner
}

const USER_ENV_KEY = 'HKCU\\Environment'
const MACHINE_ENV_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const REGISTRY_TIMEOUT_MS = 5_000

function pathKeyOf(env: NodeJS.ProcessEnv): string | null {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') return key
  }
  return null
}

function decodeRegistryHex(payload: string): string {
  const bytes: number[] = []
  for (const part of payload.split(',')) {
    const byte = Number.parseInt(part.trim(), 16)
    if (Number.isNaN(byte)) continue
    bytes.push(byte)
  }
  return Buffer.from(bytes).toString('utf16le').replace(/\u0000+$/, '')
}

/**
 * 从 `reg export` 生成的 .reg 文本里取出 `Path` 值。
 * - REG_SZ：`"Path"="C:\\..."`，按 .reg 规则反转义；
 * - REG_EXPAND_SZ / 特殊字符：`"Path"=hex(2):25,00,...`（UTF-16LE 字节，长值带 `\` 续行）。
 */
export function parseRegistryExportPath(text: string): string | null {
  const lines = text.split(/\r?\n/)
  let raw: string | null = null
  let collecting: string | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (collecting !== null) {
      // 续行：行尾 `\` 表示还下一行；拼接后再判断。
      collecting += trimmed
      if (!collecting.endsWith('\\')) {
        raw = collecting
        break
      }
      collecting = collecting.slice(0, -1)
      continue
    }
    if (!/^"Path"=/i.test(trimmed)) continue
    if (trimmed.startsWith('"Path"=hex') && trimmed.endsWith('\\')) {
      collecting = trimmed.slice(0, -1)
      continue
    }
    raw = trimmed
    break
  }
  if (!raw) return null

  const hex = raw.match(/^"Path"=hex\([12]\):(.*)$/i)
  if (hex) return decodeRegistryHex(hex[1].replace(/\\/g, ''))
  const quoted = raw.match(/^"Path"="(.*)"$/i)
  // .reg 文本里 `\\` 是反斜杠、`\"` 是引号；顺序必须先处理引号再处理反斜杠。
  return quoted ? quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null
}

function readRegistryValue(key: string): string | null {
  const file = join(tmpdir(), `yangge-agent-path-${randomBytes(6).toString('hex')}.reg`)
  try {
    execFileSync('reg.exe', ['export', key, file, '/y'], {
      windowsHide: true,
      timeout: REGISTRY_TIMEOUT_MS,
      stdio: 'ignore'
    })
    return parseRegistryExportPath(readFileSync(file).toString('utf16le'))
  } catch {
    return null
  } finally {
    try {
      rmSync(file, { force: true })
    } catch {
      // 临时文件清理失败不影响扫描结果。
    }
  }
}

/** `%VAR%` 展开；找不到的变量保留原文，由调用方决定是否丢弃。 */
export function expandWindowsVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%;%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    const replacement = key ? env[key] : undefined
    return replacement ?? whole
  })
}

function normalizeEntry(raw: string): string {
  const trimmed = raw.trim().replace(/^"(.*)"$/, '$1').trim()
  if (trimmed.length <= 3) return trimmed
  return trimmed.replace(/[\\/]+$/, '')
}

/**
 * 合并 PATH 片段：去掉空项、未展开的 `%VAR%`、非绝对路径与重复项（不区分大小写）。
 * 保留先出现的顺序，让本进程原有 PATH 优先级高于后读到的注册表值。
 */
export function mergePathEntries(entries: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const entry of entries) {
    const normalized = normalizeEntry(expandWindowsVars(entry, env))
    // 只接受 `C:\...` / `C:/...` / `\\server\share`：相对项与未展开变量无法用于查找。
    if (!normalized || normalized.includes('%') || !/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(normalized)) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(normalized)
  }
  return merged
}

/**
 * 返回合并了注册表 PATH 的环境副本；非 Windows 或无法读取注册表时原样返回。
 * 不修改入参，便于测试与「先算后应用」。
 */
export function refreshWindowsPathEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: RefreshPathOptions = {}
): NodeJS.ProcessEnv {
  if ((options.platform ?? process.platform) !== 'win32') return env
  const run = options.run ?? readRegistryValue
  const key = pathKeyOf(env) ?? 'Path'
  const entries: string[] = []
  for (const value of [env[key] ?? '', run(USER_ENV_KEY), run(MACHINE_ENV_KEY)]) {
    if (!value) continue
    for (const part of value.split(';')) entries.push(part)
  }
  const merged = mergePathEntries(entries, env)
  if (merged.length === 0) return env
  const next: NodeJS.ProcessEnv = { ...env }
  for (const name of Object.keys(next)) {
    if (name !== key && name.toLowerCase() === 'path') delete next[name]
  }
  next[key] = merged.join(';')
  return next
}

/**
 * 把注册表 PATH 合并进当前进程（扫描前调用）。返回是否发生了变化。
 * 之后由本进程 spawn 的 Agent 子进程会直接继承刷新后的 PATH。
 */
export function applyRefreshedWindowsPath(options: RefreshPathOptions = {}): boolean {
  if ((options.platform ?? process.platform) !== 'win32') return false
  const refreshed = refreshWindowsPathEnv(process.env, options)
  if (refreshed === process.env) return false
  const key = pathKeyOf(process.env) ?? pathKeyOf(refreshed) ?? 'Path'
  const value = refreshed[key]
  if (!value || process.env[key] === value) return false
  process.env[key] = value
  return true
}
