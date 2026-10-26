import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect } from 'vitest'
import {
  findLocalUpdatePackage,
  staleUpdatePackages,
  matchesUpdatePackageName,
  pickUpdateSource,
  shouldServeUpdateRequest,
  updatePackageVersionFromName,
  UpdateRequestGate
} from './updater'
import type { SourceCandidate } from './updater'
import type { Profile } from '../../shared/protocol'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function prof(over: Partial<Profile>): Profile {
  return {
    nodeId: 'n',
    nick: '某人',
    company: '',
    dept: '',
    team: '',
    avatar: -1,
    profileRev: 1,
    host: 'h',
    platform: 'win',
    tcpPort: 17879,
    ver: '0.26.5',
    caps: [],
    ...over
  }
}

function cand(over: Partial<Profile>, online = true, displayName = ''): SourceCandidate {
  return { profile: prof(over), online, displayName }
}

describe('pickUpdateSource', () => {
  const self = { version: '0.26.5', platform: 'win' as const }

  it('挑同平台 + 更高版本 + upd1 + 在线', () => {
    const src = pickUpdateSource(self, [cand({ nodeId: 'a', ver: '0.27.0', caps: ['upd1'] })])
    expect(src?.nodeId).toBe('a')
    expect(src?.version).toBe('0.27.0')
  })

  it('跳过：同/低版本、无 upd1、离线、异平台', () => {
    expect(pickUpdateSource(self, [cand({ ver: '0.26.5', caps: ['upd1'] })])).toBeNull() // 同版本
    expect(pickUpdateSource(self, [cand({ ver: '0.26.4', caps: ['upd1'] })])).toBeNull() // 更低
    expect(pickUpdateSource(self, [cand({ ver: '0.27.0', caps: [] })])).toBeNull() // 无 upd1
    expect(pickUpdateSource(self, [cand({ ver: '0.27.0', caps: ['upd1'] }, false)])).toBeNull() // 离线
    expect(pickUpdateSource(self, [cand({ ver: '0.27.0', caps: ['upd1'], platform: 'linux' })])).toBeNull() // 异平台
  })

  it('多候选取最高版本', () => {
    const src = pickUpdateSource(self, [
      cand({ nodeId: 'a', ver: '0.27.0', caps: ['upd1'] }),
      cand({ nodeId: 'b', ver: '0.28.1', caps: ['upd1'] }),
      cand({ nodeId: 'c', ver: '0.27.5', caps: ['upd1'] })
    ])
    expect(src?.nodeId).toBe('b')
    expect(src?.version).toBe('0.28.1')
  })

  it('显示名优先 displayName、回退 nick', () => {
    expect(
      pickUpdateSource(self, [cand({ nodeId: 'a', ver: '0.27.0', caps: ['upd1'], nick: '张三' }, true, '备注名')])
        ?.fromName
    ).toBe('备注名')
    expect(
      pickUpdateSource(self, [cand({ nodeId: 'a', ver: '0.27.0', caps: ['upd1'], nick: '张三' }, true, '')])?.fromName
    ).toBe('张三')
  })
})

describe('自更新请求复核与本地包查找', () => {
  it('只响应同平台、在线、且本机版本更高的请求方', () => {
    const self = { version: '0.28.0', platform: 'linux' as const }
    const requester = { profile: prof({ platform: 'linux', ver: '0.27.5' }), online: true }
    expect(shouldServeUpdateRequest(self, requester, 'linux')).toBe(true)
    expect(shouldServeUpdateRequest(self, { ...requester, online: false }, 'linux')).toBe(false)
    expect(shouldServeUpdateRequest(self, requester, 'win')).toBe(false)
    expect(
      shouldServeUpdateRequest(self, { profile: prof({ platform: 'win', ver: '0.27.5' }), online: true }, 'linux')
    ).toBe(false)
    expect(
      shouldServeUpdateRequest(self, { profile: prof({ platform: 'linux', ver: '0.28.0' }), online: true }, 'linux')
    ).toBe(false)
  })

  it('按平台与版本从候选目录查找安装包', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-update-pkg-'))
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'YangGe-0.28.0-linux-x86_64.AppImage'), 'appimage')
    writeFileSync(join(dir, 'YangGe-0.28.0-linux-amd64.deb'), 'deb')
    writeFileSync(join(dir, 'YangGe-0.28.0-linux-arm64.deb'), 'arm64-deb')
    writeFileSync(join(dir, 'YangGe-0.28.0-win-x64-portable.exe'), 'portable')
    writeFileSync(join(dir, 'YangGe-0.27.9-win-x64-setup.exe'), 'old')
    writeFileSync(join(dir, 'YangGe-0.28.0-win-x64-setup.exe'), 'exe')
    writeFileSync(join(dir, 'YangGe-0.28.0-win-ia32-setup.exe'), 'ia32-exe')

    expect(findLocalUpdatePackage({ dirs: [dir], version: '0.28.0', platform: 'linux', arch: 'x64' })).toBe(
      join(dir, 'YangGe-0.28.0-linux-amd64.deb')
    )
    expect(findLocalUpdatePackage({ dirs: [dir], version: '0.28.0', platform: 'linux', arch: 'arm64' })).toBe(
      join(dir, 'YangGe-0.28.0-linux-arm64.deb')
    )
    expect(findLocalUpdatePackage({ dirs: [dir], version: '0.28.0', platform: 'win', arch: 'x64' })).toBe(
      join(dir, 'YangGe-0.28.0-win-x64-setup.exe')
    )
    expect(findLocalUpdatePackage({ dirs: [dir], version: '0.28.0', platform: 'win', arch: 'ia32' })).toBe(
      join(dir, 'YangGe-0.28.0-win-ia32-setup.exe')
    )
    expect(findLocalUpdatePackage({ dirs: [dir], version: '0.28.0', platform: 'mac' })).toBeNull()
    expect(findLocalUpdatePackage({ dirs: [dir], version: '0.29.0', platform: 'linux', arch: 'x64' })).toBeNull()
  })

  it('安装包名必须精确匹配版本、平台与架构', () => {
    expect(matchesUpdatePackageName('YangGe-0.28.0-win-x64-setup.exe', '0.28.0', 'win', 'x64')).toBe(true)
    expect(matchesUpdatePackageName('YangGe-0.28.0-win-ia32-setup.exe', '0.28.0', 'win', 'ia32')).toBe(true)
    expect(matchesUpdatePackageName('YangGe-0.28.0-win-x64-setup.exe', '0.28.0', 'win', 'ia32')).toBe(false)
    expect(matchesUpdatePackageName('YangGe-0.28.0-linux-amd64.deb', '0.28.0', 'linux', 'x64')).toBe(true)
    expect(matchesUpdatePackageName('YangGe-0.28.0-linux-arm64.deb', '0.28.0', 'linux', 'ia32')).toBe(false)
    expect(matchesUpdatePackageName('YangGe-0.28.0-linux-arm64.deb', '0.28.0', 'linux', 'arm64')).toBe(true)
    expect(matchesUpdatePackageName('copy-YangGe-0.28.0-linux-amd64.deb', '0.28.0', 'linux', 'x64')).toBe(false)
    expect(matchesUpdatePackageName('YangGe-0.28.0-linux-amd64.deb.bak', '0.28.0', 'linux', 'x64')).toBe(false)
    expect(matchesUpdatePackageName('YangGe-0.28.1-win-x64-setup.exe', '0.28.0', 'win', 'x64')).toBe(false)
    expect(matchesUpdatePackageName('YangGe-0.28.0-mac-arm64.dmg', '0.28.0', 'mac', 'arm64')).toBe(false)
  })
})

describe('UpdateRequestGate', () => {
  it('只消费有效期内来源、包名和大小全部匹配的一次 offer', () => {
    const gate = new UpdateRequestGate()
    gate.begin({ nodeId: 'node-a', version: '0.28.0', platform: 'linux', arch: 'x64' }, 1_000)

    expect(gate.consume('node-b', 'YangGe-0.28.0-linux-amd64.deb', 1024, 1_100)).toBe(false)
    expect(gate.consume('node-a', 'YangGe-0.28.0-linux-arm64.deb', 1024, 1_100)).toBe(false)
    expect(gate.consume('node-a', 'YangGe-0.28.0-linux-amd64.deb', 512 * 1024 * 1024 + 1, 1_100)).toBe(false)
    expect(gate.consume('node-a', 'YangGe-0.28.0-linux-amd64.deb', 1024, 1_100)).toBe(true)
    expect(gate.consume('node-a', 'YangGe-0.28.0-linux-amd64.deb', 1024, 1_100)).toBe(false)
  })

  it('授权过期，且旧请求取消不会清掉新请求', () => {
    const gate = new UpdateRequestGate()
    const oldToken = gate.begin({ nodeId: 'node-a', version: '0.28.0', platform: 'win', arch: 'x64' }, 1_000)
    const newToken = gate.begin({ nodeId: 'node-b', version: '0.29.0', platform: 'win', arch: 'x64' }, 2_000)
    gate.cancel(oldToken)

    expect(gate.consume('node-b', 'YangGe-0.29.0-win-x64-setup.exe', 1024, 2_100)).toBe(true)

    gate.begin({ nodeId: 'node-c', version: '0.30.0', platform: 'win', arch: 'x64' }, 3_000)
    expect(gate.consume('node-c', 'YangGe-0.30.0-win-x64-setup.exe', 1024, 123_000)).toBe(false)

    const canceled = gate.begin({ nodeId: 'node-d', version: '0.31.0', platform: 'win', arch: 'x64' }, 4_000)
    expect(canceled).toBeGreaterThan(newToken)
    gate.cancel(canceled)
    expect(gate.consume('node-d', 'YangGe-0.31.0-win-x64-setup.exe', 1024, 4_100)).toBe(false)
  })
})

describe('安装包文件名解析版本（决议 #166 第三步）', () => {
  it('解析 win 安装包版本；带预发布段也支持', () => {
    expect(updatePackageVersionFromName('YangGe-1.3.3-win-x64-setup.exe')).toBe('1.3.3')
    expect(updatePackageVersionFromName('YangGe-1.4.0-beta.2-win-arm64-setup.exe')).toBe('1.4.0-beta.2')
  })

  it('非安装包名 / 改名残留返回 null', () => {
    expect(updatePackageVersionFromName('YangGe-1.3.3-win-x64-setup.exe.bak')).toBe(null)
    expect(updatePackageVersionFromName('报告.pdf')).toBe(null)
    expect(updatePackageVersionFromName('YangGe-1.3.3-win-x64-setup (2).exe')).toBe(null)
  })
})

describe('旧安装包启动清理（决议 #328）', () => {
  it('只挑出版本低于当前的安装包；当前/更高/未知文件保留', () => {
    expect(staleUpdatePackages([
      'YangGe-1.3.3-win-x64-setup.exe',
      'YangGe-1.8.0-win-x64-setup.exe',
      'YangGe-2.0.0-win-x64-setup.exe',
      'YangGe-1.7.1-win-x64-portable.exe',
      '随手记.txt',
      'YangGe-1.8.0-win-x64-setup.exe.blockmap'
    ], '1.8.0')).toEqual([
      'YangGe-1.3.3-win-x64-setup.exe',
      'YangGe-1.7.1-win-x64-portable.exe'
    ])
  })

  it('空目录与全保留场景返回空', () => {
    expect(staleUpdatePackages([], '1.8.0')).toEqual([])
    expect(staleUpdatePackages(['YangGe-1.8.0-win-x64-setup.exe'], '1.8.0')).toEqual([])
  })
})
