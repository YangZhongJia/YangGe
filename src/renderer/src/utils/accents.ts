import type { AccentPalette } from '../ui/naive-theme'

/** 主题色换装（决议 #327）：五套预设主色，深浅主题分别取色 */
export type Accent = 'indigo' | 'teal' | 'rose' | 'amber' | 'forest'

export const ACCENT_IDS: Accent[] = ['indigo', 'teal', 'rose', 'amber', 'forest']

export const ACCENT_PALETTES: Record<Accent, { light: AccentPalette; dark: AccentPalette }> = {
  indigo: {
    light: { primary: '#5850ec', hover: '#4f46dc', pressed: '#4338c9' },
    dark: { primary: '#7b76f0', hover: '#8d89f5', pressed: '#6a64e8' }
  },
  teal: {
    light: { primary: '#0e9f9a', hover: '#0c8b87', pressed: '#0b7f7b' },
    dark: { primary: '#2cc0ba', hover: '#3ecfcc', pressed: '#26a8a2' }
  },
  rose: {
    light: { primary: '#d6407e', hover: '#c2386f', pressed: '#ab3163' },
    dark: { primary: '#e8709f', hover: '#ef85ad', pressed: '#d75b8e' }
  },
  amber: {
    light: { primary: '#b06f10', hover: '#9c6109', pressed: '#885408' },
    dark: { primary: '#e0a53c', hover: '#e6b355', pressed: '#d19630' }
  },
  forest: {
    light: { primary: '#2f8a5d', hover: '#297a52', pressed: '#246c49' },
    dark: { primary: '#4fb98a', hover: '#63c79b', pressed: '#44a97b' }
  }
}

export function normalizeAccent(value: unknown): Accent {
  return ACCENT_IDS.includes(value as Accent) ? (value as Accent) : 'indigo'
}

export function accentPalette(accent: Accent | undefined, dark: boolean): AccentPalette {
  const id = normalizeAccent(accent)
  return ACCENT_PALETTES[id][dark ? 'dark' : 'light']
}
