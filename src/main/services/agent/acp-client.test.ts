import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ACP_CLIENT_CAPABILITIES,
  AcpClient,
  JsonLineDecoder,
  resolvePermissionOutcome,
  type AcpPermissionOutcome
} from './acp-client'
import { buildCmdInvocation } from './agent-process'
import type { AgentPermissionOptionView } from '../../../shared/ipc'

const MOCK_AGENT = fileURLToPath(new URL('../../../../scripts/acp-mock-agent.mjs', import.meta.url))

function options(items: Array<[string, string, string]>): AgentPermissionOptionView[] {
  return items.map(([optionId, name, kind]) => ({ optionId, name, kind }))
}

describe('JsonLineDecoder', () => {
  it('跨 UTF-8 多字节边界的 chunk 不会产生替换字符', () => {
    const decoder = new JsonLineDecoder()
    const line = JSON.stringify({ text: '你好，世界！ACP 流式消息。' })
    const bytes = Buffer.from(`${line}\n`, 'utf8')
    const multibyteAt = bytes.findIndex((byte) => byte >= 0xe0)
    expect(multibyteAt).toBeGreaterThan(0)
    expect(decoder.push(bytes.subarray(0, multibyteAt + 1))).toEqual([])
    const lines = decoder.push(bytes.subarray(multibyteAt + 1))
    expect(lines).toEqual([line])
    expect(lines[0]).not.toContain('\uFFFD')
  })

  it('接受 CRLF、空行与同一 chunk 的多条消息', () => {
    const decoder = new JsonLineDecoder()
    expect(decoder.push('{"a":1}\r\n\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('超长行立即报协议错误，不无限占内存', () => {
    const decoder = new JsonLineDecoder({ maxLineBytes: 8 })
    expect(() => decoder.push(Buffer.from('123456789'))).toThrow(/上限/)
    const withNewline = new JsonLineDecoder({ maxLineBytes: 8 })
    expect(() => withNewline.push(Buffer.from('123456789\n'))).toThrow(/上限/)
  })

  it('flush 交出最后一条不带换行的消息', () => {
    const decoder = new JsonLineDecoder()
    expect(decoder.push('{"tail":true}')).toEqual([])
    expect(decoder.flush()).toEqual(['{"tail":true}'])
  })

  it('只声明读取能力，不声明 terminal/writeTextFile', () => {
    expect(ACP_CLIENT_CAPABILITIES).toEqual({ fs: { readTextFile: true } })
  })

  it('Windows cmd 包装器给整条命令再加一层引号', () => {
    expect(buildCmdInvocation('C:\\Program Files\\agent.cmd', ['--version'])).toBe(
      '""C:\\Program Files\\agent.cmd" "--version""'
    )
  })
})

describe('权限映射', () => {
  it('按 kind 选择，不信任 name 文案', () => {
    const list = options([
      ['reject-1', '允许一次', 'reject_once'],
      ['allow-1', '拒绝', 'allow_once']
    ])
    const outcome = resolvePermissionOutcome(list, 'allow_once')
    expect(outcome.outcome).toEqual({ outcome: 'selected', optionId: 'allow-1' })
  })

  it('本会话允许优先 allow_always，拒绝优先 reject_always', () => {
    const list = options([
      ['allow-once', '允许一次', 'allow_once'],
      ['allow-always', '本会话允许', 'allow_always'],
      ['reject-once', '拒绝', 'reject_once'],
      ['reject-always', '本会话拒绝', 'reject_always']
    ])
    expect(resolvePermissionOutcome(list, 'allow_session').outcome).toEqual({
      outcome: 'selected',
      optionId: 'allow-always'
    })
    expect(resolvePermissionOutcome(list, 'reject_session').outcome).toEqual({
      outcome: 'selected',
      optionId: 'reject-always'
    })
  })

  it('未知 kind / 只有拒绝项时请求允许一律取消，不当批准', () => {
    const unknownOnly = options([['weird', '同意', 'unknown_kind']])
    expect(resolvePermissionOutcome(unknownOnly, 'allow_once').outcome).toEqual({
      outcome: 'cancelled'
    })
    const rejectOnly = options([['reject', '拒绝', 'reject_once']])
    expect(resolvePermissionOutcome(rejectOnly, 'allow_once').outcome).toEqual({
      outcome: 'cancelled'
    })
    expect(resolvePermissionOutcome([], 'allow_session').outcome).toEqual({ outcome: 'cancelled' })
  })
})

describe('AcpClient ↔ mock agent', () => {
  it('完成握手、流式更新与只读权限路径', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yangge-acp-'))
    await writeFile(join(dir, 'sample.txt'), '只读内容\n', 'utf8')
    const updates: Array<Record<string, unknown>> = []
    const client = new AcpClient({
      command: process.execPath,
      args: [MOCK_AGENT],
      cwd: dir,
      roots: [dir],
      permissionHandler: (): AcpPermissionOutcome => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' }
      })
    })
    client.on('update', ({ update }: { update: Record<string, unknown> }) => updates.push(update))
    try {
      await client.connect()
      const init = await client.initialize()
      expect(init['protocolVersion']).toBe(1)
      const session = await client.newSession(dir)
      const result = await client.prompt(session.sessionId, '请演示 ACP 流程')
      expect(result.stopReason).toBe('end_turn')

      const text = updates
        .filter((update) => update['sessionUpdate'] === 'agent_message_chunk')
        .map((update) => (update['content'] as { text?: string } | undefined)?.text ?? '')
        .join('')
      expect(text).toContain('你好，世界！')
      expect(text).not.toContain('\uFFFD')

      const toolUpdates = updates.filter((update) => update['sessionUpdate'] === 'tool_call_update')
      expect(toolUpdates[toolUpdates.length - 1]?.['status']).toBe('completed')
      expect(client.pendingCount).toBe(0)
    } finally {
      await client.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('关闭时拒绝挂起的 prompt 并清空 pending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yangge-acp-close-'))
    const client = new AcpClient({ command: process.execPath, args: [MOCK_AGENT], cwd: dir, roots: [dir] })
    try {
      await client.connect()
      await client.initialize()
      const session = await client.newSession(dir)
      const pending = client.prompt(session.sessionId, '[hang]', { timeoutMs: 0 })
      const guarded = pending.then(
        () => ({ resolved: true as const, code: 0 }),
        (error: { code?: number }) => ({ resolved: false as const, code: error.code ?? 0 })
      )
      const exit = await client.close({ graceMs: 3000 })
      const outcome = await guarded
      expect(outcome.resolved).toBe(false)
      expect([-32800, -32000]).toContain(outcome.code)
      expect(client.pendingCount).toBe(0)
      expect(exit?.code).toBe(0)
    } finally {
      if (client.child && client.child.exitCode === null) await client.close({ graceMs: 1000 })
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('terminate 立即拒绝所有挂起请求', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yangge-acp-term-'))
    const client = new AcpClient({ command: process.execPath, args: [MOCK_AGENT], cwd: dir, roots: [dir] })
    try {
      await client.connect()
      await client.initialize()
      const session = await client.newSession(dir)
      const pending = client.prompt(session.sessionId, '[hang]', { timeoutMs: 0 })
      client.terminate()
      await expect(pending).rejects.toMatchObject({ code: -32800 })
      expect(client.pendingCount).toBe(0)
    } finally {
      if (client.child && client.child.exitCode === null) {
        await client.close({ graceMs: 3000 })
      }
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
