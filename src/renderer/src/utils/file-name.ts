const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** 按实际排版宽度省略中间，保留两端；空间允许时优先保留完整扩展名。 */
export function fitFileName(name: string, width: number, measure: (text: string) => number): string {
  if (measure(name) <= width) return name
  const chars = Array.from(graphemes.segment(name), part => part.segment)
  const dot = chars.lastIndexOf('.')
  const extension = dot > 0 ? chars.length - dot : 0
  let result = '…'
  let low = 2
  let high = chars.length - 1
  while (low <= high) {
    const count = Math.floor((low + high) / 2)
    const tail = Math.max(Math.ceil(count / 2), Math.min(extension + 1, count - 1))
    const candidate = chars.slice(0, count - tail).join('') + '…' + chars.slice(-tail).join('')
    if (measure(candidate) <= width) {
      result = candidate
      low = count + 1
    } else {
      high = count - 1
    }
  }
  return result
}
