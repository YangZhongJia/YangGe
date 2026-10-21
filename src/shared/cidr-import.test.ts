import { describe, expect, it } from 'vitest'
import { previewCidrImport, SCAN_IMPORT_MAX_LENGTH, SCAN_MAX_RANGES } from './cidr'

describe('批量网段预览', () => {
  it('按行归一网络地址并去重已有和本次输入，保留空行后的错误行号', () => {
    const result = previewCidrImport('10.1.2.88/24\r\n\n10.2.0.1/25\n10.2.0.99/25\n', ['10.1.2.0/24'])
    expect(result).toMatchObject({
      additions: ['10.2.0.0/25'], ranges: ['10.1.2.0/24', '10.2.0.0/25'],
      duplicateCount: 2, invalidLines: [], hostCount: 380, error: null
    })
    expect(previewCidrImport('\n10.1.2.0/24\n999.1.2.0/24\n10.0.0.0/21', []).invalidLines).toEqual([3, 4])
  })

  it('超过已有 20 段总额度时拒绝整批，而非静默截断', () => {
    const saved = Array.from({ length: SCAN_MAX_RANGES - 1 }, (_, i) => `10.${i}.0.0/24`)
    expect(previewCidrImport('10.40.0.0/24\n10.41.0.0/24', saved)).toMatchObject({ error: 'too-many' })
    expect(previewCidrImport('10.40.0.0/24', saved)).toMatchObject({ error: null })
  })

  it('保留每段 /22 上限，总地址预算为最多 20 段并按重叠去重', () => {
    const input = Array.from({ length: SCAN_MAX_RANGES }, (_, i) => `10.${i}.0.0/22`).join('\n')
    expect(previewCidrImport(input, [])).toMatchObject({ error: null, hostCount: 20 * 1022 })
    expect(previewCidrImport('10.0.0.0/24\n10.0.0.0/25', []).hostCount).toBe(254)
    expect(previewCidrImport('10.0.0.0/21', []).error).toBe('invalid')
  })

  it('空输入、全重复和超长输入都不能提交', () => {
    expect(previewCidrImport(' \n ', []).error).toBe('empty')
    expect(previewCidrImport('10.0.0.8/24', ['10.0.0.0/24']).error).toBe('empty')
    expect(previewCidrImport('a'.repeat(SCAN_IMPORT_MAX_LENGTH + 1), []).error).toBe('too-long')
  })
})
