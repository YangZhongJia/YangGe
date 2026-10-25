import { describe, expect, it } from 'vitest'
import { AI_REPLY_PREFIX, buildLlmMessages, shouldAutoReply, stripAiPrefix } from './ai-replier'
import type { AiReplierConfig } from '../store/app-state'

const cfg = (over: Partial<AiReplierConfig> = {}): AiReplierConfig => ({
  enabled: true,
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKey: '',
  model: 'qwen2.5',
  persona: '',
  replyPrivate: true,
  replyGroup: true,
  ...over
})

describe('AI 分身触发门控', () => {
  it('默认配置齐全时单聊与群 @ 都触发', () => {
    expect(shouldAutoReply(cfg(), { text: '在吗', scope: 'private' })).toBe(true)
    expect(shouldAutoReply(cfg(), { text: '在吗', scope: 'group' })).toBe(true)
  })

  it('未开启 / 缺地址 / 缺模型名时不触发', () => {
    expect(shouldAutoReply(cfg({ enabled: false }), { text: 'hi', scope: 'private' })).toBe(false)
    expect(shouldAutoReply(cfg({ baseUrl: ' ' }), { text: 'hi', scope: 'private' })).toBe(false)
    expect(shouldAutoReply(cfg({ model: '' }), { text: 'hi', scope: 'private' })).toBe(false)
  })

  it('AI 前缀消息永不触发（防两个分身互相回复）', () => {
    expect(shouldAutoReply(cfg(), { text: AI_REPLY_PREFIX + '收到~', scope: 'private' })).toBe(false)
    expect(shouldAutoReply(cfg(), { text: '  [AI 代回] 收到', scope: 'group' })).toBe(false)
  })

  it('可分别关闭单聊/群聊通道', () => {
    expect(shouldAutoReply(cfg({ replyPrivate: false }), { text: 'hi', scope: 'private' })).toBe(false)
    expect(shouldAutoReply(cfg({ replyPrivate: false }), { text: 'hi', scope: 'group' })).toBe(true)
    expect(shouldAutoReply(cfg({ replyGroup: false }), { text: 'hi', scope: 'group' })).toBe(false)
  })
})

describe('AI 分身提示词组装', () => {
  it('系统提示包含人设与双方名字，历史按角色映射', () => {
    const msgs = buildLlmMessages('你是资深前端', '张三', '李四', [
      { sender: '李四', isMine: false, text: '评审几点开始？' },
      { sender: '张三', isMine: true, text: '下午两点' }
    ])
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('你是资深前端')
    expect(msgs[0].content).toContain('张三')
    expect(msgs[0].content).toContain('李四')
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
    expect(msgs[1].content).toBe('评审几点开始？')
  })

  it('无人设时使用默认助手提示', () => {
    const msgs = buildLlmMessages('', 'A', 'B', [])
    expect(msgs[0].content).toContain('办公助手')
  })
})

describe('AI 代回前缀剥离（防双前缀）', () => {
  it('剥掉开头单个或多个前缀', () => {
    expect(stripAiPrefix('[AI 代回] 收到')).toBe('收到')
    expect(stripAiPrefix('[AI 代回] [AI 代回] 收到')).toBe('收到')
    expect(stripAiPrefix('  [AI 代回]\n[AI 代回] 好')).toBe('好')
  })

  it('无前缀文本原样返回（仅去首尾空白）', () => {
    expect(stripAiPrefix(' 今天下午两点 ')).toBe('今天下午两点')
    expect(stripAiPrefix('[人工] 不是 AI 前缀')).toBe('[人工] 不是 AI 前缀')
  })

  it('历史里的前缀在组装提示词时被剥掉，避免模型模仿', () => {
    const msgs = buildLlmMessages('', 'A', 'B', [
      { sender: 'A', isMine: true, text: AI_REPLY_PREFIX + '收到' }
    ])
    expect(msgs[1].content).toBe('收到')
  })
})
