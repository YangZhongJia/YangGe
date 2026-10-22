import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { teahouseDarkThemeOverrides, teahouseLightThemeOverrides } from './naive-theme'

const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../SettingsApp.vue', import.meta.url), 'utf8')

describe('Naive UI 茶话间主题', () => {
  it('保持雾蓝主色、紧凑控件和简洁圆角标尺', () => {
    expect(teahouseLightThemeOverrides.common?.primaryColor).toBe('#4e79af')
    expect(teahouseDarkThemeOverrides.common?.primaryColor).toBe('#5d8fd0')
    expect(teahouseLightThemeOverrides.common?.borderRadius).toBe('8px')
    expect(teahouseLightThemeOverrides.Button?.borderRadiusMedium).toBe('6px')
    expect(teahouseLightThemeOverrides.Button?.heightMedium).toBe('34px')
    expect(teahouseLightThemeOverrides.Input?.heightMedium).toBe('34px')
  })

  it('主窗口 Provider 不生成会打断高度链的布局节点', () => {
    expect(appSource).toMatch(/<NConfigProvider\s+abstract\b/)
    expect(appSource).toMatch(/\.shell\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/)
  })

  it('设置保存提示按整个窗口水平居中', () => {
    expect(settingsSource).toMatch(/\.toast\s*\{[^}]*left:\s*50%;/)
    expect(settingsSource).not.toMatch(/\.toast\s*\{[^}]*left:\s*calc\(50%/)
  })
})
