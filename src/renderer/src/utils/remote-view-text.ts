import { tr } from './i18n'
import type { ScreenRecord } from '../../../shared/remote-view'

/** 卡片短状态；完整原因由 screenRecordText 放进悬停与无障碍说明。 */
export function screenStatusText(state: ScreenRecord): string {
  if (state.phase === 'requesting') return tr('等待同意')
  if (state.phase === 'awaiting-consent') return tr('待你同意')
  if (state.phase === 'preparing' || state.phase === 'connecting') return tr('连接中')
  if (state.phase === 'active') return tr('协助中')
  switch (state.reason) {
    case 'declined': return tr(state.role === 'sharer' ? '你已拒绝' : '对方拒绝')
    case 'busy': return tr(state.role === 'sharer' ? '本机忙碌' : '对方忙碌')
    case 'unsupported': return tr('暂不支持')
    case 'permission-denied': return tr('未获授权')
    case 'capture-failed':
    case 'capture-ended': return tr('采集停止')
    // 从未进入协助中就超时 = 直连建立失败，多为防火墙拦入站；连上后的超时维持原义
    case 'timeout': return tr(state.startedAt === undefined ? '连接超时（防火墙？）' : '已超时')
    case 'disconnected': return tr('已断开')
    case 'locked': return tr('锁屏结束')
    case 'suspended': return tr('休眠结束')
    case 'protocol-error': return tr('画面异常')
    case 'interrupted': return tr('已中断')
    default: return tr(state.startedAt === undefined ? '已取消' : '已结束')
  }
}
