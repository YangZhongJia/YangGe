/** 按 UTF-8 字节上限截断，保留完整 Unicode 字符。 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return { text: out, truncated: true }
}
