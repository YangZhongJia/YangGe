import { afterEach, expect, it } from 'vitest'
import { setLanguage } from '../../../i18n'
import type { TransferView } from '../../../shared/ipc'
import { sentTransferText, sentTransferTitle } from './transfer-status'

const transfer: TransferView = {
  transferId: 't', msgId: 'm', convId: 'single:p', peerId: 'p', direction: 'out',
  status: 'offering', notified: true, bytesDone: 0, totalSize: 5, fileCount: 1,
  name: 'image.png', expiresAt: 0, savedPath: '', direct: false
}
afterEach(() => setLanguage('zh-CN'))

it('中英文均区分已通知、送达、带原因的失败和接收方取消', async () => {
  for (const language of ['zh-CN', 'en'] as const) {
    await setLanguage(language)
    expect(sentTransferText(transfer)).toBe(language === 'en' ? 'Notified' : '已通知')
    expect(sentTransferText({ ...transfer, status: 'done' })).toBe(language === 'en' ? 'Delivered' : '已送达')
    expect(sentTransferText({ ...transfer, status: 'failed', failureReason: 'write-error' }))
      .toBe(language === 'en' ? 'Failed: The recipient could not save the file' : '失败：接收方无法保存文件')
    expect(sentTransferText({ ...transfer, status: 'canceled', failureReason: 'canceled' }))
      .toBe(language === 'en' ? 'Canceled by the recipient' : '接收方已取消')
  }
})

it('兼容回退与真正接收确认具有不同说明', () => {
  expect(sentTransferTitle({ ...transfer, status: 'done', deliveryConfirmed: false }))
    .toBe('文件已传完，接收方未确认保存结果')
  expect(sentTransferTitle({ ...transfer, status: 'done', deliveryConfirmed: true })).toBe('已送达')
})
