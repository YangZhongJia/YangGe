import type { MessageView } from '../../../shared/ipc'
import { WORK_TASK_LIMITS } from '../../../shared/work-task'

export interface MessageTaskDraft {
  title: string
  description: string
}

const encoder = new TextEncoder()

function byteLength(value: string): number {
  return encoder.encode(value).length
}

const KIND_LABELS: Partial<Record<MessageView['kind'], string>> = {
  image: '图片',
  sticker: '表情',
  file: '文件',
  pk: 'PK',
}

/** 按 UTF-8 字节截断，避免任务说明超过协议上限。 */
export function clampUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (byteLength(value.slice(0, mid)) <= maxBytes) low = mid
    else high = mid - 1
  }
  return value.slice(0, low)
}

function messageBody(msg: MessageView): string {
  if (msg.kind === 'text') return msg.text.trim()
  if (msg.kind === 'file') return `[文件] ${msg.text.replace(/^\[文件\]\s*/, '')}`
  return `[${KIND_LABELS[msg.kind] ?? msg.kind}]`
}

/**
 * 把一条聊天消息转成任务草稿。标题取首行摘要；说明保留来源、发送人、
 * 时间与原文，便于回查。纯函数，主进程不需要参与。
 */
export function buildMessageTaskDraft(
  msg: MessageView,
  senderName: string,
  convName: string,
  now = new Date()
): MessageTaskDraft {
  const body = messageBody(msg)
  const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ''
  const title = (firstLine || `来自${convName}的消息`).slice(0, WORK_TASK_LIMITS.title)
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes()
  ).padStart(2, '0')}`
  const prefix = [
    `来源：${convName} · ${senderName}`,
    `时间：${stamp}`,
    `消息 ID：${msg.id}`,
    '',
    ''
  ].join('\n')
  const description = prefix + clampUtf8(body, WORK_TASK_LIMITS.descriptionBytes - byteLength(prefix))
  return { title, description }
}
