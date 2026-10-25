/** 本地界面语言，不进入局域网协议（决议 #307）。 */
export type Language = 'zh-CN' | 'en'
export type TranslationParams = Record<string, string | number>

export const LANGUAGE_OPTIONS = [
  { label: '简体中文', value: 'zh-CN' },
  { label: 'English', value: 'en' }
] as const

export const SYSTEM_MESSAGE_TEMPLATES = {
  'nudge.sent': '你发送了一次窗口震动',
  'nudge.received': '对方发来一次窗口震动',
  'recall.self': '你撤回了一条消息',
  'recall.peer': '对方撤回了一条消息',
  'group.invited': '{actor}邀请你加入群聊',
  'group.owner-left': '{actor}退出群聊，{owner}自动成为新群主',
  'group.added': '{actor}邀请{members}加入群聊',
  'group.left': '{actor}退出了群聊',
  'group.removed': '{actor}将{members}移出群聊',
  'group.renamed': '{actor}把群名「{before}」改成了「{after}」',
  'group.avatar': '{actor}修改了群头像',
  'group.avatar-reset': '{actor}恢复了默认群头像',
  'group.description': '{actor}修改了群简介',
  'group.announcement': '{actor}修改了群公告',
  'group.promoted': '{actor}将{members}设为管理员',
  'group.demoted': '{actor}取消了{members}的管理员身份',
  'share.uploaded': '{actor} 上传了 {count} 个文件到你的文件柜',
  'clipboard.sent': '你把剪贴板内容发给了 {actor}',
  'clipboard.received': '{actor} 发来的剪贴板内容已复制到你的剪贴板'
} as const

export type SystemMessageKey = keyof typeof SYSTEM_MESSAGE_TEMPLATES
export interface SystemPerson {
  name: string
  role?: 'self' | 'unknown'
}
export interface SystemPeople {
  people: SystemPerson[]
  total: number
}
export interface SystemMessage {
  v: 1
  key: SystemMessageKey
  params: Record<string, string | number | SystemPerson | SystemPeople>
}
