import { describe, expect, it } from 'vitest'
import { renderPiMarkdown } from './pi-markdown'

describe('Pi Markdown 渲染', () => {
  it('渲染标题、列表和表格', () => {
    const html = renderPiMarkdown(
      [
        '## 核心定位',
        '',
        '- 第一项',
        '- **第二项**',
        '',
        '| 部分 | 技术 |',
        '| --- | :---: |',
        '| 桌面端 | PySide6 |',
        '| Android | Kotlin |'
      ].join('\n')
    )

    expect(html).toContain('<h2>核心定位</h2>')
    expect(html).toContain('<li>第一项</li>')
    expect(html).toContain('<strong>第二项</strong>')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>部分</th>')
    expect(html).toContain('<td class="md-align-center">PySide6</td>')
  })

  it('代码块保留原文但转义 HTML', () => {
    const html = renderPiMarkdown(['```ts', 'const x = "<script>"', '```'].join('\n'))
    expect(html).toContain('<pre class="md-code"><code class="language-ts">')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('普通文本中的 HTML 和危险链接不会变成可执行标签', () => {
    const html = renderPiMarkdown(
      ['<img src=x onerror="alert(1)">', '', '[点我](javascript:alert(1))'].join('\n')
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('href="javascript')
    expect(html).toContain('[点我](javascript:alert(1))')
  })

  it('允许 http(s) 链接并安全转义属性', () => {
    const html = renderPiMarkdown('[文档](https://example.com/a?x=1&y=2)')
    expect(html).toContain('href="https://example.com/a?x=1&amp;y=2"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
  })
})
