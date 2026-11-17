import type { PresenceStatus } from '../../../shared/protocol'
import { tr } from './i18n'

export interface PresenceStatusOption {
  value: PresenceStatus
  label: string
}

/** 固定六种手动状态；label 保留中文作为 i18n key。 */
export const PRESENCE_STATUS_OPTIONS: readonly PresenceStatusOption[] = [
  { value: 'online', label: '在线' },
  { value: 'focus', label: '专注' },
  { value: 'meeting', label: '开会' },
  { value: 'lunch', label: '吃饭' },
  { value: 'slacking', label: '摸鱼' },
  { value: 'offWork', label: '下班' }
]

export function presenceStatusLabel(status?: PresenceStatus): string {
  const option = PRESENCE_STATUS_OPTIONS.find((item) => item.value === status)
  return tr(option?.label ?? '在线')
}


