import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KNOWN_AGENTS,
  defaultSearchRoots,
  discoverAgents,
  executableCandidates,
  findExecutable
} from './agent-discovery'
import { refreshWindowsPathEnv } from './agent-env'

const tempDirs: string[] = []
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-discovery-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('ACP Agent 发现目录', () => {
  it('识别 Pi 的 ACP 启动器', () => {
    expect(KNOWN_AGENTS).toContainEqual({ name: 'Pi ACP', commands: ['pi-acp'], args: [] })
  })

  it('识别 omp 与 DeepSeek Harness 的原生 ACP 入口', () => {
    expect(KNOWN_AGENTS).toContainEqual({ name: 'omp', commands: ['omp'], args: ['acp'] })
    expect(KNOWN_AGENTS).toContainEqual({ name: 'DeepSeek Harness', commands: ['dsh'], args: ['acp'] })
  })

  it('识别 Claude Code 的常见 ACP 适配器别名', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.name === 'Claude Agent')?.commands).toContain(
      'claude-code-acp'
    )
  })

  it('Windows 搜索根覆盖 DeepSeek Harness 的 CLI 目录', () => {
    const roots = defaultSearchRoots({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', PATH: '' },
      homeDir: 'C:\\Users\\me'
    })
    expect(
      roots.some((root) =>
        root.dir.toLowerCase().includes('deepseek harness') && root.dir.toLowerCase().includes('runtime')
      )
    ).toBe(true)
  })

  it('Programs 应用自带的 CLI 目录无需 PATH 也能发现', () => {
    const localAppData = makeDir()
    const cliDir = join(localAppData, 'Programs', 'Harness App', 'resources', 'runtime', 'cli', 'bin')
    mkdirSync(cliDir, { recursive: true })
    writeFileSync(join(cliDir, 'dsh.cmd'), '@echo off\r\n')
    const roots = defaultSearchRoots({
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData, PATH: '' },
      homeDir: join(localAppData, 'home')
    })
    expect(findExecutable('dsh', roots, 'win32')).toEqual({
      path: join(cliDir, 'dsh.cmd'),
      source: 'windows-dir'
    })
  })

  it('应用私有 bin 与用户级 CLI 目录进入搜索根', () => {
    const localAppData = makeDir()
    const home = makeDir()
    const ompDir = join(localAppData, 'Tern', 'omp', 'bin')
    const opencodeDir = join(home, '.opencode', 'bin')
    mkdirSync(ompDir, { recursive: true })
    mkdirSync(opencodeDir, { recursive: true })
    writeFileSync(join(ompDir, 'omp.exe'), '')
    writeFileSync(join(opencodeDir, 'opencode.exe'), '')
    const roots = defaultSearchRoots({
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData, PATH: '' },
      homeDir: home
    })
    expect(findExecutable('omp', roots, 'win32')?.path).toBe(join(ompDir, 'omp.exe'))
    expect(findExecutable('opencode', roots, 'win32')?.path).toBe(join(opencodeDir, 'opencode.exe'))
  })

  it('扫描前从注册表刷新的 PATH 会进入发现根', () => {
    const env = refreshWindowsPathEnv(
      { Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' },
      {
        platform: 'win32',
        run: () => 'C:\\Users\\me\\AppData\\Local\\Tern\\omp\\bin'
      }
    )
    const roots = defaultSearchRoots({
      platform: 'win32',
      env,
      homeDir: 'C:\\Users\\me'
    })
    expect(
      roots.some((root) => root.dir.includes('Tern') && root.dir.toLowerCase().includes('omp'))
    ).toBe(true)
  })

  it('把基础 CLI 与可连接的 ACP Agent 分开报告', async () => {
    const result = await discoverAgents({
      knownAgents: [],
      knownClients: [{
        id: 'plain',
        name: 'Plain CLI',
        commands: [process.execPath],
        adapterCommands: ['definitely-missing-acp-adapter'],
        adapterCommand: 'plain-acp'
      }],
      probeTimeoutMs: 5_000
    })

    expect(result.agents).toEqual([])
    expect(result.clients).toContainEqual({
      id: 'plain',
      name: 'Plain CLI',
      command: process.execPath,
      version: process.version,
      source: 'manual',
      adapterCommand: 'plain-acp',
      adapterReady: false
    })
  })

  it('Windows 候选顺序优先真实可执行入口，而不是无扩展名 POSIX 垫片', () => {
    expect(executableCandidates('opencode', 'win32')).toEqual([
      'opencode.exe',
      'opencode.cmd',
      'opencode.bat',
      'opencode'
    ])
    expect(executableCandidates('opencode.cmd', 'win32')).toEqual(['opencode.cmd'])
    expect(executableCandidates('pi-acp.exe', 'win32')).toEqual(['pi-acp.exe'])
    expect(executableCandidates('opencode', 'linux')).toEqual(['opencode'])
  })

  it('Windows 下跳过 PATH 中同名的无扩展名垫片（npm sh 脚本无法 spawn）', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'opencode'), '#!/bin/sh\nexec node "$0" "$@"\n')
    writeFileSync(join(dir, 'opencode.cmd'), '@echo off\r\n')
    expect(findExecutable('opencode', [{ dir, source: 'path' }], 'win32')).toEqual({
      path: join(dir, 'opencode.cmd'),
      source: 'path'
    })
  })

  it('只有无扩展名垫片时不把它当成可执行入口', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'opencode'), '#!/bin/sh\n')
    // 依然返回垫片路径（兜底候选），但排序保证存在 .cmd/.exe 时永远优先选择它们。
    expect(findExecutable('opencode', [{ dir, source: 'path' }], 'win32')).toEqual({
      path: join(dir, 'opencode'),
      source: 'path'
    })
  })
})
