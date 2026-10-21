// 真实 Electron 22 设置界面与 IPC；隔离数据，仅允许回环网络。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const repo = path.resolve(__dirname, '..')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(repo, '.bulk-ranges-selftest-'))
  require('esbuild').buildSync({ entryPoints: [path.join(repo, 'src/main/store/app-state.ts')],
    bundle: true, platform: 'node', target: 'node16', outfile: path.join(directory, 'fixture.cjs'), logLevel: 'silent' })
  try {
    const result = spawnSync(require('electron'), [__filename, directory], { cwd: repo, stdio: 'inherit', timeout: 60000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PANTRY_PEERS: '' } })
    assert.equal(result.status, 0, `批量网段自测失败：${result.error || result.signal || result.status}`)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
} else void run().catch(error => { console.error(error); require('electron').app.exit(1) })

async function until(check, label) {
  const end = Date.now() + 12000
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
  const { app, BrowserWindow, globalShortcut } = require('electron')
  const directory = process.argv[2], fixture = require(path.join(directory, 'fixture.cjs'))
  const data = path.join(directory, 'data')
  const [udp, tcp] = await Promise.all(['udp', 'tcp'].map(freePort))
  process.env.PANTRY_USER_DATA = data
  process.env.PANTRY_SMOKE = '1'
  process.env.PANTRY_UDP_PORT = String(udp)
  process.env.PANTRY_TCP_PORT = String(tcp)
  app.disableHardwareAcceleration()
  app.getAppPath = () => repo
  app.getVersion = () => require(path.join(repo, 'package.json')).version
  app.getPreferredSystemLanguages = () => ['zh-CN']
  globalShortcut.register = () => false
  const state = fixture.loadAppState(data, app.getVersion(), tcp, udp, [], 'zh-CN')
  fixture.saveProfile(state, { nick: '批量导入测试', company: '', dept: '', team: '', avatar: -1, fileDir: '' })
  fixture.saveAppSettings(state, { scanRanges: ['10.1.0.0/24'] })
  let finished = false
  const quit = app.quit.bind(app)
  app.quit = () => { if (finished) quit() }
  // 一旦导入误触发网段探测则失败；绝不向真实局域网发包。
  const dgram = require('node:dgram'), createSocket = dgram.createSocket
  dgram.createSocket = function (...args) {
    const socket = createSocket.apply(this, args), send = socket.send
    socket.send = function (...params) {
      assert.equal(params.find(value => typeof value === 'string'), '127.0.0.1', '导入不得向网段发起探测')
      return send.apply(this, params)
    }
    return socket
  }
  require(path.join(repo, 'out/main/index.js'))
  const main = await until(() => BrowserWindow.getAllWindows().find(win => !win.isDestroyed()), '主窗口')
  await until(() => main.webContents.executeJavaScript('!!window.pantry').catch(() => false), 'preload')
  await main.webContents.executeJavaScript('window.pantry.openSettings()')
  const settings = await until(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/settings')), '设置窗口')
  const invoke = code => settings.webContents.executeJavaScript(code)
  await until(() => invoke('!!document.querySelector(".nav button")').catch(() => false), '设置导航')
  await invoke(`Array.from(document.querySelectorAll('.nav button')).find(el => el.textContent.includes('网络')).click(); true`)
  await until(() => invoke('!!document.querySelector(".range-import")'), '批量入口')
  await invoke('document.querySelector(".range-import").open = true; true')
  const fill = async value => {
    await invoke(`(() => { const el = document.querySelector('.range-import textarea'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await pause(60)
  }
  await fill('10.1.0.88/24\n10.2.0.8/25\n10.2.0.99/25')
  assert.match(await invoke('document.querySelector(".preview").textContent'), /新增 1 个，跳过重复 2 个/)
  assert.match(await invoke('document.querySelector(".preview").textContent'), /380 个不重复探测地址/)
  assert.deepEqual((await invoke('window.pantry.getSettings()')).scanRanges, ['10.1.0.0/24'], '预览不保存')
  await invoke('document.querySelector(".range-import button").click(); true')
  await until(() => invoke('document.querySelector(".notice")?.textContent.includes("已添加 1")'), '保存成功')
  assert.deepEqual((await invoke('window.pantry.getSettings()')).scanRanges, ['10.1.0.0/24', '10.2.0.0/25'])
  assert.deepEqual(JSON.parse(fs.readFileSync(state.configPath, 'utf8')).scanRanges, ['10.1.0.0/24', '10.2.0.0/25'])

  await fill('10.3.0.0/24\nnot-a-cidr')
  assert.equal(await invoke('document.querySelector(".range-import button").disabled'), true)
  assert.match(await invoke('document.querySelector(".preview").textContent'), /第 2 行无效/)
  assert.equal((await invoke(`window.pantry.importScanRanges('10.3.0.0/24\\nnot-a-cidr')`)).ok, false, '主进程独立验证')
  assert.equal((await invoke('window.pantry.getSettings()')).scanRanges.length, 2)
  await fill(Array.from({ length: 20 }, (_, i) => `10.${i + 30}.0.0/24`).join('\n'))
  assert.equal(await invoke('document.querySelector(".range-import button").disabled'), true)
  assert.match(await invoke('document.querySelector(".preview").textContent'), /不能超过 20/)

  await fill('10.3.0.8/25\n10.4.0.9/25')
  await invoke('document.querySelector(".range-import").scrollIntoView({ block: "start" }); true')
  await pause(100)
  const artifacts = path.resolve(process.env.PANTRY_RANGE_TEST_ARTIFACTS || path.join(repo, '../artifacts/bulk-ranges'))
  fs.mkdirSync(artifacts, { recursive: true })
  fs.writeFileSync(path.join(artifacts, 'bulk-ranges-zh.png'), (await settings.webContents.capturePage()).toPNG())
  await invoke('window.pantry.saveAppSettings({ language: "en" })')
  await until(() => invoke('document.querySelector(".range-import summary").textContent.includes("Add multiple")'), '英文即时切换')
  await invoke('document.querySelector(".range-import").scrollIntoView({ block: "start" }); true')
  await pause(100)
  fs.writeFileSync(path.join(artifacts, 'bulk-ranges-en.png'), (await settings.webContents.capturePage()).toPNG())
  console.log('批量网段真实界面 / IPC / 持久化 / 无扫描验收通过', artifacts)
  finished = true
  app.quit()
}
