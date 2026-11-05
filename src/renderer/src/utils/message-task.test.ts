import { describe, expect, it } from 'vitest'
import type { MessageView } from '../../../shared/ipc'
import { WORK_TASK_LIMITS } from '../../../shared/work-task'
import { buildMessageTaskDraft, clampUtf8 } from './message-task'

function message(patch: Partial<MessageView> = {}): MessageView {
  return {
    id: 'msg-12345678',
    convId: 'single:peer-1',
    senderId: 'peer-1',
    isMine: false,
    kind: 'text',
    text: '完成登录回归\n覆盖验证码和错误密码',
    ts: 1790000000000,
    seq: 3,
    status: 'sent',
    ...patch
  }
}

describe('聊天消息转任务草稿', () => {
  it('标题取首行，说明保留来源、发送人、消息 ID 和原文', () => {
    const draft = buildMessageTaskDraft(
      message(),
      '张三',
      '五期项目群',
      new Date(2026, 10, 5, 9, 30)
    )
    expect(draft.title).toBe('完成登录回归')
    expect(draft.description).toContain('来源：五期项目群 · 张三')
    expect(draft.description).toContain('时间：2026-11-05 09:30')
    expect(draft.description).toContain('消息 ID：msg-12345678')
    expect(draft.description).toContain('完成登录回归\n覆盖验证码和错误密码')
  })

  it('图片等非文本消息使用可读占位标题', () => {
    const draft = buildMessageTaskDraft(message({ kind: 'image', text: '[图片]' }), '李四', '单聊')
    expect(draft.title).toBe('[图片]')
    expect(draft.description).toContain('[图片]')
  })

  it('超长消息按 UTF-8 字节截断，整体不超过任务说明上限', () => {
    const long = buildMessageTaskDraft(
      message({ text: '任'.repeat(4000) }),
      '王五',
      '长消息会话'
    )
    expect(new TextEncoder().encode(long.description).length).toBeLessThanOrEqual(
      WORK_TASK_LIMITS.descriptionBytes
    )
    expect(clampUtf8('你好世界', 3)).toBe('你')
  })
})
