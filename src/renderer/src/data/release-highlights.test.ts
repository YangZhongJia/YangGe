import { describe, expect, it } from 'vitest'
import { releaseHighlightsFor } from './release-highlights'

describe('版本亮点', () => {
  it('当前版本列出新增项，并保留一句已知 BUG 优化', () => {
    const current = releaseHighlightsFor('1.11.8')
    expect(current?.notes.length).toBeGreaterThan(0)
    expect(current?.fixed).toBe(true)
  })

  it('未登记的新版本仍有更新提示，空版本不弹窗', () => {
    expect(releaseHighlightsFor('v2.0.0')).toMatchObject({
      version: '2.0.0',
      notes: [],
      fixed: true
    })
    expect(releaseHighlightsFor('  ')).toBeNull()
  })
})
