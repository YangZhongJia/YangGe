import { tr } from '../../i18n'
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { TRAY_ICON_COLOR_DATAURL, TRAY_ICON_MONO_DATAURL } from './tray-icon'
import {
  createLinuxTrayAttentionIconDataURL,
  createUnreadOverlayIconDataURL,
  createUnreadTrayIconDataURL,
  trayUnreadToolTip,
  unreadBadgeText
} from './tray-badge'

export interface TrayDeps {
  showWindow: () => void
  quit: () => void
}

/** 托盘基础图（决议 #58）：mac 单色 template，Win/Linux 彩色填充版 */
function trayBaseDataURL(): string {
  return process.platform === 'darwin' ? TRAY_ICON_MONO_DATAURL : TRAY_ICON_COLOR_DATAURL
}

/**
 * 基础托盘图标（决议 #82）。mac 菜单栏在 retina 上发糊的根因：32px 图被当 1x（逻辑 32pt）
 * 塞进 ~22pt 高的菜单栏，先缩小再在 retina 上放大，双重模糊。改为按 **@2x** 解释同一张
 * 32px 图 —— 逻辑 16pt、物理 32px，菜单栏尺寸合适且像素一一对应，清晰不糊。
 * Win/Linux 仍用 1x 彩色填充版。
 */
function createTrayBaseIcon(): ReturnType<typeof nativeImage.createFromDataURL> {
  if (process.platform === 'darwin') {
    const b64 = TRAY_ICON_MONO_DATAURL.split(',')[1] ?? ''
    const icon = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'), { scaleFactor: 2 })
    icon.setTemplateImage(true)
    return icon
  }
  return nativeImage.createFromDataURL(TRAY_ICON_COLOR_DATAURL)
}

let menuDeps: TrayDeps | undefined
let unreadCount = 0

let flashTimer: ReturnType<typeof setInterval> | null = null
let flashOn = false
let flashTray: Tray | null = null
let flashBaseDataURL = ''
let flashUnreadDataURL = ''

/**
 * 托盘常驻（F-SYS-1）。个别 Linux 桌面环境没有托盘协议 —— 创建失败不致命，
 * 返回 null，关窗行为由调用方降级为直接退出。
 */
export function setupTray(deps: TrayDeps): Tray | null {
  try {
    const tray = new Tray(createTrayBaseIcon())
    menuDeps = deps
    refreshTrayLanguage(tray)
    // Windows/Linux 习惯：单击托盘直接唤起主窗
    tray.on('click', deps.showWindow)
    return tray
  } catch (err) {
    console.warn('[tray] 托盘不可用（桌面环境不支持），关窗将直接退出：', err)
    return null
  }
}

export function refreshTrayLanguage(tray: Tray | null, mainWindow: BrowserWindow | null = null): void {
  if (!tray || !menuDeps) return
  updateTrayUnread(tray, mainWindow, unreadCount)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr('打开阳鸽'), click: menuDeps.showWindow },
    { type: 'separator' },
    { label: tr('退出'), click: menuDeps.quit }
  ]))
}

export function updateTrayUnread(tray: Tray | null, mainWindow: BrowserWindow | null, count: number): void {
  const safeCount = Math.max(0, count)
  unreadCount = safeCount
  const label = unreadBadgeText(safeCount)
  tray?.setToolTip(trayUnreadToolTip(safeCount))

  if (process.platform === 'darwin') {
    stopTrayUnreadFlash(tray)
    tray?.setTitle(label)
    app.dock?.setBadge(label)
    app.setBadgeCount(safeCount)
    return
  }

  if (process.platform === 'win32') {
    const overlay = safeCount > 0 ? nativeImage.createFromDataURL(createUnreadOverlayIconDataURL(safeCount)) : null
    mainWindow?.setOverlayIcon(overlay, safeCount > 0 ? tr('{0} 条未读消息', { 0: label }) : '')
  } else if (process.platform === 'linux') {
    app.setBadgeCount(safeCount)
  }

  if (!tray) return
  if (safeCount > 0) startTrayUnreadFlash(tray, safeCount)
  else stopTrayUnreadFlash(tray)
}

export function stopTrayUnreadFlash(tray?: Tray | null): void {
  if (flashTimer) {
    clearInterval(flashTimer)
    flashTimer = null
  }
  flashOn = false
  flashTray = null
  flashBaseDataURL = ''
  flashUnreadDataURL = ''
  if (tray && process.platform !== 'darwin') {
    setTrayImage(tray, trayBaseDataURL())
  }
}

function startTrayUnreadFlash(tray: Tray, count: number): void {
  const baseDataURL = trayBaseDataURL()
  const unreadDataURL =
    process.platform === 'linux' ? createLinuxTrayAttentionIconDataURL() : createUnreadTrayIconDataURL(count)

  if (flashTimer && flashTray === tray) {
    const unreadFrameChanged = flashUnreadDataURL !== unreadDataURL
    flashBaseDataURL = baseDataURL
    flashUnreadDataURL = unreadDataURL
    // 未读数更新不重启周期；Windows 当前在注意帧时只替换新的数字图。
    if (flashOn && unreadFrameChanged && !setTrayImage(tray, unreadDataURL)) {
      stopTrayUnreadFlash()
    }
    return
  }

  if (flashTimer || flashTray) stopTrayUnreadFlash(flashTray)

  flashTray = tray
  flashBaseDataURL = baseDataURL
  flashUnreadDataURL = unreadDataURL
  flashOn = true
  if (!setTrayImage(tray, unreadDataURL)) {
    stopTrayUnreadFlash()
    return
  }

  flashTimer = setInterval(() => {
    const activeTray = flashTray
    if (!activeTray) {
      stopTrayUnreadFlash()
      return
    }
    flashOn = !flashOn
    const nextDataURL = flashOn ? flashUnreadDataURL : flashBaseDataURL
    // Linux 每次新建 NativeImage，促使 Electron 22 重新序列化 D-Bus IconPixmap。
    if (!setTrayImage(activeTray, nextDataURL)) stopTrayUnreadFlash()
  }, 800)
  flashTimer.unref?.()
}

function setTrayImage(tray: Tray, dataURL: string): boolean {
  if (tray.isDestroyed()) return false
  try {
    tray.setImage(nativeImage.createFromDataURL(dataURL))
    return true
  } catch (err) {
    console.warn('[tray] 更新托盘图标失败，已停止未读闪烁：', err)
    return false
  }
}
