import type { SettingsView } from '../../../shared/ipc'

export type EffectiveTheme = 'light' | 'dark'

/** 主题跟随系统（决议 #327）：auto 时读系统偏好 */
export function resolveTheme(theme: SettingsView['theme'] | undefined): EffectiveTheme {
  if (theme === 'auto') {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  }
  return theme === 'dark' ? 'dark' : 'light'
}

export function applyAppearance(
  settings: Pick<SettingsView, 'theme' | 'accent' | 'chatBackground'>
): void {
  document.documentElement.dataset.theme = resolveTheme(settings.theme)
  document.documentElement.dataset.accent = settings.accent ?? 'indigo'
  document.documentElement.dataset.chatBg = settings.chatBackground ?? 'plain'
  // 字体倍率由主进程 webContents.setZoomFactor 统一应用（决议 #257）。
  // 清理热更新或旧 renderer 留下的 inline CSS zoom，避免它参与输入法坐标换算。
  document.body.style.removeProperty('zoom')
}
