import { describe, expect, it } from 'vitest'
import { fitFileName } from './file-name'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const width = (text: string): number => Array.from(segmenter.segment(text)).length

describe('文件名中间省略', () => {
  it('短名称和恰好容纳的名称保留原文', () => {
    expect(fitFileName('报告.pdf', 6, width)).toBe('报告.pdf')
    expect(fitFileName('', 0, width)).toBe('')
  })

  it('相同长前缀仍能区分末尾，保留完整扩展名', () => {
    expect(fitFileName('项目周报统一前缀-甲.docx', 10, width)).toBe('项目周…甲.docx')
    expect(fitFileName('项目周报统一前缀-乙.docx', 10, width)).toBe('项目周…乙.docx')
    expect(fitFileName('abcdefgh.docx', 7, width)).toBe('a….docx')
  })

  it('按字形实际宽度适配，容器变宽后恢复全名', () => {
    const mixedWidth = (text: string): number => Array.from(text).reduce((n, c) => n + (/[^\x00-\x7f]/.test(c) ? 2 : 1), 0)
    const name = '部门总结文件-2026.pdf'
    const fitted = fitFileName(name, 15, mixedWidth)
    expect(mixedWidth(fitted)).toBeLessThanOrEqual(15)
    expect(fitted).toMatch(/^部.*….*6\.pdf$/)
    expect(fitFileName(name, 100, mixedWidth)).toBe(name)
  })

  it('不拆开组合字符或 emoji 字素', () => {
    const name = '👨‍👩‍👧‍👦e\u0301很长的文件名字👩🏽‍💻.pdf'
    expect(fitFileName(name, 9, width)).toBe('👨‍👩‍👧‍👦e\u0301很…👩🏽‍💻.pdf')
  })

  it('无扩展名、隐藏文件与极窄空间仍安全省略', () => {
    expect(fitFileName('项目资料归档文件夹', 5, width)).toBe('项目…件夹')
    expect(fitFileName('.hidden-config', 7, width)).toBe('.hi…fig')
    expect(fitFileName('long.txt', 1, width)).toBe('…')
  })
})
