import { describe, expect, it, vi } from 'vitest'
import { usePendingAttachments } from './pending-attachments'

function setup() {
  const urls = { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }
  const queue = usePendingAttachments(urls as unknown as typeof URL)
  const add = (name = '截图.png', path = '') => queue.add(new Blob(['fixture']), name, path)
  return { ...queue, add, urls }
}
function deferred() {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>(r => { resolve = r })
  return { promise, resolve }
}
describe('粘贴附件草稿', () => {
  it('追加图片和文件，粘贴不调用发送，相同待发送路径只保留一份', () => {
    const q = setup()
    q.add('图片.png', '/image.png'); q.add('资料.pdf', '/doc.pdf'); q.add('资料.pdf', '/doc.pdf')
    expect(q.items.value.map(item => item.name)).toEqual(['图片.png', '资料.pdf'])
    expect(q.items.value[0].preview).toBe('blob:preview')
    expect(q.items.value[1].preview).toBe('')
    q.add(); q.add()
    expect(q.items.value).toHaveLength(4)
  })
  it('移除与取消释放缩略图；取消使异步粘贴代次过期', () => {
    const q = setup(); q.add(); q.add()
    const token = q.token()
    q.remove(q.items.value[0].id)
    q.clear()
    expect(q.items.value).toEqual([])
    expect(q.urls.revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(q.isCurrent(token)).toBe(false)
  })
  it('显式发送先提交混合文本，再按顺序发送附件', async () => {
    const q = setup(); q.add(); q.add('资料.pdf', '/doc.pdf')
    const events: string[] = []
    await q.send(async item => { events.push(item.name); return true }, async () => { events.push('正文'); return true })
    expect(events).toEqual(['正文', '截图.png', '资料.pdf'])
    expect(q.items.value).toEqual([])
    expect(q.busy.value).toBe(false)
  })
  it('双击发送只提交一次；发送期间追加的附件留到下次确认', async () => {
    const q = setup(); q.add()
    const wait = deferred(), submit = vi.fn(() => wait.promise)
    const run = q.send(submit)
    await q.send(submit)
    q.add('下一张.png')
    wait.resolve(true); await run
    expect(submit).toHaveBeenCalledTimes(1)
    expect(q.items.value.map(item => item.name)).toEqual(['下一张.png'])
  })
  it('部分失败保留剩余项，重试不重复发送成功项', async () => {
    const q = setup(); q.add('1.png'); q.add('2.png'); q.add('3.png')
    await q.send(async item => item.name !== '2.png')
    expect(q.failed.value).toBe(true)
    expect(q.items.value.map(item => item.name)).toEqual(['2.png', '3.png'])
    const submit = vi.fn(async () => true)
    await q.send(submit)
    expect(submit.mock.calls).toHaveLength(2)
    expect(q.items.value).toEqual([])
  })
  it('文字发送失败时不继续发送附件', async () => {
    const q = setup(); q.add(); const submit = vi.fn(async () => true)
    await q.send(submit, async () => false)
    expect(submit).not.toHaveBeenCalled()
    expect(q.items.value).toHaveLength(1)
  })
  it('切换会话阻止尚未开始的发送，旧结果不删除新会话附件', async () => {
    const q = setup(); q.add(); q.add()
    const wait = deferred(), submit = vi.fn(() => wait.promise)
    const run = q.send(submit)
    q.clear(); q.add('新会话.png')
    wait.resolve(true); await run
    expect(submit).toHaveBeenCalledTimes(1)
    expect(q.items.value[0].name).toBe('新会话.png')
  })
  it('异步读取后代次失效时调用者不再提交到新会话', async () => {
    const q = setup(); q.add()
    const wait = deferred(), transport = vi.fn()
    const run = q.send(async (_item, valid) => {
      await wait.promise
      if (!valid()) return false
      transport(); return true
    })
    q.clear(); wait.resolve(true); await run
    expect(transport).not.toHaveBeenCalled()
    expect(q.failed.value).toBe(false)
  })
  it('读取或发送抛错保留附件并解除发送锁', async () => {
    const q = setup(); q.add()
    await q.send(async () => { throw Error('测试异常') })
    expect(q.items.value).toHaveLength(1)
    expect(q.failed.value).toBe(true)
    expect(q.busy.value).toBe(false)
  })
})
