import { describe, expect, it } from 'vitest'
import { KNOWN_AGENTS, discoverAgents } from './agent-discovery'

describe('ACP Agent 发现目录', () => {
  it('识别 Pi 的 ACP 启动器', () => {
    expect(KNOWN_AGENTS).toContainEqual({ name: 'Pi ACP', commands: ['pi-acp'], args: [] })
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
})
