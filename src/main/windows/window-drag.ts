import type { BrowserWindow, Point } from 'electron'

type DragWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'isMaximized' | 'isFullScreen' | 'getBounds' | 'setBounds'
>

interface WindowSize { width: number; height: number }

/** Linux 自绘拖拽：固定开始时的尺寸，避免分数缩放下 setPosition 累积尺寸误差。 */
export class WindowDragController {
  private timer: ReturnType<typeof setInterval> | null = null
  private active: { win: DragWindow; size: WindowSize } | null = null
  private readonly sizes = new WeakMap<DragWindow, { requested: WindowSize; observed: WindowSize }>()

  constructor(private readonly cursorPosition: () => Point) {}

  start(win: DragWindow | null): void {
    this.stop()
    if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return

    const cursor = this.cursorPosition()
    const bounds = win.getBounds()
    const remembered = this.sizes.get(win)
    // 原生窗口读回时仍可能有少量取整误差，下一轮拖拽不能把它变成新的目标尺寸。
    // 拖拽之间主动调整过大小时，读回值会变化，此时尊重新尺寸。
    const size = remembered && bounds.width === remembered.observed.width && bounds.height === remembered.observed.height
      ? remembered.requested
      : { width: bounds.width, height: bounds.height }
    this.active = { win, size }
    const offsetX = cursor.x - bounds.x
    const offsetY = cursor.y - bounds.y
    let previous = cursor

    this.timer = setInterval(() => {
      if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) {
        this.stop()
        return
      }
      const point = this.cursorPosition()
      if (point.x === previous.x && point.y === previous.y) return
      previous = point
      win.setBounds({
        x: point.x - offsetX,
        y: point.y - offsetY,
        width: size.width,
        height: size.height
      })
    }, 16)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    const active = this.active
    this.active = null
    if (!active || active.win.isDestroyed() || active.win.isMaximized() || active.win.isFullScreen()) return
    const bounds = active.win.getBounds()
    this.sizes.set(active.win, {
      requested: active.size,
      observed: { width: bounds.width, height: bounds.height }
    })
  }
}
