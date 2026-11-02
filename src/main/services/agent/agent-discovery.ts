import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, extname, isAbsolute, join, resolve } from 'node:path'
import type { AgentScanFailure, AgentSource } from '../../../shared/ipc'
import { probeVersion, validateExecutable } from './agent-process'

// 本机 ACP CLI 发现：PATH + Windows 常见安装目录 + 用户手动路径。
// 只探测已经存在的可执行文件；不做在线 registry / npx 拉取（纯内网可用）。

export interface KnownAgent {
  name: string
  commands: string[]
  args: string[]
}

/** 官方 Registry 给出的常见启动形态；找不到时用户可手动指定。 */
export const KNOWN_AGENTS: readonly KnownAgent[] = [
  { name: 'Codex ACP', commands: ['codex-acp'], args: [] },
  { name: 'Claude Agent', commands: ['claude-acp', 'claude-agent-acp'], args: [] },
  { name: 'OpenCode', commands: ['opencode'], args: ['acp'] },
  { name: 'Gemini CLI', commands: ['gemini'], args: ['--acp'] },
  { name: 'GitHub Copilot', commands: ['copilot'], args: ['--acp'] }
]

export interface SearchRoot {
  dir: string
  source: AgentSource
}

export interface DiscoveryOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
  probeTimeoutMs?: number
  knownAgents?: readonly KnownAgent[]
}

export interface DiscoveredAgent {
  name: string
  command: string
  args: string[]
  version: string
  source: AgentSource
  probeError: string
}

const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat']

function addRoot(roots: SearchRoot[], dir: string | undefined, source: AgentSource): void {
  if (!dir) return
  const value = resolve(dir)
  if (!roots.some((root) => root.dir.toLowerCase() === value.toLowerCase())) {
    roots.push({ dir: value, source })
  }
}

function readSubdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .slice(0, 200)
      .map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

/** PATH + Windows 常见 Node/包管理器安装目录。 */
export function defaultSearchRoots(options: DiscoveryOptions = {}): SearchRoot[] {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const roots: SearchRoot[] = []

  const pathValue = env['PATH'] ?? env['Path'] ?? ''
  for (const entry of pathValue.split(platform === 'win32' ? ';' : delimiter)) {
    if (entry) addRoot(roots, entry, 'path')
  }
  addRoot(roots, env['PNPM_HOME'], 'path')
  addRoot(roots, env['VOLTA_HOME'] ? join(env['VOLTA_HOME'], 'bin') : undefined, 'path')

  if (platform !== 'win32') {
    addRoot(roots, join(home, '.local', 'bin'), 'path')
    addRoot(roots, join(home, '.npm-global', 'bin'), 'path')
    return roots
  }

  const appData = env['APPDATA']
  const localAppData = env['LOCALAPPDATA']
  const userProfile = env['USERPROFILE'] ?? home
  const programData = env['ProgramData']

  addRoot(roots, appData ? join(appData, 'npm') : undefined, 'windows-dir')
  addRoot(roots, localAppData ? join(localAppData, 'npm') : undefined, 'windows-dir')
  addRoot(roots, localAppData ? join(localAppData, 'pnpm') : undefined, 'windows-dir')
  addRoot(roots, localAppData ? join(localAppData, 'Yarn', 'bin') : undefined, 'windows-dir')
  addRoot(roots, localAppData ? join(localAppData, 'Volta', 'bin') : undefined, 'windows-dir')
  addRoot(roots, localAppData ? join(localAppData, 'mise', 'shims') : undefined, 'windows-dir')
  addRoot(roots, localAppData ? join(localAppData, 'Microsoft', 'WinGet', 'Links') : undefined, 'windows-dir')
  addRoot(roots, localAppData ? join(localAppData, 'Programs', 'nodejs') : undefined, 'windows-dir')
  addRoot(roots, env['NVM_HOME'], 'windows-dir')
  addRoot(roots, env['NVM_SYMLINK'], 'windows-dir')
  addRoot(roots, env['MISE_DATA_DIR'] ? join(env['MISE_DATA_DIR'], 'shims') : undefined, 'windows-dir')
  addRoot(roots, env['FNM_DIR'] ? join(env['FNM_DIR'], 'aliases', 'default', 'bin') : undefined, 'windows-dir')
  addRoot(roots, join(userProfile, '.local', 'bin'), 'windows-dir')
  addRoot(roots, join(userProfile, 'scoop', 'shims'), 'windows-dir')
  addRoot(roots, join(userProfile, 'AppData', 'Roaming', 'npm'), 'windows-dir')
  addRoot(roots, programData ? join(programData, 'chocolatey', 'bin') : undefined, 'windows-dir')

  // %LOCALAPPDATA%\Programs\<App>：安装器常见布局，只看一层，避免递归扫盘。
  if (localAppData) {
    for (const dir of readSubdirectories(join(localAppData, 'Programs'))) {
      addRoot(roots, dir, 'windows-dir')
    }
  }
  return roots
}

export function executableCandidates(command: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [command]
  if (WINDOWS_EXECUTABLE_EXTENSIONS.includes(extname(command).toLowerCase())) return [command]
  return [command, ...WINDOWS_EXECUTABLE_EXTENSIONS.map((ext) => `${command}${ext}`)]
}

export function findExecutable(
  command: string,
  roots: SearchRoot[],
  platform: NodeJS.Platform = process.platform
): { path: string; source: AgentSource } | null {
  const names = executableCandidates(command, platform)
  for (const root of roots) {
    for (const name of names) {
      const candidate = join(root.dir, name)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, fsConstants.F_OK)
        return { path: candidate, source: root.source }
      } catch {
        // 不存在/不可读，继续
      }
    }
  }
  return null
}

function agentArgsFor(commandPath: string, knownAgents: readonly KnownAgent[]): { name: string; args: string[] } {
  const stem = basename(commandPath).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
  for (const spec of knownAgents) {
    if (spec.commands.some((command) => command.toLowerCase() === stem)) {
      return { name: spec.name, args: [...spec.args] }
    }
  }
  return { name: stem || basename(commandPath), args: [] }
}

export interface DiscoveryResult {
  agents: DiscoveredAgent[]
  failures: AgentScanFailure[]
}

export async function discoverAgents(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const platform = options.platform ?? process.platform
  const knownAgents = options.knownAgents ?? KNOWN_AGENTS
  const roots = defaultSearchRoots(options)
  const seen = new Set<string>()
  const found: Array<{ path: string; source: AgentSource; name: string; args: string[] }> = []

  for (const spec of knownAgents) {
    for (const command of spec.commands) {
      const hit = findExecutable(command, roots, platform)
      if (!hit) continue
      const key = resolve(hit.path).toLowerCase()
      if (seen.has(key)) break
      seen.add(key)
      found.push({ path: hit.path, source: hit.source, name: spec.name, args: [...spec.args] })
      break
    }
  }

  const probes = await Promise.all(
    found.map(async (item) => {
      const probe = await probeVersion(item.path, ['--version'], {
        timeoutMs: options.probeTimeoutMs
      })
      return { item, probe }
    })
  )

  const agents: DiscoveredAgent[] = []
  const failures: AgentScanFailure[] = []
  for (const { item, probe } of probes) {
    agents.push({
      name: item.name,
      command: item.path,
      args: item.args,
      version: probe.version,
      source: item.source,
      probeError: probe.error
    })
    if (!probe.ok) failures.push({ command: item.path, error: probe.error })
  }
  return { agents, failures }
}

export interface ManualAgentResult {
  ok: boolean
  agent?: DiscoveredAgent
  error: string
}

/** 手动指定路径：只接受绝对路径、白名单扩展名，并做一次版本探测。 */
export async function inspectManualAgent(
  input: string,
  options: { platform?: NodeJS.Platform; knownAgents?: readonly KnownAgent[]; probeTimeoutMs?: number } = {}
): Promise<ManualAgentResult> {
  const platform = options.platform ?? process.platform
  if (typeof input !== 'string' || input.length === 0 || !isAbsolute(input)) {
    return { ok: false, error: '必须提供可执行文件的绝对路径' }
  }
  const path = validateExecutable(input, platform)
  if (!path) {
    return { ok: false, error: '文件不存在，或不是受支持的可执行文件（.exe/.cmd/.bat）' }
  }
  const spec = agentArgsFor(path, options.knownAgents ?? KNOWN_AGENTS)
  const probe = await probeVersion(path, ['--version'], { timeoutMs: options.probeTimeoutMs })
  return {
    ok: true,
    error: '',
    agent: {
      name: spec.name,
      command: path,
      args: spec.args,
      version: probe.version,
      source: 'manual',
      probeError: probe.error
    }
  }
}
