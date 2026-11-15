/** PIN effects receive slot indices only; they never retain the PIN itself. */
export function pinInputSlots(previous: string, next: string, edit?: { start: number; end: number }): number[] {
  if (edit) {
    const start = Math.max(0, Math.min(6, edit.start))
    const removed = Math.max(0, Math.min(previous.length, edit.end) - start)
    const inserted = next.length - (previous.length - removed)
    if (inserted <= 0) return []
    return Array.from({ length: Math.min(inserted, 6 - start) }, (_, index) => start + index)
  }
  if (next.length < previous.length || next === previous) return []
  let start = 0
  while (start < previous.length && previous[start] === next[start]) start += 1
  let end = next.length
  let oldEnd = previous.length
  while (oldEnd > start && end > start && previous[oldEnd - 1] === next[end - 1]) { oldEnd -= 1; end -= 1 }
  return Array.from({ length: Math.max(0, Math.min(6, end) - start) }, (_, index) => start + index)
}
