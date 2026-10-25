import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { teahouseDarkThemeOverrides, teahouseLightThemeOverrides } from './naive-theme'
import { ACCENT_PALETTES } from '../utils/accents'

const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../SettingsApp.vue', import.meta.url), 'utf8')

describe('Naive UI 微聊主题（二开：Iris 靛蓝）', () => {
  it('保持靛蓝主色、紧凑控件和圆角标尺，且支持 accent 换装（决议 #327）', () => {
    expect(teahouseLightThemeOverrides().common?.primaryColor).toBe('#5850ec')
    expect(teahouseDarkThemeOverrides().common?.primaryColor).toBe('#7b76f0')
    expect(teahouseLightThemeOverrides().common?.borderRadius).toBe('12px')
    expect(teahouseLightThemeOverrides().Button?.borderRadiusMedium).toBe('6px')
    expect(teahouseLightThemeOverrides().Button?.heightMedium).toBe('34px')
    expect(teahouseLightThemeOverrides().Input?.heightMedium).toBe('34px')
    // 换装：松石 accent 深浅分别取色
    expect(teahouseLightThemeOverrides(ACCENT_PALETTES.teal.light).common?.primaryColor).toBe('#0e9f9a')
    expect(teahouseDarkThemeOverrides(ACCENT_PALETTES.teal.dark).common?.primaryColor).toBe('#2cc0ba')
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
