import type { TransferFailureReason } from '../shared/protocol'

/** 原因码只在本地翻译，协议不携带路径或系统异常文本。 */
export const TRANSFER_FAILURE_TEXT: Record<TransferFailureReason, string> = {
  'write-error': '接收方无法保存文件',
  'hash-mismatch': '接收方文件校验失败',
  'connection-error': '接收方连接中断或无法连接',
  'decode-error': '接收方无法解码图片',
  'invalid-data': '接收方收到无效数据',
  canceled: '接收方已取消'
}
