import { tr } from '../../i18n'
import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { IpcEvents, type SettingsView } from '../../shared/ipc'
import { resolveDevRendererUrl } from '../util/renderer-url'
import { applyWindowZoom } from '../util/window-zoom'

// 设置独立小窗（决议 #3 审美轮）：640×480，左分组导航；
// 复用同一渲染包，经 #/settings 哈希路由挂载 SettingsApp。

const SETTINGS_WIDTH = 640
const SETTINGS_HEIGHT = 480

let win: BrowserWindow | null = null
let currentFontScale: SettingsView['fontScale'] = 100

/**
 * 设置窗居中到主窗几何中心（决议 #123），而非屏幕中心——主窗被拖到副屏/角落时，
 * 设置窗仍跟随主窗弹出。结果夹取到主窗所在显示器工作区，避免主窗贴边或小屏时越界。
 * 主窗不可用时回退为 Electron 默认屏幕居中。
 */
function centeredOverParent(
  parent: BrowserWindow | null
): { x: number; y: number } | Record<string, never> {
  if (!parent || parent.isDestroyed()) return {}
  const p = parent.getBounds()
  const area = screen.getDisplayMatching(p).workArea
  const cx = Math.round(p.x + (p.width - SETTINGS_WIDTH) / 2)
  const cy = Math.round(p.y + (p.height - SETTINGS_HEIGHT) / 2)
  return {
    x: Math.max(area.x, Math.min(cx, area.x + area.width - SETTINGS_WIDTH)),
    y: Math.max(area.y, Math.min(cy, area.y + area.height - SETTINGS_HEIGHT))
  }
}

/** Linux 窗口图标（决议 #58）：与主窗同款，任务栏不依赖 desktop 关联 */
function linuxWindowIcon(): { icon: string } | Record<string, never> {
  if (process.platform !== 'linux') return {}
  const icon = app.isPackaged
    ? join(process.resourcesPath, 'icons/pantry.png')
    : join(app.getAppPath(), 'build/icons/linux/256x256.png')
  return { icon }
}

/**
 * Windows / Linux 的无边框设置窗需要显式层级反馈（决议 #222）。事件只发给主窗，
 * 父窗或 webContents 已销毁时直接跳过，避免退出阶段访问失效对象。
 */
function notifySettingsWindowState(parent: BrowserWindow | null, open: boolean): void {
  if (
    process.platform === 'darwin' ||
    !parent ||
    parent.isDestroyed() ||
    parent.webContents.isDestroyed()
  ) {
    return
  }
  parent.webContents.send(IpcEvents.settingsWindowState, open)
}

export function syncSettingsWindowLanguage(): void {
  win?.setTitle(tr('设置 - 阳鸽'))
}

export function syncSettingsWindowZoom(fontScale: SettingsView['fontScale']): void {
  currentFontScale = fontScale
  applyWindowZoom(win?.webContents, fontScale)
}

export function openSettingsWindow(
  parent: BrowserWindow | null,
  fontScale: SettingsView['fontScale']
): void {
  const activeParent = parent && !parent.isDestroyed() ? parent : null
  if (win && !win.isDestroyed()) {
    syncSettingsWindowZoom(fontScale)
    notifySettingsWindowState(activeParent, true)
    win.show()
    win.focus()
    return
  }
  win = new BrowserWindow({
    width: SETTINGS_WIDTH,
    height: SETTINGS_HEIGHT,
    ...centeredOverParent(activeParent),
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: tr('设置 - 阳鸽'),
    parent: activeParent ?? undefined,
    ...(process.platform !== 'darwin' && activeParent ? { modal: true } : {}),
    hasShadow: true,
    // 沉浸式无标题栏（决议 #49）：mac 红绿灯内嵌（最小化/最大化自动灰显），Win/Linux 自绘关闭按钮
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 10 } }
      : { frame: false }),
    ...linuxWindowIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  syncSettingsWindowZoom(fontScale)
  win.webContents.on('did-finish-load', () => syncSettingsWindowZoom(currentFontScale))
  win.setMenuBarVisibility(false)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  notifySettingsWindowState(activeParent, true)
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => {
    notifySettingsWindowState(activeParent, false)
    win = null
  })

  const rendererUrl = resolveDevRendererUrl(
    process.env['ELECTRON_RENDERER_URL'],
    '/settings',
    app.isPackaged
  )
  if (rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/settings' })
  }
}
