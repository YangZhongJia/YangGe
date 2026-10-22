import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const settingsSource = readFileSync(new URL('../SettingsApp.vue', import.meta.url), 'utf8')
const iconSource = readFileSync(new URL('../components/SettingsNavIcon.vue', import.meta.url), 'utf8')
const sharedIconSource = readFileSync(new URL('../components/PantryIcon.vue', import.meta.url), 'utf8')

const iconNames = [
  'settings-profile',
  'settings-general',
  'settings-notify',
  'settings-storage',
  'settings-network',
  'settings-shortcuts',
  'settings-about'
]

describe('设置分组导航图标', () => {
  it('七个设置分组都有固定语义图标', () => {
    for (const name of iconNames) {
      expect(settingsSource).toContain(`icon: '${name}'`)
      expect(iconSource).toContain(`name === '${name}'`)
    }
    expect(settingsSource.match(/icon: 'settings-/g)).toHaveLength(7)
    expect(settingsSource).toContain(
      '<SettingsNavIcon class="nav-icon" :name="item.icon" :size="24" />'
    )
    expect(sharedIconSource).not.toContain("name === 'settings-profile'")
  })

  it('图标与文字同一行并继承导航状态颜色', () => {
    const navButtonRule = settingsSource.match(/\.nav button \{[\s\S]*?\n\}/)?.[0] ?? ''
    const navIconRule = settingsSource.match(/\.nav-icon \{[\s\S]*?\n\}/)?.[0] ?? ''

    expect(navButtonRule).toContain('display: flex')
    expect(navButtonRule).toContain('align-items: center')
    expect(navButtonRule).toContain('gap: 9px')
    expect(navIconRule).not.toContain('color:')
    expect(settingsSource).toMatch(/\.nav button\.on \{[\s\S]*?color: var\(--primary\)/)
  })
})
