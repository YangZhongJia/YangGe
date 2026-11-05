export interface ReleaseHighlights {
  version: string
  notes: string[]
  /** 有修复项时只展示一句「优化已知 BUG」，不展开细节。 */
  fixed: boolean
}

/**
 * 版本亮点随安装包静态发布。发版时在这里追加一条当前版本记录；
 * 主窗按 localStorage 中的 lastSeenVersion 判断是否展示，避免每次启动重复弹出。
 */
export const RELEASE_HIGHLIGHTS: Record<string, ReleaseHighlights> = {
  '1.11.2': {
    version: '1.11.2',
    notes: [
      '未读消息在会话头像上显示红点数字，进入会话后给出「收到 N 条新消息」提示。',
      '纸飞机 / 墨弹可选择在聊天窗口内播放，或在发送方与接收方的桌面全屏播放。',
      '锁屏期间系统通知只显示「收到一条新消息」，不泄露聊天正文。',
      '群聊纸飞机 / 墨弹发送后立即播放本地动画，不再等待所有成员回执。',
      '修复深色模式设置窗左侧黑框。'
    ],
    fixed: true
  },
  '1.11.1': {
    version: '1.11.1',
    notes: [
      '群聊消息头像支持单击直接进入该成员私聊，沟通少一步。'
    ],
    fixed: true
  },
  '1.11.0': {
    version: '1.11.0',
    notes: [
      '消息收藏：右键消息即可收藏，在收藏夹里集中查看并跳回原消息。',
      '任务中心支持负责人指派、接受/拒绝与执行状态回传。',
      '聊天消息可一键转为任务，自动带上来源、发送人和原文。',
      '群聊支持纸飞机和墨弹互动，效果广播给当前在线成员。',
      '通讯录支持清理离线空联系人，不会误删有聊天记录或备注的节点。',
      '新增 6 位数字锁屏密码：启动、最小化或从托盘恢复时显示粒子蒙面，可在设置中开启、关闭或立即锁定。'
    ],
    fixed: true
  }
}

export const VERSION_SEEN_KEY = 'yangge.lastSeenVersion'

export function releaseHighlightsFor(version: string): ReleaseHighlights | null {
  const normalized = version.trim().replace(/^v/i, '')
  if (!normalized) return null
  // 新版本即使发版时忘了补亮点，也至少用一句「优化已知 BUG」告知更新，避免静默升级。
  return RELEASE_HIGHLIGHTS[normalized] ?? { version: normalized, notes: [], fixed: true }
}
