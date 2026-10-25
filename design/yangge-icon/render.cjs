// 使用项目已有 Electron 渲染预览，无额外依赖。运行：electron design/yangge-icon/render.cjs
const { app, BrowserWindow, nativeImage } = require('electron')
const { writeFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1560, height: 1060, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  await win.loadFile(join(__dirname, 'preview.html'))
  await win.webContents.executeJavaScript('Promise.all(Array.from(document.images, img => img.decode()))')
  const board = await win.webContents.capturePage()
  assert.equal(board.getSize().width, 1560)
  writeFileSync(join(__dirname, 'preview.png'), board.toPNG())
  for (const name of ['yangge-flight', 'yangge-rest', 'yangge-letter']) {
    const svg = readFileSync(join(__dirname, name + '.svg'), 'utf8')
    const data = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = 1024; c.getContext('2d').drawImage(img, 0, 0, 1024, 1024); resolve(c.toDataURL('image/png')); }; img.onerror = reject; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
    })`)
    const png = Buffer.from(data.split(',')[1], 'base64')
    assert.equal(nativeImage.createFromBuffer(png).getSize().width, 1024)
    writeFileSync(join(__dirname, name + '.png'), png)
  }
  console.log('Preview and three 1024px icons rendered successfully.')
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
