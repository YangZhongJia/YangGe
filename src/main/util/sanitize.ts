// 接收文件相对路径清洗（AGENTS 红线：路径穿越防护，protocol §8）。
// 拒绝绝对路径、盘符、.. 段；剥离控制字符与文件系统保留字符（空格/连字符等正常字符保留）。

// eslint-disable-next-line no-control-regex
const BAD_CHARS = new RegExp('[<>:"|?*\\u0000-\\u001f]', 'g')

/** 所有平台统一规避 Windows 设备名与尾随点/空格，保证跨平台接收。 */
export function sanitizeWindowsName(name: string): string {
  const clean = name.replace(/[. ]+$/, '')
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean
}

/** 清洗 offer 里的相对路径；非法返回 null。返回值以 '/' 连接，落盘时再 join */
export function sanitizeRelPath(relPath: string): string | null {
  if (relPath.length === 0 || relPath.length > 512) return null
  const segments = relPath.split(/[/\\]+/)
  const clean: string[] = []
  for (const raw of segments) {
    if (/^[A-Za-z]:/.test(raw)) return null // 盘符必须在剥离 ':' 之前检查
    const segment = sanitizeWindowsName(raw.replace(BAD_CHARS, '').trim())
    if (segment === '' || segment === '.' || segment === '..') return null
    if (segment.length > 255) return null
    clean.push(segment)
  }
  return clean.length > 0 ? clean.join('/') : null
}
