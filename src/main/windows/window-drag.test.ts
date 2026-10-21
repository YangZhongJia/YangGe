import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowDragController } from './window-drag'

function makeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    getBounds: vi.fn(() => ({ x: 100, y: 80, width: 960, height: 640 })),
    setBounds: vi.fn()
  }
}

describe('Linux 窗口拖拽（#55）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('往返移动与负坐标始终保持开始时的宽高和光标偏移', () => {
    let cursor = { x: 140, y: 96 }
    const controller = new WindowDragController(() => cursor)
    const win = makeWindow()
    controller.start(win)

    // 即使窗口管理器在移动后返回经缩放取整的尺寸，也不把误差带到下一次移动。
    win.getBounds.mockReturnValue({ x: 120, y: 100, width: 959, height: 639 })
    for (const point of [{ x: 160, y: 116 }, { x: -200, y: -30 }, { x: 140, y: 96 }]) {
      cursor = point
      vi.advanceTimersByTime(16)
      expect(win.setBounds).toHaveBeenLastCalledWith({
        x: point.x - 40, y: point.y - 16, width: 960, height: 640
      })
    }
    expect(win.setBounds).toHaveBeenCalledTimes(3)
    controller.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('光标静止与停止拖拽后不再更新窗口', () => {
    let cursor = { x: 140, y: 96 }
    const controller = new WindowDragController(() => cursor)
    const win = makeWindow()
    controller.start(win)
    vi.advanceTimersByTime(160)
    expect(win.setBounds).not.toHaveBeenCalled()

    cursor = { x: 160, y: 116 }
    vi.advanceTimersByTime(160)
    expect(win.setBounds).toHaveBeenCalledTimes(1)
    controller.stop()
    cursor = { x: 200, y: 120 }
    vi.advanceTimersByTime(160)
    expect(win.setBounds).toHaveBeenCalledTimes(1)
  })

  it.each(['isDestroyed', 'isMaximized', 'isFullScreen'] as const)(
    '%s 时不能开始拖拽，拖拽中进入该状态也会停止', (state) => {
      let cursor = { x: 140, y: 96 }
      const controller = new WindowDragController(() => cursor)
      const win = makeWindow()
      win[state].mockReturnValue(true)
      controller.start(win)
      expect(vi.getTimerCount()).toBe(0)

      win[state].mockReturnValue(false)
      controller.start(win)
      win[state].mockReturnValue(true)
      cursor = { x: 200, y: 120 }
      vi.advanceTimersByTime(16)
      expect(win.setBounds).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('开始拖动另一个窗口时释放旧计时器，并重新记录尺寸', () => {
    let cursor = { x: 140, y: 96 }
    const controller = new WindowDragController(() => cursor)
    const first = makeWindow()
    const second = makeWindow()
    second.getBounds.mockReturnValue({ x: 120, y: 90, width: 640, height: 480 })
    controller.start(first)
    controller.start(second)
    expect(vi.getTimerCount()).toBe(1)
    cursor = { x: 180, y: 106 }
    vi.advanceTimersByTime(16)
    expect(first.setBounds).not.toHaveBeenCalled()
    expect(second.setBounds).toHaveBeenCalledWith({ x: 160, y: 100, width: 640, height: 480 })
    controller.start(null)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('多轮拖拽不把系统读回的取整尺寸当作新的目标尺寸', () => {
    let cursor = { x: 140, y: 96 }
    const controller = new WindowDragController(() => cursor)
    const win = makeWindow()
    win.setBounds.mockImplementation((bounds) => {
      win.getBounds.mockReturnValue({ ...bounds, width: bounds.width + 2, height: bounds.height + 2 })
    })
    for (let gesture = 0; gesture < 10; gesture++) {
      controller.start(win)
      cursor = { x: cursor.x + 20, y: cursor.y + 20 }
      vi.advanceTimersByTime(16)
      expect(win.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 960, height: 640 }))
      controller.stop()
    }
  })

  it('两轮拖拽之间主动调整窗口尺寸后使用新的宽高', () => {
    let cursor = { x: 140, y: 96 }
    const controller = new WindowDragController(() => cursor)
    const win = makeWindow()
    controller.start(win)
    cursor = { x: 160, y: 116 }
    vi.advanceTimersByTime(16)
    win.getBounds.mockReturnValue({ x: 120, y: 100, width: 962, height: 642 })
    controller.stop()

    win.getBounds.mockReturnValue({ x: 120, y: 100, width: 1120, height: 800 })
    controller.start(win)
    cursor = { x: 180, y: 136 }
    vi.advanceTimersByTime(16)
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 140, y: 120, width: 1120, height: 800 })
    controller.stop()
  })
})
