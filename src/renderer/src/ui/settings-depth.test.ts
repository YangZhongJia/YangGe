import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../SettingsApp.vue', import.meta.url), 'utf8')

describe('设置窗口视觉层级', () => {
  it('主窗口订阅设置窗状态并用纯色 scrim 阻断交互', () => {
    expect(appSource).toContain('onSettingsWindowState')
    expect(appSource).toContain('v-if="settingsWindowOpen" class="settings-scrim"')

    const scrimRule = appSource.match(/\.settings-scrim \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(scrimRule).toContain('pointer-events: auto')
    expect(scrimRule).toContain('background: rgba(22, 34, 52, 0.24)')
    expect(scrimRule).not.toContain('backdrop-filter')
  })

  it('设置窗口用顶层内描边提供平台无关边界', () => {
    expect(settingsSource).toContain('.settings::after')
    expect(settingsSource).toContain('inset 0 0 0 1px rgba(45, 63, 88, 0.26)')
    expect(settingsSource).toContain('inset 0 0 0 1px rgba(255, 255, 255, 0.18)')
    expect(settingsSource).toContain('pointer-events: none')
  })
})
