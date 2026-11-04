import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, extname, isAbsolute, join, resolve } from 'node:path'
import type { AgentCliInfo, AgentScanFailure, AgentSource } from '../../../shared/ipc'
import { mapWithConcurrency, probeVersion, validateExecutable } from './agent-process'

// 本机 ACP CLI 发现：PATH + Windows 常见安装目录 + 用户手动路径。
// 只探测已经存在的可执行文件；不做在线 registry / npx 拉取（纯内网可用）。

export interface KnownAgent {
  name: string
  commands: string[]
  args: string[]
}

export interface KnownCli {
  id: string
  name: string
  commands: string[]
  adapterCommands: string[]
  adapterCommand: string
}

/** 官方 Registry 给出的常见启动形态；找不到时用户可手动指定。 */
export const KNOWN_AGENTS: readonly KnownAgent[] = [
  { name: 'Codex ACP', commands: ['codex-acp'], args: [] },
  { name: 'Claude Agent', commands: ['claude-acp', 'claude-agent-acp', 'claude-code-acp'], args: [] },
  { name: 'OpenCode', commands: ['opencode'], args: ['acp'] },
  { name: 'omp', commands: ['omp'], args: ['acp'] },
  { name: 'DeepSeek Harness', commands: ['dsh'], args: ['acp'] },
  { name: 'Pi ACP', commands: ['pi-acp'], args: [] },
  { name: 'Gemini CLI', commands: ['gemini'], args: ['--acp'] },
  { name: 'GitHub Copilot', commands: ['copilot'], args: ['--acp'] }
]

/** 常见基础 CLI；它们本身不是 ACP，只有适配器握手成功后才可连接。 */
export const KNOWN_CLIS: readonly KnownCli[] = [
  {
    id: 'codex',
    name: 'Codex CLI',
    commands: ['codex'],
    adapterCommands: ['codex-acp'],
    adapterCommand: 'codex-acp'
  },
  {
    id: 'claude',
    name: 'Claude Code',
    commands: ['claude'],
    adapterCommands: ['claude-acp', 'claude-agent-acp', 'claude-code-acp'],
    adapterCommand: 'claude-acp'
  },
  {
    id: 'pi',
    name: 'Pi',
    commands: ['pi'],
    adapterCommands: ['pi-acp'],
    adapterCommand: 'pi-acp'
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    commands: ['opencode'],
    adapterCommands: ['opencode'],
    adapterCommand: 'opencode acp'
  },
  {
    id: 'omp',
    name: 'omp',
    commands: ['omp'],
    adapterCommands: ['omp'],
    adapterCommand: 'omp acp'
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    commands: ['dsh'],
    adapterCommands: ['dsh'],
    adapterCommand: 'dsh acp'
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    commands: ['gemini'],
    adapterCommands: ['gemini'],
    adapterCommand: 'gemini --acp'
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    commands: ['copilot'],
    adapterCommands: ['copilot'],
    adapterCommand: 'copilot --acp'
  }
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
  knownClients?: readonly KnownCli[]
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

// 版本探测同样要冷启动一次 CLI：弱机 + 杀毒软件环境下 probeVersion 的 3.5s 默认值
// 会把可用 Agent 误标成「探测失败」。扫描放宽到 8s，并限制同时探测的数量。
const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 8_000
const VERSION_PROBE_CONCURRENCY = 3

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
  addRoot(roots, join(userProfile, '.bun', 'bin'), 'windows-dir')
  addRoot(roots, join(userProfile, '.deno', 'bin'), 'windows-dir')
  addRoot(roots, join(userProfile, '.cargo', 'bin'), 'windows-dir')
  addRoot(roots, join(userProfile, '.opencode', 'bin'), 'windows-dir')
  addRoot(roots, join(userProfile, 'scoop', 'shims'), 'windows-dir')
  addRoot(roots, join(userProfile, 'AppData', 'Roaming', 'npm'), 'windows-dir')
  addRoot(roots, programData ? join(programData, 'chocolatey', 'bin') : undefined, 'windows-dir')

  // 应用自带运行时（Tern / omp、OpenCode 等）不一定写进 PATH：
  // 也要看应用私有目录里的 bin。
  addRoot(roots, localAppData ? join(localAppData, 'Tern', 'omp', 'bin') : undefined, 'windows-dir')
  addRoot(
    roots,
    localAppData ? join(localAppData, 'Programs', 'Tern', 'omp', 'bin') : undefined,
    'windows-dir'
  )
  addRoot(roots, localAppData ? join(localAppData, 'opencode', 'bin') : undefined, 'windows-dir')

  // DeepSeek Harness：CLI 位于应用资源目录，`dsh acp` 提供 ACP 服务。
  addRoot(
    roots,
    localAppData
      ? join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin')
      : undefined,
    'windows-dir'
  )

  // %LOCALAPPDATA%\Programs\<App>：安装器常见布局。只展开两层：
  // 应用根、<App>\bin 与 <App>\resources\...[cli|runtime]\bin（harness 自带 CLI），
  // 避免递归扫盘。
  if (localAppData) {
    for (const dir of readSubdirectories(join(localAppData, 'Programs'))) {
      addRoot(roots, dir, 'windows-dir')
      addRoot(roots, join(dir, 'bin'), 'windows-dir')
      addRoot(roots, join(dir, 'resources', 'bin'), 'windows-dir')
      addRoot(roots, join(dir, 'resources', 'runtime', 'bin'), 'windows-dir')
      addRoot(roots, join(dir, 'resources', 'runtime', 'cli', 'bin'), 'windows-dir')
    }
  }
  return roots
}

export function executableCandidates(command: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [command]
  if (WINDOWS_EXECUTABLE_EXTENSIONS.includes(extname(command).toLowerCase())) return [command]
  // Windows 的 PATH 里同名条目可能同时存在 npm 的无扩展名 POSIX 垫片（sh 脚本）与
  // .cmd/.exe 启动器。必须优先真实可执行入口：无扩展名垫片无法被 spawn 启动（ENOENT）。
  return [...WINDOWS_EXECUTABLE_EXTENSIONS.map((ext) => `${command}${ext}`), command]
}

export function findExecutable(
  command: string,
  roots: SearchRoot[],
  platform: NodeJS.Platform = process.platform
): { path: string; source: AgentSource } | null {
  if (isAbsolute(command)) {
    try {
      if (!statSync(command).isFile()) return null
      accessSync(command, fsConstants.F_OK)
      return { path: command, source: 'manual' }
    } catch {
      return null
    }
  }
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
  clients: AgentCliInfo[]
}

export async function discoverAgents(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const platform = options.platform ?? process.platform
  const knownAgents = options.knownAgents ?? KNOWN_AGENTS
  const knownClients = options.knownClients ?? KNOWN_CLIS
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

  const clientHits: Array<{
    spec: KnownCli
    command: string
    source: AgentSource
    adapterReady: boolean
  }> = []
  for (const spec of knownClients) {
    let hit: { path: string; source: AgentSource } | null = null
    for (const command of spec.commands) {
      hit = findExecutable(command, roots, platform)
      if (hit) break
    }
    if (!hit) continue
    const adapterReady = spec.adapterCommands.some((command) =>
      Boolean(findExecutable(command, roots, platform))
    )
    clientHits.push({
      spec,
      command: hit.path,
      source: hit.source,
      adapterReady
    })
  }

  // 版本探测也要启动完整 CLI：限制并发，避免一次拉起全部候选把弱机拖到超时。
  const probes = await mapWithConcurrency(found, VERSION_PROBE_CONCURRENCY, async (item) => {
    const probe = await probeVersion(item.path, ['--version'], {
      timeoutMs: options.probeTimeoutMs ?? DEFAULT_VERSION_PROBE_TIMEOUT_MS
    })
    return { item, probe }
  })
  const clientProbes = await mapWithConcurrency(clientHits, VERSION_PROBE_CONCURRENCY, async (item) => {
    const probe = await probeVersion(item.command, ['--version'], {
      timeoutMs: options.probeTimeoutMs ?? DEFAULT_VERSION_PROBE_TIMEOUT_MS
    })
    return { item, probe }
  })

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
  const clients: AgentCliInfo[] = clientProbes.map(({ item, probe }) => ({
    id: item.spec.id,
    name: item.spec.name,
    command: item.command,
    version: probe.version,
    source: item.source,
    adapterCommand: item.spec.adapterCommand,
    adapterReady: item.adapterReady
  }))
  return { agents, failures, clients }
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
  const probe = await probeVersion(path, ['--version'], {
    timeoutMs: options.probeTimeoutMs ?? DEFAULT_VERSION_PROBE_TIMEOUT_MS
  })
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
