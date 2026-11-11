import type { MessageView } from '../../../shared/ipc'

/** 触发巨型面碗特效的表情。 */
export const NOODLE_EMOJI = '🍜'
/** 连续面条消息只放一次特效，避免群聊刷屏时叠成一团。 */
export const NOODLE_BURST_COOLDOWN_MS = 2600

/**
 * 面碗特效只在「当前会话 + 用户正在看」时播放：
 * 别处收到 🍜 不打扰当前聊天，窗口隐藏/失焦时放了也没人看见。
 */
export function shouldShowNoodleBurst(input: {
  kind: MessageView['kind']
  text: string
  convId: string
  activeConvId: string | null
  attended: boolean
  now: number
  lastAt: number
}): boolean {
  if (input.kind !== 'text' || !input.text.includes(NOODLE_EMOJI)) return false
  if (!input.activeConvId || input.convId !== input.activeConvId || !input.attended) return false
  return input.now - input.lastAt >= NOODLE_BURST_COOLDOWN_MS
}

/**
 * 补播用：未读区间里最新的一条面条消息。
 * 消息可能在别的会话、窗口隐藏或应用重启期间到达，进入会话时据此补一次特效。
 */
export function unreadNoodleMessage(
  messages: MessageView[] | undefined,
  unread: number
): MessageView | null {
  if (!messages?.length || unread <= 0) return null
  const start = Math.max(0, messages.length - unread)
  for (let i = messages.length - 1; i >= start; i -= 1) {
    const msg = messages[i]
    if (!msg.isMine && msg.kind === 'text' && msg.text.includes(NOODLE_EMOJI)) return msg
  }
  return null
}
