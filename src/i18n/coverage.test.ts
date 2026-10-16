import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'
import { baseParse } from '@vue/compiler-dom'
import { expect, it } from 'vitest'
import english from './en'
import { TRANSFER_FAILURE_TEXT } from './transfers'
import { COMPAT_EMOJIS } from '../shared/compat-emoji'
import { SHARE_FAIL_TEXT, SHARE_ROOT_REJECT_TEXT, SHARE_UPLOAD_FAIL_TEXT } from '../shared/ipc'
import { QUOTES } from '../renderer/src/utils/quotes'
import { AVATAR_COLORS } from '../renderer/src/utils/avatar'

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const han = /[\u3400-\u9fff]/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name)
    if (item.isDirectory()) return item.name === 'assets' ? [] : sourceFiles(path)
    return /\.(vue|ts)$/.test(item.name) && !/\.test\.|selftest/.test(item.name) ? [path] : []
  })
}

it('所有静态调用与动态应用标签均有英文模板', () => {
  const missing: string[] = []
  const check = (key: string): void => {
    if (han.test(key) && !Object.prototype.hasOwnProperty.call(english, key)) missing.push(key)
  }
  const script = (code: string): void => {
    const ast = ts.createSourceFile('text.ts', code, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ['tr', 'translate'].includes(node.expression.getText(ast)) &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text)
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  for (const file of sourceFiles(sourceRoot)) {
    const code = readFileSync(file, 'utf8')
    if (!file.endsWith('.vue')) { script(code); continue }
    const descriptor = parse(code).descriptor
    if (descriptor.scriptSetup) script(descriptor.scriptSetup.content)
    // 模板属性中的表达式独立解析，避免 HTML 干扰 TypeScript AST。
    if (descriptor.template) {
      const visit = (node: ReturnType<typeof baseParse> | ReturnType<typeof baseParse>['children'][number]): void => {
        if (node.type === 1) for (const prop of node.props) if (prop.type === 7 && prop.exp?.type === 4) script(prop.exp.content)
        if (node.type === 5 && node.content.type === 4) script(node.content.content)
        if (node.type === 0 || node.type === 1) for (const child of node.children) visit(child)
      }
      visit(baseParse(descriptor.template.content))
    }
  }
  for (const item of COMPAT_EMOJIS) check(item.label)
  for (const item of AVATAR_COLORS) check(item.name)
  for (const item of QUOTES) { check(item.text); check(item.author) }
  for (const table of [SHARE_FAIL_TEXT, SHARE_ROOT_REJECT_TEXT, SHARE_UPLOAD_FAIL_TEXT, TRANSFER_FAILURE_TEXT]) Object.values(table).forEach(check)
  expect([...new Set(missing)]).toEqual([])
})

it('Vue 可见静态中文与无障碍/工具提示属性均经过语言函数', () => {
  const missing: string[] = []
  for (const file of sourceFiles(join(sourceRoot, 'renderer')).filter((file) => file.endsWith('.vue'))) {
    const template = parse(readFileSync(file, 'utf8')).descriptor.template
    if (!template) continue
    const check = (text: string): void => {
      if (han.test(text) && text.trim() !== '语言 / Language') missing.push(`${file}: ${text}`)
    }
    const visit = (node: ReturnType<typeof baseParse> | ReturnType<typeof baseParse>['children'][number]): void => {
      if (node.type === 2) check(node.content)
      if (node.type === 1) for (const prop of node.props) if (prop.type === 6 && prop.value) check(prop.value.content)
      if (node.type === 0 || node.type === 1) for (const child of node.children) visit(child)
    }
    visit(baseParse(template.content))
  }
  expect(missing).toEqual([])
})
