import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../SettingsApp.vue', import.meta.url), 'utf8')

describe('个人资料入口交互', () => {
  it('设置侧栏直接展示分组导航', () => {
    expect(settingsSource).not.toContain('class="account-card"')
    expect(settingsSource).not.toContain('.account-card')
    expect(settingsSource).toMatch(/<aside class="sidebar">[\s\S]*?<nav class="nav"/)
    expect(settingsSource).toContain('class="avatar-editor"')
  })

  it('头像与资料卡形成连续悬停范围并快速显示', () => {
    const bridgeRule = appSource.match(/\.avatar-wrap::after \{[\s\S]*?\n\}/)?.[0] ?? ''
    const bridgeHoverRule = appSource.match(/\.avatar-wrap:hover::after \{[\s\S]*?\n\}/)?.[0] ?? ''
    const cardHoverRule = appSource.match(/\.avatar-wrap:hover \.self-card \{[\s\S]*?\n\}/)?.[0] ?? ''

    expect(bridgeRule).toContain('pointer-events: none')
    expect(bridgeRule).toContain('left: 38px')
    expect(bridgeRule).toContain('width: 18px')
    expect(bridgeHoverRule).toContain('pointer-events: auto')
    expect(cardHoverRule).toContain('pointer-events: auto')
    expect(cardHoverRule).toContain('transition-delay: 120ms, 120ms, 0s')
    expect(appSource).not.toContain('transition-delay: 420ms')
  })
})
