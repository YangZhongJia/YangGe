import { describe, expect, it } from 'vitest'
import { resolveMessageSound } from './message-sound'

describe('消息提示音规则', () => {
  const base = { sound: 'ding', isMine: false, kind: 'text', muted: false } as const

  it('开启且收到他人消息时返回所选音色', () => {
    expect(resolveMessageSound(base)).toBe('ding')
    expect(resolveMessageSound({ ...base, sound: 'drop' })).toBe('drop')
    expect(resolveMessageSound({ ...base, sound: 'wood' })).toBe('wood')
  })

  it('关闭提示音、自己发送、系统消息与免打扰会话都不响', () => {
    expect(resolveMessageSound({ ...base, sound: 'none' })).toBeNull()
    expect(resolveMessageSound({ ...base, isMine: true })).toBeNull()
    expect(resolveMessageSound({ ...base, kind: 'system' })).toBeNull()
    expect(resolveMessageSound({ ...base, muted: true })).toBeNull()
  })
})
