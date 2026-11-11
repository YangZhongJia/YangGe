import { describe, expect, it } from 'vitest'
import type { MessageView } from '../../../shared/ipc'
import {
  NOODLE_BURST_COOLDOWN_MS,
  shouldShowNoodleBurst,
  unreadNoodleMessage
} from './noodle-effect'

describe('面碗特效规则', () => {
  const base = {
    kind: 'text',
    text: '今天吃 🍜',
    convId: 'group:food',
    activeConvId: 'group:food',
    attended: true,
    now: 10_000,
    lastAt: 0
  } as const

  it('当前会话收到含面条表情的文本时播放', () => {
    expect(shouldShowNoodleBurst(base)).toBe(true)
    expect(shouldShowNoodleBurst({ ...base, text: '🍜🍜🍜' })).toBe(true)
  })

  it('非文本、无面条、非当前会话、未聚焦与冷却期内都不播放', () => {
    expect(shouldShowNoodleBurst({ ...base, kind: 'image' })).toBe(false)
    expect(shouldShowNoodleBurst({ ...base, text: '今天吃面' })).toBe(false)
    expect(shouldShowNoodleBurst({ ...base, convId: 'single:other' })).toBe(false)
    expect(shouldShowNoodleBurst({ ...base, activeConvId: null })).toBe(false)
    expect(shouldShowNoodleBurst({ ...base, attended: false })).toBe(false)
    expect(shouldShowNoodleBurst({ ...base, lastAt: base.now - NOODLE_BURST_COOLDOWN_MS + 1 })).toBe(false)
    expect(shouldShowNoodleBurst({ ...base, lastAt: base.now - NOODLE_BURST_COOLDOWN_MS })).toBe(true)
  })
})

describe('未读补播', () => {
  function message(id: string, patch: Partial<MessageView> = {}): MessageView {
    return {
      id,
      convId: 'single:peer',
      senderId: 'peer',
      isMine: false,
      kind: 'text',
      text: '普通消息',
      ts: 1,
      seq: 1,
      status: 'sent',
      ...patch
    }
  }

  it('只在未读区间内找最新的面条消息', () => {
    const list = [
      message('old-noodle', { text: '🍜', seq: 1 }),
      message('read', { seq: 2 }),
      message('new-noodle', { text: '来吃 🍜', seq: 3 }),
      message('latest', { seq: 4 })
    ]
    expect(unreadNoodleMessage(list, 2)?.id).toBe('new-noodle')
    expect(unreadNoodleMessage(list, 1)).toBeNull()
  })

  it('忽略自己的、系统的与非文本消息，未读为 0 或未加载时不补播', () => {
    const list = [
      message('mine', { text: '🍜', isMine: true }),
      message('system', { text: '🍜', kind: 'system' }),
      message('image', { text: '🍜', kind: 'image' })
    ]
    expect(unreadNoodleMessage(list, 3)).toBeNull()
    expect(unreadNoodleMessage(list, 0)).toBeNull()
    expect(unreadNoodleMessage(undefined, 3)).toBeNull()
  })

  it('未读数超过已加载页时只在已加载范围内查找', () => {
    const list = [message('a', { seq: 1 }), message('noodle', { text: '🍜', seq: 2 })]
    expect(unreadNoodleMessage(list, 99)?.id).toBe('noodle')
  })
})
