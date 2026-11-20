// Pi 回复通常是 Markdown 文档。这里做一个小而安全的渲染器：
// 只生成受控标签，所有原文先转义，避免模型输出直接变成可执行 HTML。

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/
const UL_RE = /^\s*[-*+]\s+(.+?)\s*$/
const OL_RE = /^\s*\d+[.)]\s+(.+?)\s*$/
const QUOTE_RE = /^\s*>\s?(.*)$/
const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInline(text: string): string {
  // 行内代码先切出来，避免代码里的星号/链接被再次解析。
  return text
    .split(/(`[^`\n]*`)/g)
    .map((part) => {
      if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`
      }
      return decorateText(part)
    })
    .join('')
}

function decorateText(text: string): string {
  // 先把链接替换成占位符，避免 URL 里的 & 在转义后又被 secondary escape。
  const links: string[] = []
  let html = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) => {
      const token = `\u0000PI_LINK_${links.length}\u0000`
      links.push(
        `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>`
      )
      return token
    }
  )
  html = escapeHtml(html)
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  html = html.replace(/\u0000PI_LINK_(\d+)\u0000/g, (_match, index: string) => links[Number(index)] ?? '')
  return html
}

function splitRow(line: string): string[] {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|')) value = value.slice(0, -1)
  return value.split('|').map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

function isTableSeparator(line: string): boolean {
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function isTableStart(lines: string[], index: number): boolean {
  return (
    index + 1 < lines.length &&
    lines[index].includes('|') &&
    isTableSeparator(lines[index + 1])
  )
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index]
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    isTableStart(lines, index)
  )
}

function renderTable(headerLine: string, separatorLine: string, bodyLines: string[]): string {
  const headers = splitRow(headerLine)
  const separators = splitRow(separatorLine)
  const alignments = headers.map((_header, index) => {
    const marker = separators[index] ?? ''
    if (marker.startsWith(':') && marker.endsWith(':')) return 'center'
    if (marker.endsWith(':')) return 'right'
    if (marker.startsWith(':')) return 'left'
    return ''
  })
  const alignClass = (index: number): string => {
    const alignment = alignments[index]
    return alignment ? ` class="md-align-${alignment}"` : ''
  }

  const head = headers
    .map((header, index) => `<th${alignClass(index)}>${renderInline(header)}</th>`)
    .join('')
  const rows = bodyLines
    .filter((line) => line.trim())
    .map((line) => {
      const cells = splitRow(line)
      const values = headers.map((_header, index) => cells[index] ?? '')
      return `<tr>${values
        .map((cell, index) => `<td${alignClass(index)}>${renderInline(cell)}</td>`)
        .join('')}</tr>`
    })
    .join('')

  return `<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
}

function renderListItems(items: string[]): string {
  return items
    .map((item) => {
      const task = /^\[([ xX])\]\s+(.+)$/.exec(item)
      if (!task) return `<li>${renderInline(item)}</li>`
      const checked = task[1].toLowerCase() === 'x'
      return `<li class="md-task-item"><span class="md-check${checked ? ' checked' : ''}" aria-hidden="true">${checked ? '✓' : ''}</span>${renderInline(task[2])}</li>`
    })
    .join('')
}

export function renderPiMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1][0]
      const minimum = fence[1].length
      const language = fence[2].replace(/[^A-Za-z0-9_+-]/g, '')
      const code: string[] = []
      index += 1
      while (index < lines.length) {
        const closing = new RegExp(`^\\s*${marker}{${minimum},}\\s*$`)
        if (closing.test(lines[index])) {
          index += 1
          break
        }
        code.push(lines[index])
        index += 1
      }
      const className = language ? ` class="language-${language}"` : ''
      output.push(`<pre class="md-code"><code${className}>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    if (isTableStart(lines, index)) {
      const header = lines[index]
      const separator = lines[index + 1]
      const body: string[] = []
      index += 2
      while (index < lines.length && lines[index].includes('|') && !isBlockStart(lines, index)) {
        body.push(lines[index])
        index += 1
      }
      output.push(renderTable(header, separator, body))
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      const level = heading[1].length
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      index += 1
      continue
    }

    if (HR_RE.test(line)) {
      output.push('<hr />')
      index += 1
      continue
    }

    if (QUOTE_RE.test(line)) {
      const quoted: string[] = []
      while (index < lines.length) {
        const match = QUOTE_RE.exec(lines[index])
        if (!match) break
        quoted.push(match[1])
        index += 1
      }
      output.push(`<blockquote>${renderPiMarkdown(quoted.join('\n'))}</blockquote>`)
      continue
    }

    const unordered = UL_RE.exec(line)
    if (unordered) {
      const items: string[] = []
      while (index < lines.length) {
        const match = UL_RE.exec(lines[index])
        if (!match) break
        items.push(match[1])
        index += 1
      }
      output.push(`<ul>${renderListItems(items)}</ul>`)
      continue
    }

    const ordered = OL_RE.exec(line)
    if (ordered) {
      const items: string[] = []
      const start = Number.parseInt((/^\s*(\d+)/.exec(line) ?? [])[1] ?? '1', 10)
      while (index < lines.length) {
        const match = OL_RE.exec(lines[index])
        if (!match) break
        items.push(match[1])
        index += 1
      }
      output.push(`<ol${start !== 1 ? ` start="${start}"` : ''}>${renderListItems(items)}</ol>`)
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraph.push(lines[index])
      index += 1
    }
    output.push(`<p>${paragraph.map(renderInline).join('<br />')}</p>`)
  }

  return output.join('\n')
}
