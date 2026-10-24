import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockFn = ReturnType<typeof vi.fn>

interface FakeNativeImage {
  dataURL: string
  setTemplateImage: MockFn
}

interface FakeTray {
  icon?: FakeNativeImage
  isDestroyed: MockFn
  setToolTip: MockFn
  setContextMenu: MockFn
  on: MockFn
  setTitle: MockFn
  setImage: MockFn
}

interface FakeWindow {
  setOverlayIcon: MockFn
}

type MenuTemplate = Array<Record<string, unknown>>

const electronMock = vi.hoisted(() => {
  const trays: FakeTray[] = []
  return {
    trays,
    app: {
      dock: { setBadge: vi.fn() },
      setBadgeCount: vi.fn()
    },
    nativeImage: {
      createFromDataURL: vi.fn(),
      createFromBuffer: vi.fn()
    },
    Menu: {
      buildFromTemplate: vi.fn()
    },
    Tray: vi.fn(),
    BrowserWindow: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: electronMock.app,
  BrowserWindow: electronMock.BrowserWindow,
  Menu: electronMock.Menu,
  nativeImage: electronMock.nativeImage,
  Tray: electronMock.Tray
}))

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

function installElectronDefaults(): void {
  electronMock.trays.length = 0
  electronMock.nativeImage.createFromDataURL.mockReset()
  electronMock.nativeImage.createFromDataURL.mockImplementation((dataURL: string): FakeNativeImage => {
    return { dataURL, setTemplateImage: vi.fn() }
  })
  // mac 菜单栏基础图标改走 createFromBuffer（@2x 重解释，决议 #82）
  electronMock.nativeImage.createFromBuffer.mockReset()
  electronMock.nativeImage.createFromBuffer.mockImplementation(
    (_buffer: Buffer, opts?: { scaleFactor?: number }): FakeNativeImage => {
      return { dataURL: `buffer@${opts?.scaleFactor ?? 1}x`, setTemplateImage: vi.fn() }
    }
  )
  electronMock.Menu.buildFromTemplate.mockReset()
  electronMock.Menu.buildFromTemplate.mockImplementation((template: MenuTemplate) => ({ template }))
  electronMock.Tray.mockReset()
  electronMock.Tray.mockImplementation(function (this: FakeTray, icon: FakeNativeImage): void {
    this.icon = icon
    this.isDestroyed = vi.fn(() => false)
    this.setToolTip = vi.fn()
    this.setContextMenu = vi.fn()
    this.on = vi.fn()
    this.setTitle = vi.fn()
    this.setImage = vi.fn()
    electronMock.trays.push(this)
  })
  electronMock.app.dock.setBadge.mockClear()
  electronMock.app.setBadgeCount.mockClear()
}

async function loadTrayModule(platform: NodeJS.Platform): Promise<typeof import('./tray')> {
  setPlatform(platform)
  vi.resetModules()
  return import('./tray')
}

function makeTray(): FakeTray {
  return {
    isDestroyed: vi.fn(() => false),
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn(),
    setTitle: vi.fn(),
    setImage: vi.fn()
  }
}

function makeWindow(): FakeWindow {
  return { setOverlayIcon: vi.fn() }
}

describe('tray unread integration', () => {
  beforeEach(() => {
    installElectronDefaults()
    setPlatform(originalPlatform)
  })

  afterEach(() => {
    vi.useRealTimers()
    setPlatform(originalPlatform)
  })

  it('macOS 设置菜单栏数字、Dock 角标和 tooltip', async () => {
    const { updateTrayUnread } = await loadTrayModule('darwin')
    const tray = makeTray()
    const win = makeWindow()

    updateTrayUnread(tray as never, win as never, 12)

    expect(tray.setToolTip).toHaveBeenCalledWith('阳鸽（12 条未读）')
    expect(tray.setTitle).toHaveBeenCalledWith('12')
    expect(electronMock.app.dock.setBadge).toHaveBeenCalledWith('12')
    expect(electronMock.app.setBadgeCount).toHaveBeenCalledWith(12)
    expect(win.setOverlayIcon).not.toHaveBeenCalled()
    expect(tray.setImage).not.toHaveBeenCalled()
  })

  it('macOS 未读清零时清除菜单栏数字和 Dock 角标', async () => {
    const { updateTrayUnread } = await loadTrayModule('darwin')
    const tray = makeTray()

    updateTrayUnread(tray as never, null, 0)

    expect(tray.setToolTip).toHaveBeenCalledWith('阳鸽')
    expect(tray.setTitle).toHaveBeenCalledWith('')
    expect(electronMock.app.dock.setBadge).toHaveBeenCalledWith('')
    expect(electronMock.app.setBadgeCount).toHaveBeenCalledWith(0)
  })

  it('Windows 设置任务栏 overlay 数字，并启动托盘闪烁兜底', async () => {
    vi.useFakeTimers()
    const { updateTrayUnread } = await loadTrayModule('win32')
    const tray = makeTray()
    const win = makeWindow()

    updateTrayUnread(tray as never, win as never, 128)

    expect(tray.setToolTip).toHaveBeenCalledWith('阳鸽（99+ 条未读）')
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(1)
    expect(win.setOverlayIcon.mock.calls[0][1]).toBe('99+ 条未读消息')
    expect((win.setOverlayIcon.mock.calls[0][0] as FakeNativeImage).dataURL).toContain(
      'data:image/png;base64,'
    )
    expect(tray.setImage).toHaveBeenCalledTimes(1)
    const unreadIcon = tray.setImage.mock.calls[0][0] as FakeNativeImage

    vi.advanceTimersByTime(800)

    expect(tray.setImage).toHaveBeenCalledTimes(2)
    const baseIcon = tray.setImage.mock.calls[1][0] as FakeNativeImage
    expect(baseIcon.dataURL).not.toBe(unreadIcon.dataURL)
  })

  it('Windows 未读清零时清除 overlay，并停止后续闪烁', async () => {
    vi.useFakeTimers()
    const { updateTrayUnread } = await loadTrayModule('win32')
    const tray = makeTray()
    const win = makeWindow()

    updateTrayUnread(tray as never, win as never, 3)
    updateTrayUnread(tray as never, win as never, 0)

    expect(win.setOverlayIcon.mock.calls[win.setOverlayIcon.mock.calls.length - 1]).toEqual([null, ''])
    expect(tray.setToolTip.mock.calls[tray.setToolTip.mock.calls.length - 1]).toEqual(['阳鸽'])
    const callCountAfterClear = tray.setImage.mock.calls.length

    vi.advanceTimersByTime(1600)

    expect(tray.setImage).toHaveBeenCalledTimes(callCountAfterClear)
  })

  it('Linux 尝试系统角标，并使用托盘闪烁兜底', async () => {
    vi.useFakeTimers()
    const { updateTrayUnread } = await loadTrayModule('linux')
    const tray = makeTray()
    const win = makeWindow()

    updateTrayUnread(tray as never, win as never, 5)

    expect(electronMock.app.setBadgeCount).toHaveBeenCalledWith(5)
    expect(win.setOverlayIcon).not.toHaveBeenCalled()
    expect(tray.setToolTip).toHaveBeenCalledWith('阳鸽（5 条未读）')
    expect(tray.setImage).toHaveBeenCalledTimes(1)
    const attentionIcon = tray.setImage.mock.calls[0][0] as FakeNativeImage

    vi.advanceTimersByTime(800)

    expect(tray.setImage).toHaveBeenCalledTimes(2)
    const baseIcon = tray.setImage.mock.calls[1][0] as FakeNativeImage
    expect(baseIcon.dataURL).not.toBe(attentionIcon.dataURL)

    vi.advanceTimersByTime(800)

    expect(tray.setImage).toHaveBeenCalledTimes(3)
    const nextAttentionIcon = tray.setImage.mock.calls[2][0] as FakeNativeImage
    expect(nextAttentionIcon.dataURL).toBe(attentionIcon.dataURL)
    expect(nextAttentionIcon).not.toBe(attentionIcon)
  })

  it('Linux 未读数更新时保持原闪烁周期，不重新停在注意帧', async () => {
    vi.useFakeTimers()
    const { updateTrayUnread } = await loadTrayModule('linux')
    const tray = makeTray()

    updateTrayUnread(tray as never, null, 1)
    vi.advanceTimersByTime(400)
    updateTrayUnread(tray as never, null, 2)
    vi.advanceTimersByTime(400)

    expect(tray.setImage).toHaveBeenCalledTimes(2)
    const attentionIcon = tray.setImage.mock.calls[0][0] as FakeNativeImage
    const baseIcon = tray.setImage.mock.calls[1][0] as FakeNativeImage
    expect(baseIcon.dataURL).not.toBe(attentionIcon.dataURL)

    vi.advanceTimersByTime(800)

    expect(tray.setImage).toHaveBeenCalledTimes(3)
    expect((tray.setImage.mock.calls[2][0] as FakeNativeImage).dataURL).toBe(attentionIcon.dataURL)
  })

  it('Linux 托盘销毁后安全停止闪烁', async () => {
    vi.useFakeTimers()
    const { updateTrayUnread } = await loadTrayModule('linux')
    const tray = makeTray()

    updateTrayUnread(tray as never, null, 1)
    tray.isDestroyed.mockReturnValue(true)
    vi.advanceTimersByTime(800)
    const callCountAfterDestroy = tray.setImage.mock.calls.length

    vi.advanceTimersByTime(1600)

    expect(tray.setImage).toHaveBeenCalledTimes(callCountAfterDestroy)
    expect(callCountAfterDestroy).toBe(1)
  })

  it('Linux 写入托盘图标失败后安全停止闪烁', async () => {
    vi.useFakeTimers()
    const { updateTrayUnread } = await loadTrayModule('linux')
    const tray = makeTray()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    tray.setImage.mockImplementationOnce(() => {
      throw new Error('dbus icon update failed')
    })

    updateTrayUnread(tray as never, null, 1)
    vi.advanceTimersByTime(1600)

    expect(tray.setImage).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[tray] 更新托盘图标失败，已停止未读闪烁：',
      expect.any(Error)
    )

    warn.mockRestore()
  })

  it('Linux 未读清零后恢复常规图标并停止闪烁', async () => {
    vi.useFakeTimers()
    const { updateTrayUnread } = await loadTrayModule('linux')
    const tray = makeTray()

    updateTrayUnread(tray as never, null, 3)
    updateTrayUnread(tray as never, null, 0)
    const callCountAfterClear = tray.setImage.mock.calls.length
    const restoredIcon = tray.setImage.mock.calls[callCountAfterClear - 1][0] as FakeNativeImage

    vi.advanceTimersByTime(1600)

    expect(tray.setImage).toHaveBeenCalledTimes(callCountAfterClear)
    expect(restoredIcon.dataURL).toContain('data:image/png;base64,')
    expect(tray.setToolTip).toHaveBeenLastCalledWith('阳鸽')
  })

  it('创建托盘时 macOS 使用 template image 并挂载菜单和点击入口', async () => {
    const { setupTray } = await loadTrayModule('darwin')
    const showWindow = vi.fn()
    const quit = vi.fn()

    const tray = setupTray({ showWindow, quit }) as unknown as FakeTray
    // macOS 基础图标走 createFromBuffer 并按 @2x 解释（决议 #82），再标记为 template image
    const image = electronMock.nativeImage.createFromBuffer.mock.results[0].value as FakeNativeImage

    expect(electronMock.nativeImage.createFromBuffer).toHaveBeenCalledWith(
      expect.anything(),
      { scaleFactor: 2 }
    )
    expect(image.setTemplateImage).toHaveBeenCalledWith(true)
    expect(electronMock.Tray).toHaveBeenCalledWith(image)
    expect(tray.setToolTip).toHaveBeenCalledWith('阳鸽')
    expect(electronMock.Menu.buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(tray.setContextMenu).toHaveBeenCalledWith(electronMock.Menu.buildFromTemplate.mock.results[0].value)
    expect(tray.on).toHaveBeenCalledWith('click', showWindow)
  })

  it('托盘创建失败时返回 null，不影响主流程', async () => {
    const { setupTray } = await loadTrayModule('linux')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    electronMock.Tray.mockImplementationOnce(() => {
      throw new Error('no tray')
    })

    expect(setupTray({ showWindow: vi.fn(), quit: vi.fn() })).toBeNull()
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
  })
})
