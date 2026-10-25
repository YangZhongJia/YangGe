import { tr } from '../i18n'
import { posix, win32 } from 'node:path'
import type { MessageView } from '../shared/ipc'
import { emojiSafePlainText } from '../shared/compat-emoji'
import { pkLabel } from '../shared/pk'

export interface NotificationIconPathInput {
  platform: NodeJS.Platform
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}

export interface IncomingNotificationInput {
  msg: MessageView
  senderNick: string
  groupName?: string
  hidePreview: boolean
  silent: boolean
}

export interface IncomingNotificationOptions {
  title: string
  body: string
  silent: boolean
}

const MAX_NOTIFICATION_BODY_CHARS = 60

export interface IncomingToastGateInput {
  focused: boolean
  visible: boolean
  convId: string
  /** 用户正在看的会话（renderer 在窗口有人看时对当前会话调 convMarkRead，决议 #220 的镜像信号） */
  attendedConvId: string | null
}

/**
 * 新消息是否免弹系统通知（F-SYS-2，微信式）：窗口聚焦且用户正在看的正是该会话时免打扰
 * （正文就在眼前，只留应用内呈现）；失焦 / 最小化 / 聚焦但消息来自其他会话时照常弹通知。
 */
export function suppressIncomingToast(input: IncomingToastGateInput): boolean {
  return input.focused && input.visible && input.convId === input.attendedConvId
}

export function notificationIconPath(input: NotificationIconPathInput): string | undefined {
  if (input.platform === 'darwin') return undefined
  const path = input.platform === 'win32' ? win32 : posix
  return input.isPackaged
    ? path.join(input.resourcesPath, 'icons', 'pantry.png')
    : path.join(input.appPath, 'build', 'icons', 'window-icon.png')
}

export function messageNotificationPreview(msg: MessageView, hidePreview: boolean): string {
  if (hidePreview) return tr('收到一条新消息')

  const raw = mediaPreviewText(msg) ?? msg.text
  const clean = emojiSafePlainText(raw.trim(), tr('[表情]')).trim() || tr('收到一条新消息')
  return clean.length > MAX_NOTIFICATION_BODY_CHARS
    ? `${clean.slice(0, MAX_NOTIFICATION_BODY_CHARS)}…`
    : clean
}

export function incomingNotificationOptions(input: IncomingNotificationInput): IncomingNotificationOptions {
  const previewText = messageNotificationPreview(input.msg, input.hidePreview)
  const isGroup = input.msg.convId.startsWith('group:')
  if (!isGroup) {
    return {
      title: input.senderNick,
      body: previewText,
      silent: input.silent
    }
  }

  const groupName = input.groupName?.trim() || tr('讨论组')
  return {
    title: input.msg.mentioned ? tr('{0}（有人@你）', { 0: groupName }) : groupName,
    body: input.hidePreview ? previewText : `${input.senderNick}：${previewText}`,
    silent: input.silent
  }
}

function mediaPreviewText(msg: MessageView): string | null {
  if (msg.kind === 'image') return tr('[图片]')
  if (msg.kind === 'sticker') return tr('[表情]')
  if (msg.kind === 'pk') return msg.pkRef ? `[PK] ${tr(pkLabel(msg.pkRef.game))}` : msg.text
  if (msg.kind === 'file') {
    const name = msg.fileRef?.name?.trim()
    if (name) return msg.fileRef?.dir ? tr('[文件夹] {0}', { 0: name }) : tr('[文件] {0}', { 0: name })
  }
  return null
}
