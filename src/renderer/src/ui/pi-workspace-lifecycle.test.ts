import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../../main/index.ts', import.meta.url), 'utf8')

describe('Pi 工作区生命周期', () => {
  it('主窗切页签时保留 Pi 组件，历史与工具执行不被销毁', () => {
    expect(appSource).toMatch(/<KeepAlive>[\s\S]*?<component\s+:is="PiWorkspacePane"[\s\S]*?<\/KeepAlive>/)
  })

  it('Pi 页不再同时渲染聊天空态，保持完整工作区高度', () => {
    expect(appSource).toContain('tab === \'chat\' || (tab === \'contacts\' && !selectedPeer)')
  })

  it('锁屏未解除时不加载 Pi，也不启动后台会话', () => {
    expect(appSource).toContain('next === \'pi\' && !appLocked.value')
    expect(appSource).toMatch(/:is="PiWorkspacePane"[^>]*v-show="tab === 'pi' && !appLocked"/)
    expect(mainSource).toMatch(/IpcChannels\.piStart[\s\S]{0,200}lockScreenActive/)
    expect(mainSource).toMatch(/IpcChannels\.piPrompt[\s\S]{0,100}lockScreenActive/)
  })
})
