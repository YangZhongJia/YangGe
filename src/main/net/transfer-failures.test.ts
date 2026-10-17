import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFrame } from './frame'
import { pullTransfer, type PullOptions } from './transfer'

// 只模拟 TCP 字节交付；仍执行真实目录、写流、SHA-256 和改名，沙箱无需开放监听端口。
const wire = vi.hoisted(() => ({ body: 'hello', badHash: false, connectError: false }))
vi.mock('node:net', async (original) => {
  const net = await original<typeof import('node:net')>()
  const { EventEmitter } = await import('node:events')
  class MemorySocket extends EventEmitter {
    destroyed = false
    setNoDelay(): this { return this }
    setTimeout(): this { return this }
    pause(): this { return this }
    resume(): this { return this }
    connect(_options: unknown, ready: () => void): this {
      queueMicrotask(() => wire.connectError ? this.emit('error', new Error('refused')) : ready())
      return this
    }
    write(bytes: Buffer): boolean {
      const frame = JSON.parse(bytes.subarray(4).toString()) as { type: string; fileId: string; offset: number }
      if (frame.type === 'pull') queueMicrotask(() => {
        if (this.destroyed) return
        const body = Buffer.from(wire.body)
        this.emit('data', Buffer.concat([
          encodeFrame({ type: 'pull-ok', fileId: frame.fileId, len: body.length - frame.offset }),
          body.subarray(frame.offset),
          encodeFrame({ type: 'done', fileId: frame.fileId,
            sha256: wire.badHash ? '0'.repeat(64) : createHash('sha256').update(body).digest('hex') })
        ]))
      })
      return true
    }
    end(): void { this.destroy() }
    destroy(): this {
      if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit('close')) }
      return this
    }
  }
  return { ...net, Socket: MemorySocket }
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teahouse-write-failure-'))
  wire.body = 'hello'
  wire.badHash = false
  wire.connectError = false
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function pull(extra: Partial<PullOptions> = {}): Promise<void> {
  return pullTransfer({ host: '127.0.0.1', port: 1, selfId: 'receiver', transferId: 't1',
    files: [{ fileId: 'f1', relPath: 'file.txt', size: 5 }], saveDir: dir,
    cancelRef: { canceled: false, socket: null }, onProgress: () => undefined, ...extra })
}

describe('issue #48 接收落盘故障', () => {
  it('成功时只有完整写入和改名后才 resolve', async () => {
    await pull()
    expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toBe('hello')
    expect(existsSync(join(dir, 'file.txt.part'))).toBe(false)
  })

  it('成功时写流已触发 close 才 resolve', async () => {
    let stream!: ReturnType<typeof createWriteStream>
    let closed = false
    let close!: Promise<void>
    try {
      await pull({ openWriteStream: (path, options) => {
        stream = createWriteStream(path, options)
        close = new Promise(resolve => stream.once('close', () => { closed = true; resolve() }))
        return stream
      } })
      expect(closed).toBe(true)
      expect(stream).toHaveProperty('fd', null)
      expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toBe('hello')
      expect(existsSync(join(dir, 'file.txt.part'))).toBe(false)
    } finally {
      // 即使回归断言失败，也先关闭真实句柄再让 afterEach 删除目录。
      await close
    }
  })

  it('哈希不匹配时写流已触发 close 且删除 .part 才 reject', async () => {
    wire.badHash = true
    let stream!: ReturnType<typeof createWriteStream>
    let closed = false
    let close!: Promise<void>
    try {
      await expect(pull({ openWriteStream: (path, options) => {
        stream = createWriteStream(path, options)
        close = new Promise(resolve => stream.once('close', () => { closed = true; resolve() }))
        return stream
      } })).rejects.toMatchObject({ message: 'hash-mismatch' })
      expect(closed).toBe(true)
      expect(stream).toHaveProperty('fd', null)
      expect(existsSync(join(dir, 'file.txt.part'))).toBe(false)
      expect(existsSync(join(dir, 'file.txt'))).toBe(false)
    } finally {
      await close
    }
  })

  it.each(['size-mismatch', 'write-error', 'canceled'] as const)('%s 清理等待写流 close，并保持续传语义', async reason => {
    if (reason === 'size-mismatch') wire.body = 'wrong size'
    let stream!: ReturnType<typeof createWriteStream>
    let closed = false
    let close!: Promise<void>
    const cancelRef: PullOptions['cancelRef'] = { canceled: false, socket: null }
    try {
      await expect(pull({ cancelRef, openWriteStream: (path, options) => {
        stream = createWriteStream(path, options)
        close = new Promise(resolve => stream.once('close', () => { closed = true; resolve() }))
        return stream
      }, onProgress: () => {
        if (reason === 'canceled') {
          cancelRef.canceled = true
          cancelRef.socket?.destroy()
        } else if (reason === 'write-error') {
          stream.destroy(new Error('disk full'))
        }
      } })).rejects.toMatchObject({ message: reason })
      expect(closed).toBe(true)
      expect(stream).toHaveProperty('fd', null)
      expect(existsSync(join(dir, 'file.txt.part'))).toBe(reason !== 'size-mismatch')
      expect(existsSync(join(dir, 'file.txt'))).toBe(false)
    } finally {
      await close
    }
  })

  it('断点预哈希读流 close 后才打开写流', async () => {
    writeFileSync(join(dir, 'file.txt.part'), 'hel')
    let closed = false
    await pull({ openReadStream: (path, options) => {
      const stream = createReadStream(path, options)
      stream.once('close', () => { closed = true })
      return stream
    }, openWriteStream: (path, options) => {
      expect(closed).toBe(true)
      return createWriteStream(path, options)
    } })
    expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toBe('hello')
  })

  it.each(['part-read-error', 'canceled'] as const)('预哈希 %s 等待读流 close 后清理', async reason => {
    writeFileSync(join(dir, 'file.txt.part'), 'hel')
    let stream!: ReturnType<typeof createReadStream>
    let closed = false
    let close!: Promise<void>
    const cancelRef: PullOptions['cancelRef'] = { canceled: false, socket: null }
    try {
      await expect(pull({ cancelRef, supportsWait: true, openReadStream: (path, options) => {
        stream = createReadStream(path, options)
        close = new Promise(resolve => stream.once('close', () => { closed = true; resolve() }))
        stream.once('data', () => {
          if (reason === 'canceled') {
            cancelRef.canceled = true
            cancelRef.socket?.destroy()
          } else {
            stream.destroy(new Error('read failed'))
          }
        })
        return stream
      } })).rejects.toMatchObject({ message: reason })
      expect(closed).toBe(true)
      expect(stream).toHaveProperty('fd', null)
      expect(existsSync(join(dir, 'file.txt.part'))).toBe(reason === 'canceled')
      expect(existsSync(join(dir, 'file.txt'))).toBe(false)
    } finally {
      await close
    }
  })

  it('无法创建接收目录', async () => {
    writeFileSync(join(dir, 'blocked'), 'file')
    await expect(pull({ saveDir: join(dir, 'blocked') })).rejects.toMatchObject({ message: 'write-error', stage: 'prepare' })
  })

  it('无法打开 .part 写流', async () => {
    mkdirSync(join(dir, 'file.txt.part'))
    wire.body = ''
    await expect(pull({ files: [{ fileId: 'f1', relPath: 'file.txt', size: 0 }] }))
      .rejects.toMatchObject({ message: 'write-error' })
  })

  it('创建写流同步抛异常仍由 Promise 收口', async () => {
    await expect(pull({ openWriteStream: () => { throw new Error('disk denied') } }))
      .rejects.toMatchObject({ message: 'write-error' })
  })

  it('最终改名失败不能 resolve 为完成', async () => {
    await expect(pull({ onPhase: (stage) => {
      if (stage === 'write') rmSync(join(dir, 'file.txt.part'))
    } })).rejects.toMatchObject({ message: 'write-error', stage: 'write' })
    expect(existsSync(join(dir, 'file.txt'))).toBe(false)
  })

  it('哈希不匹配不生成最终文件', async () => {
    wire.badHash = true
    await expect(pull()).rejects.toMatchObject({ message: 'hash-mismatch' })
    expect(existsSync(join(dir, 'file.txt'))).toBe(false)
  })

  it('连接错误与用户取消可区分', async () => {
    wire.connectError = true
    await expect(pull()).rejects.toMatchObject({ message: 'socket-error', stage: 'connect' })
    await expect(pull({ cancelRef: { canceled: true, socket: null } })).rejects.toThrow('canceled')
  })
})
