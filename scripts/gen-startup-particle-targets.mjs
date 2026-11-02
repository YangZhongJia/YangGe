// 生成启动动效的粒子目标点：从 build/icons/pantry-logo-icon.png 的 alpha + 亮度轮廓里
// 采样白色飞鸽区域，按 160×160 网格量化后打包成 base64（每点 2 字节）。
// 运行时只解码这张小表，不再解码 1024×1024 大图，避免每次启动都做一次像素扫描。
// 用法：node scripts/gen-startup-particle-targets.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const SAMPLE = 160
const SUPERSAMPLE = 4
const ALPHA_MIN = 140
const LUMA_MIN = 176
const PNG_SIGNATURE = '89504e470d0a1a0a'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'build/icons/pantry-logo-icon.png')
const outFile = join(root, 'src/renderer/src/utils/particle-targets.generated.ts')

function paethPredictor(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function unfilterScanline(filter, line, prev, bpp) {
  const out = Buffer.from(line)
  for (let i = 0; i < out.length; i++) {
    const left = i >= bpp ? out[i - bpp] : 0
    const up = prev ? prev[i] : 0
    const upLeft = prev && i >= bpp ? prev[i - bpp] : 0
    if (filter === 1) out[i] = (out[i] + left) & 0xff
    else if (filter === 2) out[i] = (out[i] + up) & 0xff
    else if (filter === 3) out[i] = (out[i] + Math.floor((left + up) / 2)) & 0xff
    else if (filter === 4) out[i] = (out[i] + paethPredictor(left, up, upLeft)) & 0xff
    else if (filter !== 0) throw new Error(`不支持的 PNG filter: ${filter}`)
  }
  return out
}

function decodePngRgba(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    throw new Error(`${source} 不是 PNG`)
  }
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const data = buffer.subarray(dataStart, dataEnd)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('不支持隔行扫描 PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`不支持的 PNG 格式: bitDepth=${bitDepth} colorType=${colorType}`)
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const inflated = inflateSync(Buffer.concat(idat))
  const rgba = Buffer.alloc(width * height * 4)
  let src = 0
  let prev = null
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++]
    const line = unfilterScanline(filter, inflated.subarray(src, src + stride), prev, channels)
    src += stride
    prev = line
    for (let x = 0; x < width; x++) {
      const from = x * channels
      const to = (y * width + x) * 4
      rgba[to] = line[from]
      rgba[to + 1] = line[from + 1]
      rgba[to + 2] = line[from + 2]
      rgba[to + 3] = channels === 4 ? line[from + 3] : 255
    }
  }
  return { width, height, rgba }
}

const png = decodePngRgba(readFileSync(source))
if (png.width !== png.height) throw new Error(`图标必须是正方形，当前 ${png.width}x${png.height}`)

/** 目标像素内 4×4 超采样，得到接近浏览器缩放的平滑边缘。 */
function sampleAt(dx, dy) {
  const cellW = png.width / SAMPLE
  const cellH = png.height / SAMPLE
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    const py = Math.min(png.height - 1, Math.floor((dy + (sy + 0.5) / SUPERSAMPLE) * cellH))
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const px = Math.min(png.width - 1, Math.floor((dx + (sx + 0.5) / SUPERSAMPLE) * cellW))
      const index = (py * png.width + px) * 4
      r += png.rgba[index]
      g += png.rgba[index + 1]
      b += png.rgba[index + 2]
      a += png.rgba[index + 3]
    }
  }
  const n = SUPERSAMPLE * SUPERSAMPLE
  return { r: r / n, g: g / n, b: b / n, a: a / n }
}

// 圆角方卡是不透明靛蓝底，单看 alpha 会取到整张卡片；再叠亮度阈值才能只留下白色飞鸽。
const mask = new Uint8Array(SAMPLE * SAMPLE)
for (let y = 0; y < SAMPLE; y++) {
  for (let x = 0; x < SAMPLE; x++) {
    const { r, g, b, a } = sampleAt(x, y)
    if (a < ALPHA_MIN) continue
    if (0.2126 * r + 0.7152 * g + 0.0722 * b > LUMA_MIN) mask[y * SAMPLE + x] = 1
  }
}

// 3×3 腐蚀：去掉素材卡片底部 2–3px 的亮边高光，避免它被当成一整行散点。
const solid = new Uint8Array(SAMPLE * SAMPLE)
for (let y = 1; y < SAMPLE - 1; y++) {
  for (let x = 1; x < SAMPLE - 1; x++) {
    const i = y * SAMPLE + x
    if (!mask[i]) continue
    let full = true
    for (let dy = -1; dy <= 1 && full; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!mask[i + dy * SAMPLE + dx]) { full = false; break }
      }
    }
    if (full) solid[i] = 1
  }
}

const edge = []
const inner = []
for (let y = 1; y < SAMPLE - 1; y++) {
  for (let x = 1; x < SAMPLE - 1; x++) {
    if (!solid[y * SAMPLE + x]) continue
    let isEdge = false
    for (let dy = -2; dy <= 2 && !isEdge; dy += 2) {
      for (let dx = -2; dx <= 2; dx += 2) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= SAMPLE || ny >= SAMPLE || !solid[ny * SAMPLE + nx]) {
          isEdge = true
          break
        }
      }
    }
    if (isEdge) edge.push(x, y)
    else if (((x + y) & 1) === 0) inner.push(x, y)
  }
}

if (edge.length < 800 || inner.length < 800) {
  throw new Error(`目标点太少：edge=${edge.length / 2} inner=${inner.length / 2}`)
}

function pack(points) {
  return Buffer.from(points).toString('base64')
}

writeFileSync(
  outFile,
  `// 由 scripts/gen-startup-particle-targets.mjs 从 build/icons/pantry-logo-icon.png 生成，不要手改。
// 每点两个字节（x, y），坐标范围 0..${SAMPLE - 1}，共 ${SAMPLE}×${SAMPLE} 网格。
export const TARGET_SAMPLE = ${SAMPLE}
export const EDGE_TARGETS_PACKED = '${pack(edge)}'
export const INNER_TARGETS_PACKED = '${pack(inner)}'
`
)

console.log(
  `[startup-particle] 写入 ${outFile}\n` +
    `[startup-particle] edge=${edge.length / 2} inner=${inner.length / 2} sample=${SAMPLE}`
)
