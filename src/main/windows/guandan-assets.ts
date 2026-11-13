import { resolve, sep } from 'node:path'

/**
 * 把 `yangge-game://guandan/...` 映射到内嵌游戏资源目录。
 * 只接受 guandan authority，且结果必须落在 root 之内，避免路径穿越读取任意文件。
 */
export function resolveGuandanAsset(root: string, requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'yangge-game:' || url.host !== 'guandan') return null
  let rel: string
  try {
    rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  } catch {
    return null // 非法百分号编码
  }
  const base = resolve(root)
  const target = resolve(base, rel || 'index.html')
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}
