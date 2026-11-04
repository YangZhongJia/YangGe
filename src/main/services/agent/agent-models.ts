import type { AgentModelList, AgentModelOption } from '../../../shared/ipc'

// ACP 模型清单解析：兼容两种协商形态。
// 1) 旧版 models：{ availableModels: [{ modelId, name, description }], currentModelId }
// 2) 配置项 configOptions：{ id: 'model', options: [{ value, name, description }], currentValue }
//    （OpenCode / omp / DeepSeek Harness 走这一种）

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeOption(item: Record<string, unknown>, idKey: string): AgentModelOption | null {
  const id = typeof item[idKey] === 'string' ? item[idKey].trim() : ''
  if (!id) return null
  const name = typeof item['name'] === 'string' && item['name'].trim() ? item['name'].trim() : id
  const description = typeof item['description'] === 'string' ? item['description'] : ''
  return { id, name, description }
}

export function parseAgentModels(session: {
  models?: unknown
  configOptions?: unknown
}): AgentModelList | null {
  const models = toRecord(session.models)
  if (models) {
    const available = Array.isArray(models['availableModels']) ? models['availableModels'] : []
    const options = available
      .map((item) => toRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => normalizeOption(item, 'modelId'))
      .filter((item): item is AgentModelOption => item !== null)
    if (options.length > 0) {
      const current = typeof models['currentModelId'] === 'string' ? models['currentModelId'] : ''
      return { models: dedupe(options), currentModel: current }
    }
  }

  const configs = Array.isArray(session.configOptions) ? session.configOptions : []
  const modelConfig = configs
    .map((item) => toRecord(item))
    .find((item) => item !== null && item['id'] === 'model')
  if (modelConfig) {
    const raw = Array.isArray(modelConfig['options']) ? modelConfig['options'] : []
    const options = raw
      .map((item) => toRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => normalizeOption(item, 'value'))
      .filter((item): item is AgentModelOption => item !== null)
    if (options.length > 0) {
      const current =
        typeof modelConfig['currentValue'] === 'string' ? modelConfig['currentValue'] : ''
      return { models: dedupe(options), currentModel: current }
    }
  }

  return null
}

function dedupe(options: AgentModelOption[]): AgentModelOption[] {
  const seen = new Set<string>()
  const result: AgentModelOption[] = []
  for (const option of options) {
    if (seen.has(option.id)) continue
    seen.add(option.id)
    result.push(option)
  }
  return result
}
