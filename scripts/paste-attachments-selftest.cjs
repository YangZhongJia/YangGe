// 真实 Electron 22 + 生产界面/IPC + 回环同事；只用测试素材与隔离数据，不读用户剪贴板。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const repo = path.resolve(__dirname, '..')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(repo, '.paste-selftest-'))
  require('esbuild').buildSync({
    stdin: { contents: ['src/main/store/app-state.ts', 'src/main/store/db.ts', 'src/main/store/conv-repo.ts',
      'src/main/store/peers-repo.ts', 'src/main/net/udp.ts', 'src/main/net/peer-registry.ts',
      'src/main/net/discovery.ts', 'src/main/net/messenger.ts', 'src/main/net/codec.ts',
      'src/main/net/transfer.ts', 'src/shared/protocol.ts']
      .map(file => `export * from ${JSON.stringify(path.join(repo, file))}`).join('\n'), resolveDir: repo },
    bundle: true, platform: 'node', target: 'node16', external: ['better-sqlite3'],
    outfile: path.join(directory, 'fixture.cjs'), logLevel: 'silent'
  })
  try {
    const result = spawnSync(require('electron'), [__filename, directory], { cwd: repo, stdio: 'inherit',
      timeout: 120000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PANTRY_PEERS: '' } })
    assert.equal(result.status, 0, `Electron 自测失败：${result.error || result.signal || result.status}`)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
} else void run().catch(error => { console.error(error); require('electron').app.exit(1) })

async function until(check, label, timeout = 12000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(50) }
  throw new Error(`等待超时：${label}`)
}
async function freePort(type) {
  if (type === 'udp') return new Promise(resolve => {
    const socket = require('node:dgram').createSocket('udp4')
    socket.bind(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)) })
  })
  return new Promise(resolve => {
    const server = require('node:net').createServer()
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
  })
}
async function run() {
  const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron')
  if (process.env.PANTRY_PASTE_SOFTWARE) app.disableHardwareAcceleration()
  const directory = process.argv[2], fixture = require(path.join(directory, 'fixture.cjs'))
  const data = path.join(directory, 'data')
  const ports = await Promise.all(['udp', 'tcp', 'udp', 'tcp'].map(freePort))
  const [appUdp, appTcp, peerUdp, peerTcp] = ports
  process.env.PANTRY_USER_DATA = data
  process.env.PANTRY_SMOKE = '1'
  process.env.PANTRY_UDP_PORT = String(appUdp)
  process.env.PANTRY_TCP_PORT = String(appTcp)
  app.getAppPath = () => repo
  app.getVersion = () => require(path.join(repo, 'package.json')).version
  app.getPreferredSystemLanguages = () => ['zh-CN']
  globalShortcut.register = () => false
  let finished = false
  const quit = app.quit.bind(app)
  app.quit = () => { if (finished) quit() }
  const appState = fixture.loadAppState(data, app.getVersion(), appTcp, appUdp, [], 'zh-CN')
  fixture.saveProfile(appState, { nick: '本机测试', company: '', dept: '', team: '', avatar: -1, fileDir: '' })
  const peerId = 'paste-test-peer'
  const profile = { nodeId: peerId, nick: '林小满', company: '', dept: '', team: '', avatar: -1,
    host: 'loopback', platform: 'mac', tcpPort: peerTcp, profileRev: 1, ver: app.getVersion(), caps: ['img1', 'txt1'] }
  const db = fixture.openDatabase(path.join(data, 'data/db/chat.db'))
  new fixture.PeersRepo(db).upsertMany([{ profile, ip: '127.0.0.1', udpPort: peerUdp, lastSeen: Date.now(), online: false }])
  new fixture.PeersRepo(db).upsertMany([{ profile: { ...profile, nodeId: 'paste-other-peer', nick: '另一会话' }, ip: '127.0.0.1', udpPort: peerUdp, lastSeen: Date.now(), online: false }])
  new fixture.ConvRepo(db).ensureSingle('paste-other-peer')
  new fixture.ConvRepo(db).ensureSingle(peerId)
  db.close()

  // 双重约束，任何意外真实局域网/公网绑定与发送都直接失败。
  const dgram = require('node:dgram'), createSocket = dgram.createSocket
  dgram.createSocket = function (...args) {
    const socket = createSocket.apply(this, args), bind = socket.bind, send = socket.send
    socket.bind = function (port, address, ...rest) { assert.equal(address, '127.0.0.1'); return bind.call(this, port, address, ...rest) }
    socket.send = function (...params) { assert.equal(params.find(value => typeof value === 'string'), '127.0.0.1'); return send.apply(this, params) }
    return socket
  }
  const net = require('node:net'), listen = net.Server.prototype.listen, connect = net.createConnection
  net.Server.prototype.listen = function (port, address, ...rest) { assert.equal(address, '127.0.0.1'); return listen.call(this, port, address, ...rest) }
  net.createConnection = function (options, ...rest) { assert.equal(options.host, '127.0.0.1'); return connect.call(this, options, ...rest) }
  const errors = []
  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('console-message', (_event, _level, message) => {
      if (/Uncaught|Unhandled|TypeError|ReferenceError|\[Vue warn\]|Refused to/.test(message)) errors.push(message)
    })
  })
  require(path.join(repo, 'out/main/index.js'))
  await app.whenReady()
  const main = await until(() => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().includes('#/')), '主窗')
  await until(() => main.webContents.executeJavaScript('!!document.querySelector(".shell")'), '主窗加载')

  const udp = new fixture.UdpChannel({ port: peerUdp, bindAddress: '127.0.0.1', broadcastTargets: [] })
  const registry = new fixture.PeerRegistry(peerId)
  const discovery = new fixture.Discovery({ udp, registry, profile, manualPeers: [{ host: '127.0.0.1', port: appUdp }], timings: { entryReplyJitterBase: 10, entryReplyJitterMax: 10 } })
  const seen = new Set()
  const messenger = new fixture.Messenger({ udp, registry, selfId: peerId,
    queue: { enqueue() {}, listByPeer() { return [] }, remove() {}, prune() {} },
    dedup: { has: id => seen.has(id), add: id => seen.add(id), prune() {} } })
  const server = new fixture.TransferServer(peerTcp, { resolve: () => null,
    receiveMessage: (env, ip) => messenger.acceptTcpEnvelope(env, ip) }, '127.0.0.1')
  await server.start(); await udp.start(); discovery.start()
  await until(async () => (await main.webContents.executeJavaScript('window.pantry.getPeers()')).some(p => p.nodeId === peerId && p.online), '发现回环同事')
  const choose = name => main.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.conv')).find(el => el.textContent.includes(${JSON.stringify(name)})).click()`)
  await choose('林小满')
  await until(() => main.webContents.executeJavaScript('!!document.querySelector("textarea.input")'), '聊天输入框')
  main.setSize(1120, 800); main.show()
  const js = code => main.webContents.executeJavaScript(code)
  const count = () => js('document.querySelectorAll(".attachment-card").length')
  const records = () => js(`window.pantry.pageMessages('single:${peerId}', null, 100)`)
  const text = value => js(`(() => { const el = document.querySelector('textarea.input'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const paste = specs => js(`(() => {
    const data = new DataTransfer();
    for (const spec of ${JSON.stringify(specs)}) {
      const bytes = spec.image ? Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(path.join(repo, 'build/icons/pantry-logo-icon.png')).toString('base64'))}), c => c.charCodeAt(0)) : new Uint8Array(spec.size || 1200);
      const file = new File([bytes], spec.name, { type: spec.image ? 'image/png' : 'application/octet-stream' });
      if (spec.path) Object.defineProperty(file, 'path', { value: spec.path });
      data.items.add(file);
    }
    document.querySelector('textarea.input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  })()`)
  const output = process.env.PANTRY_PASTE_TEST_ARTIFACTS || path.join(repo, '../artifacts')
  fs.mkdirSync(output, { recursive: true })
  const screenshot = async name => {
    await pause(120)
    fs.writeFileSync(path.join(output, name + '.png'), (await main.webContents.capturePage()).toPNG())
  }
  const bounds = () => js(`Array.from(document.querySelectorAll('.attachment-card, .remove-attachment, .cancel-attachments, .send')).every(el => {
    const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
  })`)
  // 所有图片来自本地合成素材；不读用户桌面/剪贴板或真实文件。
  await text('这是今天整理的资料，帮我看看这版。')
  await paste([{ name: '茶话间图标.png', image: true }])
  assert.equal(await count(), 1)
  assert.equal((await records()).length, 0, '粘贴不得创建消息')
  assert.equal(await js('document.querySelector(".attachment-preview img").naturalWidth > 0'), true)
  await screenshot('01-image-preview')
  const pdfPath = path.join(directory, '项目方案.pdf'); fs.writeFileSync(pdfPath, Buffer.alloc(2048))
  await paste([{ name: '项目方案.pdf', path: pdfPath, size: 2048 }])
  assert.equal(await count(), 2)
  assert.equal((await records()).length, 0)
  await screenshot('02-mixed-attachments')
  await paste([{ name: '项目方案.pdf', path: pdfPath, size: 2048 }])
  assert.equal(await count(), 2, '连续粘贴同一路径去重')
  await click('.remove-attachment'); assert.equal(await count(), 1)
  await screenshot('03-file-preview')
  await paste([{ name: '评审资料_2026年第4季度_最终确认版本_请核对附件内容后发送.png', image: true }])
  main.setSize(860, 680); await pause(120)
  assert.equal(await bounds(), true, '窄窗操作必须可见')
  await screenshot('04-narrow-preview')
  await js("document.documentElement.dataset.theme = 'dark'")
  await screenshot('05-dark-preview')
  await js("document.documentElement.dataset.theme = 'light'")
  await click('.cancel-attachments'); assert.equal(await count(), 0)
  assert.equal(await js('document.querySelector("textarea.input").value'), '这是今天整理的资料，帮我看看这版。', '取消附件保留文字')
  assert.equal((await records()).length, 0)
  await paste([{ name: '茶话间图标.png', image: true }, { name: '项目方案.pdf', path: pdfPath, size: 2048 }])
  await js("document.querySelector('.send').click(); document.querySelector('.send').click()")
  await until(async () => await count() === 0, '显式发送完成', 20000)
  await pause(300)
  const sent = await records()
  assert.equal(sent.length, 3, '文字与两附件各发一次')
  await click('.send'); await pause(100)
  assert.equal((await records()).length, 3, '已发送附件不能重复发送')
  main.setSize(1120, 800)
  await screenshot('06-sent-result')
  // 会话切换清理待发送项；返回原会话也不恢复被取消的附件。
  await paste([{ name: '不应跨会话发送.png', image: true }])
  await choose('另一会话'); assert.equal(await count(), 0)
  await choose('林小满'); assert.equal(await count(), 0)
  assert.equal((await records()).length, 3)
  // Escape 取消，组合输入的 Enter 不发送，正常 Enter 遵守现有发送键配置。
  await paste([{ name: '键盘确认.png', image: true }])
  await js("document.querySelector('textarea.input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))")
  assert.equal(await count(), 1)
  await js("document.querySelector('textarea.input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))")
  assert.equal(await count(), 0)
  await paste([{ name: '键盘确认.png', image: true }])
  await js("document.querySelector('textarea.input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
  await until(async () => (await records()).length === 4, '键盘确认发送')
  // 仅替换测试实例的剪贴板读取 IPC；生产事件/代次保护照常执行，不访问系统剪贴板。
  ipcMain.removeHandler('clipboard:read-image')
  let releaseRead
  ipcMain.handle('clipboard:read-image', () => new Promise(resolve => { releaseRead = resolve }))
  const emptyPaste = () => js("document.querySelector('textarea.input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }))")
  const imageBytes = () => { const buffer = fs.readFileSync(path.join(repo, 'build/icons/pantry-logo-icon.png')); return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) }
  await emptyPaste(); await until(() => releaseRead, '原生剪贴板读取开始')
  await choose('另一会话'); await choose('林小满')
  releaseRead(imageBytes()); await pause(80)
  assert.equal(await count(), 0, '旧会话异步剪贴板结果必须丢弃')
  releaseRead = null
  await emptyPaste(); await until(() => releaseRead, '第二次原生读取')
  await paste([{ name: '浏览器图片.png', image: true }])
  releaseRead(imageBytes()); await pause(80)
  assert.equal(await count(), 1, '浏览器 paste 与原生兜底只能入队一次')
  await click('.cancel-attachments')
  releaseRead = null
  await emptyPaste(); await until(() => releaseRead, '第三次原生读取')
  releaseRead(imageBytes()); await until(async () => await count() === 1, '原生图片待发送')
  assert.equal((await records()).length, 4, '原生兜底不得自动发送')
  await click('.cancel-attachments')
  // 多附件滚动只占有限高度，显式操作保持可见。
  await paste(Array.from({ length: 8 }, (_, i) => ({ name: `多附件${i + 1}.png`, image: true })))
  assert.equal(await count(), 8)
  assert.equal(await js("document.querySelector('.attachment-list').getBoundingClientRect().height <= 176"), true)
  await screenshot('07-many-attachments')
  await click('.cancel-attachments')
  assert.deepEqual(errors, [], '渲染控制台不得出现错误')
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ electron: process.versions.electron, screenshots: 7, messages: 4, errors }, null, 2))
  console.log('PASTE_SELFTEST_OK', JSON.stringify({ electron: process.versions.electron, messages: 4, output }))
  finished = true
  discovery.stop(); messenger.stop?.(); await server.stop(); udp.stop()
  app.exit(0)
}
