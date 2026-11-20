import type { Language, TranslationParams } from '../shared/i18n'

let language: Language = 'zh-CN'
let english: Record<string, string> = {}
const extraEnglish: Record<string, string> = {}
let loading: Promise<void> | undefined
let request = 0

export function isLanguage(value: unknown): value is Language {
  return value === 'zh-CN' || value === 'en'
}

export function initialLanguage(existing: boolean, saved: unknown, system: string): Language {
  if (isLanguage(saved)) return saved
  return existing || /^zh(?:[-_]|$)/i.test(system) ? 'zh-CN' : 'en'
}

/** 英文资源仅从本地打包模块加载；后发的语言选择优先。 */
export async function setLanguage(next: Language): Promise<boolean> {
  const id = ++request
  if (next === 'en') {
    loading ??= import('./en').then((module) => { english = { ...module.default, ...extraEnglish } }).catch((error: unknown) => {
      loading = undefined
      throw error
    })
    await loading
  }
  if (id === request) language = next
  return id === request
}

export function getLanguage(): Language {
  return language
}

/** 按需模块可注册额外英文词条，避免把低频功能文案放进公共语言包。 */
export function registerEnglishTranslations(entries: Record<string, string>): void {
  Object.assign(extraEnglish, entries)
  if (language === 'en') Object.assign(english, entries)
}

export function formatTemplate(template: string, params: TranslationParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (token, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : token
  )
}

/** 只接收应用自有模板；参数保持原文，禁止传入聊天正文自动匹配翻译。 */
export function tr(source: string, params?: TranslationParams): string {
  const text = language === 'en' && Object.prototype.hasOwnProperty.call(english, source)
    ? english[source]
    : source
  return formatTemplate(text, params)
}
