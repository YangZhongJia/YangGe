import { BrowserWindow, protocol, screen } from 'electron'
import { join } from 'node:path'
import { resolveGuandanAsset } from './guandan-assets'

// 内嵌掼蛋：第三方静态包放在 resources/guandan（开发期 build/guandan），
// 用独立的自定义协议加载，避免 file:// 下模块 Worker 与相对路径的限制。
const GAME_URL = 'yangge-game://guandan/index.html'

let win: BrowserWindow | null = null
let registered = false

export function registerGuandanProtocol(root: string): void {
  if (registered) return
  registered = true
  protocol.registerFileProtocol('yangge-game', (request, callback) => {
    const target = resolveGuandanAsset(root, request.url)
    callback(target ? { path: target } : { error: -6 })
  })
}

export interface GuandanContext {
  nick: string
  avatar: number
  avatarHash: string
  ip: string
  port: number
  peers: Array<{ nick: string; ip: string; avatar: number; avatarHash: string }>
}

export function openGuandanWindow(parent: BrowserWindow | null, context: GuandanContext): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }

  const display = parent && !parent.isDestroyed()
    ? screen.getDisplayMatching(parent.getBounds())
    : screen.getPrimaryDisplay()
  const width = Math.max(1180, Math.min(1600, display.workArea.width - 80))
  const height = Math.max(760, Math.min(900, display.workArea.height - 80))

  win = new BrowserWindow({
    width,
    height,
    minWidth: 1180,
    minHeight: 760,
    title: '掼蛋',
    backgroundColor: '#0b0c10',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // 轮到 AI 出牌时窗口可能失焦，避免后台节流拖慢牌局节奏。
      backgroundThrottling: false
    }
  })
  win.center()
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('yangge-game://guandan/')) event.preventDefault()
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => {
    win = null
  })
  const params = new URLSearchParams({
    nick: context.nick,
    avatar: String(context.avatar),
    avatarHash: context.avatarHash,
    ip: context.ip,
    port: String(context.port),
    peers: JSON.stringify(context.peers)
  })
  void win.loadURL(`${GAME_URL}?${params.toString()}`)
}

/** 打包后由主进程传入 resources/guandan，开发期传 build/guandan。 */
export function guandanRoot(appPath: string, resourcesPath: string, packaged: boolean): string {
  return packaged ? join(resourcesPath, 'guandan') : join(appPath, 'build', 'guandan')
}
