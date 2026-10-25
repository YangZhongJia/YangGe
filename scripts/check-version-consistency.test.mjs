import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkVersionConsistency } from './check-version-consistency.mjs'

const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(packageVersion = '1.2.3', lockVersion = packageVersion) {
  const root = mkdtempSync(join(tmpdir(), 'pantry-version-check-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pantry', version: packageVersion }))
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ name: 'pantry', version: lockVersion, packages: { '': { name: 'pantry', version: lockVersion } } })
  )
  return root
}

describe('checkVersionConsistency', () => {
  it('package、lock、tag 与产物版本一致时通过', () => {
    const root = fixture()
    const artifacts = join(root, 'artifacts', 'linux')
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(join(artifacts, 'YangGe-1.2.3-linux-amd64.deb'), 'deb')
    writeFileSync(join(artifacts, 'SHA256SUMS.txt'), 'sum')

    expect(
      checkVersionConsistency({
        root,
        artifactsDir: join(root, 'artifacts'),
        env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3' }
      })
    ).toEqual({ version: '1.2.3', errors: [] })
  })

  it('报告 lockfile 顶层与根包版本漂移', () => {
    const root = fixture('1.2.3', '1.2.2')
    const result = checkVersionConsistency({ root, env: {} })

    expect(result.errors).toContain('package-lock.json 顶层版本 1.2.2 与 package.json 1.2.3 不一致')
    expect(result.errors).toContain('package-lock.json 根包版本 1.2.2 与 package.json 1.2.3 不一致')
  })

  it('报告 Git tag 与包版本漂移', () => {
    const root = fixture()
    const result = checkVersionConsistency({
      root,
      env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.2' }
    })

    expect(result.errors).toEqual(['Git tag v1.2.2 与期望 v1.2.3 不一致'])
  })

  it('递归报告 Teahouse 产物文件名版本漂移', () => {
    const root = fixture()
    const artifacts = join(root, 'artifacts', 'windows')
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(join(artifacts, 'YangGe-1.2.2-win-x64-setup.exe'), 'exe')

    const result = checkVersionConsistency({ root, artifactsDir: join(root, 'artifacts'), env: {} })

    expect(result.errors).toEqual([
      '产物文件名 YangGe-1.2.2-win-x64-setup.exe 未使用版本前缀 YangGe-1.2.3-'
    ])
  })
})
