import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLanSend, type LanSend } from './index'

const roots: string[] = []
const services: LanSend[] = []

function makeService(name: string): { service: LanSend; dir: string; download: string } {
  const dir = mkdtempSync(join(tmpdir(), `yangge-fast-${name}-`))
  const download = join(dir, 'downloads')
  roots.push(dir)
  const service = createLanSend({
    dataDir: join(dir, 'data'),
    downloadDir: download,
    alias: name,
    port: 0,
    udpPort: 0,
    http: false,
    discovery: false
  })
  services.push(service)
  return { service, dir, download }
}

function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findFile(path, name)
      if (nested) return nested
    } else if (entry.name === name) {
      return path
    }
  }
  return null
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop().catch(() => {})))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('lansend 高速传输', () => {
  it('两个本地节点可完成多连接传输并落盘', async () => {
    const sender = makeService('sender')
    const receiver = makeService('receiver')
    await sender.service.start()
    await receiver.service.start()

    receiver.service.on('offer', ({ respond }) => {
      respond({ accepted: true })
    })

    const peer = await sender.service.addPeer('127.0.0.1', receiver.service.port)
    expect(peer).not.toBeNull()
    const source = join(sender.dir, 'sample.txt')
    writeFileSync(source, 'YangGe fast transfer\n'.repeat(4096))

    const summary = await sender.service.send({ peer: peer!, paths: [source] })
    expect(summary.state).toBe('completed')
    expect(summary.totalBytes).toBeGreaterThan(0)

    const received = findFile(receiver.download, 'sample.txt')
    expect(received).not.toBeNull()
    expect(readFileSync(received!, 'utf8')).toContain('YangGe fast transfer')
  }, 15_000)
})
