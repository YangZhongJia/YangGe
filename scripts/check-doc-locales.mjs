import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DOCUMENT_PAIRS = [
  ['README.md', 'README.en.md'],
  ['CONTRIBUTING.md', 'CONTRIBUTING.en.md'],
  ['DEVELOPMENT.md', 'DEVELOPMENT.en.md'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.en.md'],
  ['docs/README.md', 'docs/en/README.md'],
  ['docs/handoff.md', 'docs/en/handoff.md'],
  ['docs/requirements.md', 'docs/en/requirements.md'],
  ['docs/protocol.md', 'docs/en/protocol.md'],
  ['docs/ui-design.md', 'docs/en/ui-design.md'],
  ['docs/tech-design.md', 'docs/en/tech-design.md'],
  ['docs/nwt-compat-design.md', 'docs/en/nwt-compat-design.md'],
  ['docs/optimization-plan.md', 'docs/en/optimization-plan.md']
]

function localMarkdownTargets(markdown) {
  const targets = []
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g
  let match
  while ((match = pattern.exec(markdown)) !== null) {
    let target = match[1].trim()
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue
    target = target.split('#', 1)[0]
    if (!target) continue
    targets.push(decodeURIComponent(target))
  }
  return targets
}

export function verifyDocumentationLocales(rootDir, pairs = DOCUMENT_PAIRS) {
  const errors = []

  for (const [chineseRelative, englishRelative] of pairs) {
    const chinesePath = resolve(rootDir, chineseRelative)
    const englishPath = resolve(rootDir, englishRelative)
    if (!existsSync(chinesePath)) errors.push(`缺少中文文档：${chineseRelative}`)
    if (!existsSync(englishPath)) errors.push(`缺少英文文档：${englishRelative}`)
    if (!existsSync(chinesePath) || !existsSync(englishPath)) continue

    const chinese = readFileSync(chinesePath, 'utf8')
    const english = readFileSync(englishPath, 'utf8')
    const expectedEnglishLink = englishRelative.startsWith('docs/en/')
      ? `en/${englishRelative.slice('docs/en/'.length)}`
      : englishRelative
    const expectedChineseLink = englishRelative.startsWith('docs/en/')
      ? `../${chineseRelative.slice('docs/'.length)}`
      : chineseRelative

    if (!chinese.includes(expectedEnglishLink)) {
      errors.push(`${chineseRelative} 缺少英文入口 ${expectedEnglishLink}`)
    }
    if (!english.includes(expectedChineseLink)) {
      errors.push(`${englishRelative} 缺少中文入口 ${expectedChineseLink}`)
    }
    if (english.split('\n').length < 20) {
      errors.push(`${englishRelative} 内容过短，未形成可用英文文档`)
    }

    for (const target of localMarkdownTargets(english)) {
      const absoluteTarget = resolve(dirname(englishPath), target)
      if (!existsSync(absoluteTarget)) {
        errors.push(`${englishRelative} 含无效本地链接：${target}`)
      }
    }
  }

  return errors
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const errors = verifyDocumentationLocales(rootDir)
  if (errors.length > 0) {
    console.error(`文档多语言校验失败（${errors.length} 项）：`)
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
  } else {
    console.log(`文档多语言校验通过：${DOCUMENT_PAIRS.length} 组中英文文档，英文本地链接有效。`)
  }
}
