import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addSharedScanRanges, importScanRanges, loadAppState, saveAppSettings, saveProfile, saveProfileCaps, type ProfilePatch } from './app-state'

const directories: string[] = []

function makeState() {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-profile-'))
  directories.push(directory)
  return loadAppState(directory, '0.0.0-test')
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('批量添加扫描网段', () => {
  it('按当前状态合并，保留预览后同步到的网段和来源，重启后仍存在', () => {
    const state = makeState()
    saveAppSettings(state, { scanRanges: ['10.1.0.0/24'] })
    addSharedScanRanges(state, [{ cidr: '10.2.0.0/24', addedAt: Date.now() }], { nodeId: 'peer', name: '同事' })
    const source = { ...state.config.scanRangeSources['10.2.0.0/24'] }
    expect(importScanRanges(state, '10.1.0.88/24\n10.3.0.88/24')).toEqual({ ok: true, added: 1 })
    expect(state.config.scanRanges).toEqual(['10.1.0.0/24', '10.2.0.0/24', '10.3.0.0/24'])
    expect(state.config.scanRangeSources['10.2.0.0/24']).toEqual(source)
    expect(state.config.scanRangeSources['10.3.0.0/24'].source).toBe('self')
    expect(loadAppState(directories[0], '0.0.0-test').config.scanRanges).toEqual(state.config.scanRanges)
  })

  it('发现非法输入或总额度已被同期同步占用时整批拒绝，不改变内存或磁盘', () => {
    const state = makeState()
    saveAppSettings(state, { scanRanges: Array.from({ length: 20 }, (_, i) => `10.${i}.0.0/24`) })
    const before = JSON.stringify(state.config)
    const saved = readFileSync(state.configPath, 'utf8')
    expect(importScanRanges(state, '10.40.0.0/24')).toEqual({ ok: false, reason: 'too-many' })
    expect(importScanRanges(state, '10.40.0.0/24\ninvalid')).toEqual({ ok: false, reason: 'invalid' })
    expect(importScanRanges(state, ['10.40.0.0/24'])).toEqual({ ok: false, reason: 'invalid' })
    expect(JSON.stringify(state.config)).toBe(before)
    expect(readFileSync(state.configPath, 'utf8')).toBe(saved)
  })

  it('重新手动导入会清除移除忽略标记，不改变已有来源', () => {
    const state = makeState()
    saveAppSettings(state, { scanRanges: ['10.1.0.0/24'] })
    saveAppSettings(state, { scanRanges: [] })
    expect(state.config.ignoredScanRanges['10.1.0.0/24']).toBeGreaterThan(0)
    expect(importScanRanges(state, '10.1.0.1/24')).toEqual({ ok: true, added: 1 })
    expect(state.config.ignoredScanRanges['10.1.0.0/24']).toBeUndefined()
  })
})

describe('资料版本与持久化', () => {
  it('能力变化持久化递增版本，保留向导状态，重启后继续递增', () => {
    const state = makeState()
    expect(saveProfileCaps(state, ['rv1', 'rvs1'])).toBe(true)
    expect(state.profile.profileRev).toBe(2)
    expect(state.config.setupDone).toBe(false)
    const saved = readFileSync(state.configPath, 'utf8')
    expect(JSON.parse(saved)).toMatchObject({ profileRev: 2, setupDone: false })
    expect(saveProfileCaps(state, ['rv1', 'rvs1'])).toBe(false)
    expect(readFileSync(state.configPath, 'utf8')).toBe(saved)

    saveProfile(state, { ...state.config, company: '新公司' })
    expect(state.profile).toMatchObject({ company: '新公司', profileRev: 3, caps: ['rv1', 'rvs1'] })
    const reloaded = loadAppState(directories[0], '0.0.0-test')
    expect(reloaded.profile.profileRev).toBe(3)
    expect(saveProfileCaps(reloaded, ['rv1'])).toBe(true)
    expect(reloaded.profile.profileRev).toBe(4)
    expect(JSON.parse(readFileSync(reloaded.configPath, 'utf8')).profileRev).toBe(4)
  })

  it.each<Partial<ProfilePatch>>([
    { company: '新公司' }, { dept: '新部门' }, { team: '新团队' },
    { avatar: 3 }, { avatarHash: 'a'.repeat(64) }, { nick: '新昵称' }
  ])('运行中版本领先时，独立修改 %j 仍递增并保存', (patch) => {
    const state = makeState()
    const liveProfile = state.profile
    // 复现旧版能力更新仅推进运行中版本的状态。
    state.profile.profileRev += 2
    const previousRev = state.profile.profileRev

    saveProfile(state, { ...state.config, ...patch })

    expect(state.profile).toBe(liveProfile)
    expect(state.profile).toMatchObject({ ...patch, profileRev: previousRev + 1 })
    expect(JSON.parse(readFileSync(state.configPath, 'utf8')).profileRev).toBe(previousRev + 1)
    expect(loadAppState(directories[0], '0.0.0-test').profile).toMatchObject(state.profile)
  })

  it('只改保存目录或重复保存时保留运行中版本，不回退也不额外递增', () => {
    const state = makeState()
    state.profile.profileRev += 2
    const previousRev = state.profile.profileRev
    saveProfile(state, { ...state.config, fileDir: '/tmp/profile-files' })
    saveProfile(state, { ...state.config })
    expect(state.profile.profileRev).toBe(previousRev)
    expect(state.config.profileRev).toBe(previousRev)
    expect(JSON.parse(readFileSync(state.configPath, 'utf8')).profileRev).toBe(previousRev)
  })
})
