import type { RemoteInfo } from 'node:dgram'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MSG_TYPES } from '../../shared/protocol'
import { encode, makeEnvelope } from './codec'
import { UdpChannel } from './udp'

interface Bucket {
  tokens: number
  last: number
}

interface UdpInternals {
  buckets: Map<string, Bucket>
  onMessage(buf: Buffer, rinfo: RemoteInfo): void
}

function rinfo(address: string): RemoteInfo {
  return { address, family: 'IPv4', port: 17878, size: 0 }
}

describe('UdpChannel 限速桶', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('消息到达时惰性清理十分钟前的桶', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const udp = new UdpChannel({ port: 0, bindAddress: '127.0.0.1', broadcastTargets: [] })
    const internals = udp as unknown as UdpInternals
    const now = Date.now()

    for (let i = 0; i < 2049; i += 1) {
      internals.buckets.set(`10.0.${Math.floor(i / 256)}.${i % 256}`, {
        tokens: 1,
        last: now - 11 * 60_000
      })
    }
    internals.buckets.set('127.0.0.1', { tokens: 60, last: now })

    internals.onMessage(
      encode(makeEnvelope(MSG_TYPES.presence, 'node-bob', { seq: 1, profileRev: 1 })),
      rinfo('127.0.0.1')
    )

    expect(internals.buckets.size).toBe(1)
    expect(internals.buckets.has('127.0.0.1')).toBe(true)
  })
})
