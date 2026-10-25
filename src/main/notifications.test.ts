import { describe, expect, it } from 'vitest'
import type { MessageView } from '../shared/ipc'
import {
  incomingNotificationOptions,
  messageNotificationPreview,
  notificationIconPath,
  suppressIncomingToast
} from './notifications'

function makeMessage(patch: Partial<MessageView>): MessageView {
  return {
    id: 'm1',
    convId: 'single:p1',
    senderId: 'p1',
    isMine: false,
    kind: 'text',
    text: '你好',
    ts: 1,
    seq: 1,
    status: 'sent',
    ...patch
  }
}

describe('notification helpers', () => {
  it('把通知正文里的内置 emoji 降级为文本占位', () => {
    const msg = makeMessage({ text: '收到👍，安排❤️ OK' })

    expect(messageNotificationPreview(msg, false)).toBe('收到[表情]，安排[表情] OK')
    expect(messageNotificationPreview(makeMessage({ text: '👍👍' }), false)).toBe('[表情]')
  })

  it('表情包、图片和文件通知使用稳定摘要', () => {
    expect(messageNotificationPreview(makeMessage({ kind: 'sticker', text: '[表情]' }), false)).toBe(
      '[表情]'
    )
    expect(messageNotificationPreview(makeMessage({ kind: 'image', text: '[图片]' }), false)).toBe(
      '[图片]'
    )
    expect(
      messageNotificationPreview(
        makeMessage({
          kind: 'file',
          text: '[文件] old',
          fileRef: { transferId: 't1', name: '资料👍.pdf', size: 1, count: 1, dir: false }
        }),
        false
      )
    ).toBe('[文件] 资料[表情].pdf')
  })

  it('PK 通知只显示玩法，不暴露结果', () => {
    expect(
      messageNotificationPreview(
        makeMessage({
          kind: 'pk',
          text: '[PK] 骰子',
          pkRef: { game: 'dice', result: 6 }
        }),
        false
      )
    ).toBe('[PK] 骰子')
  })

  it('群通知隐藏预览时不泄露发送人，只保留会话级标题', () => {
    const msg = makeMessage({ convId: 'group:g1', text: '秘密👍' })
    const options = incomingNotificationOptions({
      msg,
      senderNick: '张三',
      groupName: '项目群',
      hidePreview: true,
      silent: true
    })

    expect(options).toEqual({ title: '项目群', body: '收到一条新消息', silent: true })
  })

  it('Linux/Windows 通知显式使用应用图标，macOS 交给系统 app 图标', () => {
    expect(
      notificationIconPath({
        platform: 'linux',
        isPackaged: true,
        resourcesPath: '/opt/Teahouse/resources',
        appPath: '/app'
      })
    ).toBe('/opt/Teahouse/resources/icons/pantry.png')
    expect(
      notificationIconPath({
        platform: 'win32',
        isPackaged: false,
        resourcesPath: 'C:\\Teahouse\\resources',
        appPath: 'C:\\repo'
      })
    ).toBe('C:\\repo\\build\\icons\\window-icon.png')
    expect(
      notificationIconPath({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath: '/res',
        appPath: '/repo'
      })
    ).toBeUndefined()
  })
})

describe('新消息免打扰判定（窗口聚焦且正在看该会话才免弹）', () => {
  const gate = (focused: boolean, visible: boolean, convId: string, attendedConvId: string | null) =>
    suppressIncomingToast({ focused, visible, convId, attendedConvId })

  it('聚焦且正在看的正是该会话：免打扰（正文就在眼前）', () => {
    expect(gate(true, true, 'single:p1', 'single:p1')).toBe(true)
    expect(gate(true, true, 'group:g1', 'group:g1')).toBe(true)
  })

  it('聚焦但消息来自其他会话：照常弹通知（微信式）', () => {
    expect(gate(true, true, 'single:p2', 'single:p1')).toBe(false)
    expect(gate(true, true, 'group:g1', 'single:p1')).toBe(false)
  })

  it('未聚焦、不可见（最小化 / 托盘）或尚无注视会话：照常弹通知', () => {
    expect(gate(false, true, 'single:p1', 'single:p1')).toBe(false)
    expect(gate(true, false, 'single:p1', 'single:p1')).toBe(false)
    expect(gate(true, true, 'single:p1', null)).toBe(false)
  })
})
