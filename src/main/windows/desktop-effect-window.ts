import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { DesktopNudgeEvent } from '../../shared/ipc'
import type { NudgeStyle } from '../../shared/protocol'
import { resolveDevRendererUrl } from '../util/renderer-url'

// 桌面互动特效：透明、无边框、置顶、鼠标穿透，不进入任务栏，也不抢焦点。
// 纸飞机 / 墨弹仍由现有 NudgeEffect 渲染，只是换成一个覆盖桌面的大画布。
let win: BrowserWindow | null = null
let pending: DesktopNudgeEvent | null = null
let loaded = false
let hideTimer: ReturnType<typeof setTimeout> | null = null

const EFFECT_HOLD_MS = 3400

function effectBounds(): Electron.Rectangle {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return display.bounds
}

function sendPlay(style: NudgeStyle): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('desktop-nudge:play', { style } satisfies DesktopNudgeEvent)
}

function scheduleHide(): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (win && !win.isDestroyed()) win.hide()
  }, EFFECT_HOLD_MS)
  hideTimer.unref?.()
}

function createWindow(): BrowserWindow {
  const bounds = effectBounds()
  const next = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win = next
  loaded = false
  next.setAlwaysOnTop(true, 'screen-saver')
  next.setIgnoreMouseEvents(true, { forward: true })
  next.setMenuBarVisibility(false)
  next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  next.webContents.on('will-navigate', (event) => event.preventDefault())
  next.webContents.on('did-finish-load', () => {
    loaded = true
    const queued = pending
    pending = null
    if (queued) {
      sendPlay(queued.style)
      next.showInactive()
      scheduleHide()
    }
  })
  next.webContents.on('did-fail-load', () => {
    loaded = false
    if (win === next) win = null
    next.destroy()
  })
  next.on('closed', () => {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
    if (win === next) win = null
    loaded = false
    pending = null
  })

  const rendererUrl = resolveDevRendererUrl(
    process.env['ELECTRON_RENDERER_URL'],
    '/desktop-effect',
    app.isPackaged
  )
  if (rendererUrl) {
    void next.loadURL(rendererUrl)
  } else {
    void next.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/desktop-effect' })
  }
  return next
}

/** 在桌面播放一次纸飞机 / 墨弹；返回是否已安排播放。 */
export function showDesktopNudge(style: NudgeStyle): boolean {
  const target = win && !win.isDestroyed() ? win : createWindow()
  if (!target || target.isDestroyed()) return false
  target.setBounds(effectBounds())
  if (loaded) {
    sendPlay(style)
    target.showInactive()
    scheduleHide()
  } else {
    pending = { style }
  }
  return true
}
