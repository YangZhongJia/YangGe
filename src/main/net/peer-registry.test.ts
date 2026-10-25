import { describe, expect, it, vi } from 'vitest'
import type { Profile } from '../../shared/protocol'
import { PeerRegistry } from './peer-registry'

function profile(nodeId: string, nick: string, profileRev = 1): Profile {
  return {
    nodeId,
    nick,
    company: '',
    dept: '',
    team: '',
    avatar: -1,
    profileRev,
    host: `${nodeId}-host`,
    platform: 'linux',
    tcpPort: 18888,
    ver: '0.0.0-test',
    caps: []
  }
}

describe('PeerRegistry 节点状态', () => {
  it('seed 跳过自己和已有节点，并以离线态导入历史联系人', () => {
    const registry = new PeerRegistry('node-self')
    const updated = vi.fn()
    registry.on('updated', updated)

    registry.touch('node-bob', '127.0.0.1', 10001, profile('node-bob', 'Bob 在线'))
    registry.seed([
      {
        profile: profile('node-self', '我'),
        ip: '127.0.0.1',
        udpPort: 10000,
        lastSeen: 1,
        online: true
      },
      {
        profile: profile('node-bob', 'Bob 历史'),
        ip: '127.0.0.2',
        udpPort: 10002,
        lastSeen: 2,
        online: false
      },
      {
        profile: profile('node-carol', 'Carol'),
        ip: '127.0.0.3',
        udpPort: 10003,
        lastSeen: 3,
        online: true
      }
    ])
    registry.seed([
      {
        profile: profile('node-carol', 'Carol 二次导入'),
        ip: '127.0.0.4',
        udpPort: 10004,
        lastSeen: 4,
        online: true
      }
    ])

    expect(registry.get('node-self')).toBeUndefined()
    expect(registry.get('node-bob')).toMatchObject({
      ip: '127.0.0.1',
      udpPort: 10001,
      online: true,
      profile: { nick: 'Bob 在线' }
    })
    expect(registry.get('node-carol')).toMatchObject({
      ip: '127.0.0.3',
      udpPort: 10003,
      online: false,
      profile: { nick: 'Carol' }
    })
    expect(updated).toHaveBeenCalledTimes(2)
  })

  it('touch 拒绝未知空资料、自己和 nodeId 不一致的资料', () => {
    const registry = new PeerRegistry('node-self')

    expect(registry.touch('node-bob', '127.0.0.1', 10001)).toBeNull()
    expect(registry.touch('node-self', '127.0.0.1', 10001, profile('node-self', '我'))).toBeNull()
    expect(registry.touch('node-bob', '127.0.0.1', 10001, profile('node-other', '错配'))).toBeNull()
    expect(registry.values()).toEqual([])
  })

  it('已在线节点不接受源地址漂移，即使携带更新资料', () => {
    const registry = new PeerRegistry('node-self')
    registry.touch('node-bob', '127.0.0.1', 10001, profile('node-bob', 'Bob', 1))

    expect(
      registry.touch('node-bob', '127.0.0.2', 10002, profile('node-bob', '伪造 Bob', 2))
    ).toBeNull()

    expect(registry.get('node-bob')).toMatchObject({
      ip: '127.0.0.1',
      udpPort: 10001,
      online: true,
      profile: { nick: 'Bob', profileRev: 1 }
    })
  })

  it('离线节点换地址必须带完整 profile，且 online 事件看到的是更新后的字段', () => {
    const registry = new PeerRegistry('node-self')
    registry.touch('node-bob', '127.0.0.1', 10001, profile('node-bob', 'Bob', 1))
    registry.markOffline('node-bob')

    expect(registry.touch('node-bob', '127.0.0.2', 10002)).toBeNull()
    expect(registry.get('node-bob')).toMatchObject({
      ip: '127.0.0.1',
      udpPort: 10001,
      online: false,
      profile: { nick: 'Bob', profileRev: 1 }
    })

    const onlineSnapshots: Array<ReturnType<PeerRegistry['get']>> = []
    registry.on('online', (nodeId: string) => {
      onlineSnapshots.push(registry.get(nodeId))
    })
    const updated = registry.touch(
      'node-bob',
      '127.0.0.2',
      10002,
      profile('node-bob', 'Bob 新地址', 2)
    )

    expect(updated).toMatchObject({
      ip: '127.0.0.2',
      udpPort: 10002,
      online: true,
      profile: { nick: 'Bob 新地址', profileRev: 2 }
    })
    expect(onlineSnapshots).toHaveLength(1)
    expect(onlineSnapshots[0]).toMatchObject({
      ip: '127.0.0.2',
      udpPort: 10002,
      online: true,
      profile: { nick: 'Bob 新地址', profileRev: 2 }
    })
  })

  it('profileRev 旧值不回退，较新资料才覆盖', () => {
    const registry = new PeerRegistry('node-self')
    registry.touch('node-bob', '127.0.0.1', 10001, profile('node-bob', 'Bob v2', 2))

    registry.touch('node-bob', '127.0.0.1', 10001, profile('node-bob', 'Bob v1', 1))
    expect(registry.get('node-bob')?.profile).toMatchObject({ nick: 'Bob v2', profileRev: 2 })

    registry.touch('node-bob', '127.0.0.1', 10001, profile('node-bob', 'Bob v3', 3))
    expect(registry.get('node-bob')?.profile).toMatchObject({ nick: 'Bob v3', profileRev: 3 })
  })

  it.each<Partial<Profile>>([
    { company: '新公司' }, { dept: '新部门' }, { team: '新团队' },
    { avatar: 3 }, { avatarHash: 'a'.repeat(64) }, { nick: '新昵称' },
    { host: '新主机' }, { platform: 'win' }, { tcpPort: 18889 },
    { ver: '0.60.1' }, { caps: ['rv1'] }
  ])('同版本资料变化 %j 通知一次，重复/旧资料与聊天探活不重复通知', (patch) => {
    const registry = new PeerRegistry('node-self')
    const before = profile('node-bob', 'Bob', 2)
    registry.touch(before.nodeId, '127.0.0.1', 10001, before)
    const updated = vi.fn(() => ({ ...registry.get(before.nodeId)!.profile }))
    registry.on('updated', updated)

    const next = { ...before, ...patch }
    registry.touch(before.nodeId, '127.0.0.1', 10001, next)
    expect(updated).toHaveBeenCalledTimes(1)
    expect(updated.mock.results[0].value).toEqual(next)
    registry.touch(before.nodeId, '127.0.0.1', 10001, { ...next, caps: [...next.caps] })
    registry.touch(before.nodeId, '127.0.0.1', 10001, { ...before, profileRev: 1 })
    registry.touch(before.nodeId, '127.0.0.1', 10001)
    expect(updated).toHaveBeenCalledTimes(1)
    expect(registry.get(before.nodeId)?.profile).toEqual(next)
  })

  it('sweep 只把超时在线节点标为离线', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    try {
      const registry = new PeerRegistry('node-self')
      const updated = vi.fn()
      registry.on('updated', updated)
      registry.touch('node-old', '127.0.0.1', 10001, profile('node-old', '旧节点'))
      registry.touch('node-fresh', '127.0.0.1', 10002, profile('node-fresh', '新节点'))
      registry.markOffline('node-offline')

      vi.setSystemTime(12_000)
      registry.touch('node-fresh', '127.0.0.1', 10002)
      registry.sweep(1_000)

      expect(registry.get('node-old')?.online).toBe(false)
      expect(registry.get('node-fresh')?.online).toBe(true)
      expect(updated).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('values 保留插入顺序，list 保留展示排序', () => {
    const registry = new PeerRegistry('node-self')
    registry.touch('node-zhang', '127.0.0.1', 10001, profile('node-zhang', '张三'))
    registry.touch('node-a', '127.0.0.1', 10002, profile('node-a', '阿明'))
    registry.touch('node-offline', '127.0.0.1', 10003, profile('node-offline', '安安'))
    registry.markOffline('node-offline')

    expect(registry.values().map((record) => record.profile.nick)).toEqual([
      '张三',
      '阿明',
      '安安'
    ])
    expect(registry.list().map((record) => record.profile.nick)).toEqual([
      '阿明',
      '张三',
      '安安'
    ])
  })
})

describe('离开状态（决议 #323）', () => {
  it('setAway 更新记录并触发 updated；离线时自动清除', () => {
    const registry = new PeerRegistry('node-self')
    registry.touch('node-bob', '127.0.0.1', 10001, profile('node-bob', 'Bob'))
    const updates: number[] = []
    registry.on('updated', () => updates.push(1))

    registry.setAway('node-bob', true)
    expect(registry.get('node-bob')?.away).toBe(true)
    registry.setAway('node-bob', true)
    expect(updates.length).toBe(1) // 同值不重复触发

    registry.setAway('node-bob', false)
    expect(registry.get('node-bob')?.away).toBe(false)

    registry.markOffline('node-bob')
    registry.setAway('node-bob', true) // 离线节点不接受 away
    expect(registry.get('node-bob')?.away).toBe(false)
  })
})
