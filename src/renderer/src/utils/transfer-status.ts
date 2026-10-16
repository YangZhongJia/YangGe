import type { TransferView } from '../../../shared/ipc'
import { TRANSFER_FAILURE_TEXT } from '../../../i18n/transfers'
import { tr } from './i18n'

export function transferFailureText(transfer: TransferView): string {
  return transfer.failureReason ? tr(TRANSFER_FAILURE_TEXT[transfer.failureReason] ?? '传输失败') : tr('传输失败')
}

export function sentTransferText(transfer: TransferView): string {
  if (transfer.status === 'done') return tr('已送达')
  if (transfer.status === 'canceled') return tr('接收方已取消')
  if (transfer.status === 'failed') return tr('失败：{0}', { 0: transferFailureText(transfer) })
  if (transfer.status === 'declined') return tr('对方已拒收')
  if (transfer.status === 'expired') return tr('发送已到期')
  return transfer.notified || transfer.status === 'accepted' ? tr('已通知') : tr('发送中')
}

export function sentTransferTitle(transfer: TransferView): string {
  return transfer.status === 'done' && !transfer.deliveryConfirmed
    ? tr('文件已传完，接收方未确认保存结果')
    : sentTransferText(transfer)
}
