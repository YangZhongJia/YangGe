/* 阳鸽 YangGe 图标离屏渲染：SVG → 各尺寸 PNG（母版1024 / 窗口与品牌256 / 托盘32） */
const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const OUT = process.argv[2] || 'build/icons/_yangge'
mkdirSync(OUT, { recursive: true })

const SVG = String.raw`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6C5CFF"/>
      <stop offset="1" stop-color="#4636D6"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1024" height="1024" rx="228" fill="url(#bg)"/>
  <circle cx="742" cy="280" r="106" fill="#FFC53D"/>
  <circle cx="782" cy="234" r="20" fill="#FFDD7F" opacity="0.9"/>
  <g transform="translate(-420,-393) scale(1.75)">
    <polygon points="552,552 402,650 566,606" fill="#FFFFFF"/>
    <polygon points="552,542 424,330 540,516" fill="#FFFFFF"/>
    <polygon points="586,546 512,384 618,538" fill="#E7E4FF"/>
    <path d="M 708,556 L 646,506 L 566,544 L 552,552 L 586,588 L 664,576 Z" fill="#FFFFFF"/>
    <circle cx="664" cy="530" r="9" fill="#4636D6"/>
  </g>
</svg>`

const SIZES = [
  { name: 'master-1024.png', size: 1024 },
  { name: 'icon-256.png', size: 256 },
  { name: 'icon-32.png', size: 32 }
]

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  const html =
    'data:text/html;charset=utf-8,' +
    encodeURIComponent('<body style="margin:0"></body>')
  await win.loadURL(html)
  for (const { name, size } of SIZES) {
    const dataUrl = await win.webContents.executeJavaScript(`(function(){
      return new Promise(function(resolve){
        var svg = ${JSON.stringify(SVG)};
        var blob = new Blob([svg], {type:'image/svg+xml'});
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function(){
          var c = document.createElement('canvas');
          c.width = ${size}; c.height = ${size};
          var ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, ${size}, ${size});
          URL.revokeObjectURL(url);
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = function(){ resolve(null) };
        img.src = url;
      })
    })()`)
    if (!dataUrl) throw new Error('render failed for ' + name)
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
    writeFileSync(join(OUT, name), buf)
    console.log('wrote', name, buf.length, 'bytes')
  }
  app.quit()
})
