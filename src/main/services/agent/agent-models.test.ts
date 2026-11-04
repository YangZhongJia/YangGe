import { describe, expect, it } from 'vitest'
import { parseAgentModels } from './agent-models'

describe('ACP 模型清单解析', () => {
  it('读取 Codex 旧版 models.availableModels', () => {
    expect(
      parseAgentModels({
        models: {
          currentModelId: 'gpt-6.1-sol[low]',
          availableModels: [
            { modelId: 'gpt-6.1-sol[low]', name: '6.1 Sol (low)', description: 'fast' },
            { modelId: 'gpt-6.1-sol[high]', name: '6.1 Sol (high)' }
          ]
        }
      })
    ).toEqual({
      currentModel: 'gpt-6.1-sol[low]',
      models: [
        { id: 'gpt-6.1-sol[low]', name: '6.1 Sol (low)', description: 'fast' },
        { id: 'gpt-6.1-sol[high]', name: '6.1 Sol (high)', description: '' }
      ]
    })
  })

  it('读取 configOptions 里的 model 选项（OpenCode / omp / DeepSeek Harness）', () => {
    expect(
      parseAgentModels({
        configOptions: [
          { id: 'mode', options: [{ value: 'default', name: 'Default' }] },
          {
            id: 'model',
            currentValue: 'deepseek/deepseek-flash',
            options: [
              { value: 'deepseek/deepseek-flash', name: 'DeepSeek Flash' },
              { value: 'opencode/claude-opus-4-5', name: 'Claude Opus 4.5' },
              { value: 'deepseek/deepseek-flash', name: '重复项' }
            ]
          }
        ]
      })
    ).toEqual({
      currentModel: 'deepseek/deepseek-flash',
      models: [
        { id: 'deepseek/deepseek-flash', name: 'DeepSeek Flash', description: '' },
        { id: 'opencode/claude-opus-4-5', name: 'Claude Opus 4.5', description: '' }
      ]
    })
  })

  it('没有模型协商时返回 null', () => {
    expect(parseAgentModels({})).toBeNull()
    expect(parseAgentModels({ configOptions: [{ id: 'mode', options: [] }] })).toBeNull()
  })
})
