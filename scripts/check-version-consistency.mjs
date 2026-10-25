import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function collectFiles(dir) {
  const files = []
  for (const name of readdirSync(dir).sort()) {
    const path = resolve(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...collectFiles(path))
    else if (stat.isFile()) files.push(name)
  }
  return files
}

export function checkVersionConsistency({ root = process.cwd(), artifactsDir, env = process.env } = {}) {
  const pkg = readJson(resolve(root, 'package.json'))
  const lock = readJson(resolve(root, 'package-lock.json'))
  const version = pkg.version
  const errors = []

  if (lock.version !== version) {
    errors.push(`package-lock.json 顶层版本 ${String(lock.version)} 与 package.json ${version} 不一致`)
  }
  const rootLockVersion = lock.packages?.['']?.version
  if (rootLockVersion !== version) {
    errors.push(`package-lock.json 根包版本 ${String(rootLockVersion)} 与 package.json ${version} 不一致`)
  }

  if (env.GITHUB_REF_TYPE === 'tag') {
    const expectedTag = `v${version}`
    if (env.GITHUB_REF_NAME !== expectedTag) {
      errors.push(`Git tag ${String(env.GITHUB_REF_NAME)} 与期望 ${expectedTag} 不一致`)
    }
  }

  if (artifactsDir) {
    const expectedPrefix = `YangGe-${version}-`
    for (const name of collectFiles(resolve(artifactsDir))) {
      if (name.startsWith('YangGe-') && !name.startsWith(expectedPrefix)) {
        errors.push(`产物文件名 ${name} 未使用版本前缀 ${expectedPrefix}`)
      }
    }
  }

  return { version, errors }
}

function parseArtifactsArg(argv) {
  const index = argv.indexOf('--artifacts')
  if (index < 0) return undefined
  const dir = argv[index + 1]
  if (!dir) throw new Error('--artifacts 缺少目录参数')
  return dir
}

function main() {
  const artifactsDir = parseArtifactsArg(process.argv.slice(2))
  const result = checkVersionConsistency({ artifactsDir })
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`[version] ${error}`)
    process.exitCode = 1
    return
  }
  console.log(`[version] ${result.version} 一致性检查通过`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
