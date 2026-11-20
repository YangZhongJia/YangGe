import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { PiConfigSuggestion, PiRouterView } from '../../../shared/ipc'

type Json = Record<string, unknown>

function readJson(path: string): Json | Json[] | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as Json | Json[]
  } catch {
    return null
  }
}

function object(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(string).filter(Boolean))]
}

function customRouter(
  name: string,
  baseUrl: string,
  apiKey: string,
  api: PiRouterView['api'],
  models: string[],
  modelId = ''
): PiRouterView | null {
  if (!baseUrl || !apiKey || models.length === 0) return null
  return {
    mode: 'custom',
    name,
    api,
    baseUrl,
    apiKey,
    modelId: models.includes(modelId) ? modelId : models[0],
    models
  }
}

function add(list: PiConfigSuggestion[], item: PiConfigSuggestion): void {
  const router = item.router
  const fingerprint = `${router.baseUrl}|${router.apiKey}|${router.models.join(',')}`
  if (list.some((existing) => {
    const other = existing.router
    return `${other.baseUrl}|${other.apiKey}|${other.models.join(',')}` === fingerprint
  })) return
  list.push(item)
}

function scanPiSwitch(list: PiConfigSuggestion[]): void {
  const data = object(readJson(join(homedir(), '.pi-switch', 'config.json')))
  if (!data) return
  const profiles = object(data.profiles)
  if (!profiles) return
  const current = string(data.current)
  const names = Object.keys(profiles).sort((a, b) => Number(b === current) - Number(a === current))
  for (const key of names) {
    const profile = object(profiles[key])
    if (!profile) continue
    const models = Array.isArray(profile.models)
      ? strings(profile.models.map((item) => object(item)?.id))
      : strings(profile.models)
    const router = customRouter(
      key,
      string(profile.baseUrl),
      string(profile.apiKey),
      profile.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
      models
    )
    if (!router) continue
    add(list, {
      id: `pi-switch:${key}`,
      source: 'pi-switch',
      label: `pi-switch · ${key}`,
      detail: `${router.baseUrl.replace(/^https?:\/\//, '')} · ${router.models.length} 个模型`,
      router
    })
  }
}

function scanClaudeSettings(list: PiConfigSuggestion[]): void {
  const data = object(readJson(join(homedir(), '.claude', 'settings.json')))
  const env = object(data?.env)
  if (!env) return
  const baseUrl = string(env.ANTHROPIC_BASE_URL)
  const apiKey = string(env.ANTHROPIC_AUTH_TOKEN) || string(env.ANTHROPIC_API_KEY)
  const models = strings(
    Object.entries(env)
      .filter(([key]) => /^ANTHROPIC_DEFAULT_.+_MODEL$/.test(key))
      .map(([, value]) => value)
  )
  const router = customRouter('Claude Code', baseUrl, apiKey, 'anthropic-messages', models)
  if (!router) return
  add(list, {
    id: 'claude:settings',
    source: 'claude',
    label: 'Claude Code 设置',
    detail: `${router.baseUrl.replace(/^https?:\/\//, '')} · ${router.models.length} 个模型`,
    router
  })
}

function scanMagpie(list: PiConfigSuggestion[]): void {
  const gateway = object(readJson(join(homedir(), '.config', 'magpie', 'gateway.json')))
  if (!gateway) return
  const addr = string(gateway.addr) || '127.0.0.1:3425'
  const applied = object(readJson(join(homedir(), '.config', 'magpie', 'applied.json')))
  const pi = object(applied?.pi)
  const fields = object(pi?.fields)
  const appliedModel = string(fields?.model)
  const modelId = appliedModel.startsWith('magpie/') ? appliedModel.slice('magpie/'.length) : ''
  add(list, {
    id: 'magpie:gateway',
    source: 'magpie',
    label: 'Magpie 本地网关',
    detail: addr,
    router: {
      mode: 'magpie',
      name: 'Magpie',
      api: 'openai-completions',
      baseUrl: `http://${addr.replace(/^https?:\/\//, '')}/v1`,
      apiKey: 'magpie',
      modelId,
      models: []
    }
  })
}

function scanCcSwitch(list: PiConfigSuggestion[]): void {
  const file = join(homedir(), '.cc-switch', 'cc-switch.db')
  if (!existsSync(file)) return
  let db: Database.Database | null = null
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    const rows = db
      .prepare('select id, app_type, name, settings_config, is_current from providers')
      .all() as Array<Record<string, unknown>>
    for (const row of rows) {
      const id = string(row.id)
      const appType = string(row.app_type)
      const name = string(row.name) || id
      if (!id || !row.settings_config) continue
      let settings: Json
      try {
        settings = JSON.parse(String(row.settings_config)) as Json
      } catch {
        continue
      }
      const current = Number(row.is_current) === 1
      let router: PiRouterView | null = null
      if (appType === 'pi') {
        const models = Array.isArray(settings.models)
          ? strings(settings.models.map((item) => object(item)?.id))
          : []
        router = customRouter(
          name,
          string(settings.baseUrl),
          string(settings.apiKey),
          settings.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
          models
        )
      } else if (appType === 'opencode') {
        const options = object(settings.options)
        const modelMap = object(settings.models)
        router = customRouter(
          name,
          string(options?.baseURL),
          string(options?.apiKey),
          'openai-completions',
          modelMap ? Object.keys(modelMap) : []
        )
      } else if (appType === 'claude') {
        const env = object(settings.env)
        const models = env
          ? strings(
              Object.entries(env)
                .filter(([key]) => /^ANTHROPIC_DEFAULT_.+_MODEL$/.test(key))
                .map(([, value]) => value)
            )
          : []
        router = customRouter(
          name,
          string(env?.ANTHROPIC_BASE_URL),
          string(env?.ANTHROPIC_AUTH_TOKEN) || string(env?.ANTHROPIC_API_KEY),
          'anthropic-messages',
          models
        )
      }
      if (!router) continue
      add(list, {
        id: `cc-switch:${id}`,
        source: 'cc-switch',
        label: `${current ? '当前 · ' : ''}cc-switch · ${name}`,
        detail: `${router.baseUrl.replace(/^https?:\/\//, '')} · ${router.models.length} 个模型`,
        router
      })
    }
  } catch {
    // 数据库被 cc-switch 占用或版本不兼容时，继续扫描其他来源。
  } finally {
    try {
      db?.close()
    } catch {
      // ignore
    }
  }
}

export function scanPiConfigs(): PiConfigSuggestion[] {
  const list: PiConfigSuggestion[] = []
  scanPiSwitch(list)
  scanCcSwitch(list)
  scanMagpie(list)
  scanClaudeSettings(list)
  return list.slice(0, 20)
}
