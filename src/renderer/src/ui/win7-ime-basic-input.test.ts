import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function readSource(url: URL): string {
  return readFileSync(url, 'utf8').replace(/\r\n?/g, '\n')
}

const appSource = readSource(new URL('../App.vue', import.meta.url))
const chatPaneSource = readSource(new URL('../components/ChatPane.vue', import.meta.url))
const editorSource = readSource(new URL('../components/Win7ChatEditor.vue', import.meta.url))
const compatEmojiSource = readSource(new URL('../components/CompatEmoji.vue', import.meta.url))
const oldCaretHelper = new URL('../utils/win7-ime-caret.ts', import.meta.url)

describe('Win7 搜狗系统字体原子表情编辑器', () => {
  it('只由 Win7 平台标记启用独立编辑器', () => {
    expect(appSource).toContain(':win7-ime-compat="info?.windows7 === true"')
    expect(chatPaneSource).toContain('<Win7ChatEditor')
    expect(chatPaneSource).toContain('v-if="props.win7ImeCompat"')
    expect(chatPaneSource).toContain('v-else\n          ref="inputEl"')
  })

  it('真实编辑控件永久使用系统字体并保持实体输入层', () => {
    expect(editorSource).toContain(':contenteditable="disabled ? \'false\' : \'true\'"')
    expect(editorSource).toContain("font-family: 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif;")
    expect(editorSource).toContain('background: var(--bg-input);')
    expect(editorSource).toContain('padding: 6px 8px;')
    expect(editorSource).not.toContain('PantryEmojiBlank')
    expect(editorSource).not.toContain('<textarea')
  })

  it('Twemoji 作为 1.3em 原子节点参与原生 caret 布局', () => {
    expect(editorSource).toContain("image.dataset['editorEmoji'] = emoji")
    expect(editorSource).toContain("image.contentEditable = 'false'")
    expect(editorSource).toContain("image.src = twemojiUrl(emojiToTwemojiCode(emoji))")
    expect(editorSource).toContain('width: 1.3em;')
    expect(editorSource).toContain('height: 1.3em;')
    expect(compatEmojiSource).toContain('width: 1.3em;')
    expect(compatEmojiSource).toContain('height: 1.3em;')
  })

  it('UTF-16 选区映射覆盖面板插入、换行和提及', () => {
    expect(editorSource).toContain('if (emoji) return emoji.length')
    expect(editorSource).toContain('function logicalLength(node: Node): number')
    expect(editorSource).toContain('function selectionRange(): { start: number; end: number }')
    expect(editorSource).toContain('function setSelectionRange(start: number, end: number): void')
    expect(editorSource).toContain(
      'defineExpose({ focus, selectionRange, setSelectionRange, scrollTop })'
    )
    expect(chatPaneSource).toContain('function inputSelectionRange()')
    expect(chatPaneSource).toContain('function setInputSelection(start: number, end = start)')
    expect(chatPaneSource).toContain('if (mode === \'ctrlEnter\' && !modified && props.win7ImeCompat)')
  })

  it('composition 期间不重建 DOM，并拦截候选确认键', () => {
    expect(editorSource).toContain('let composing = false')
    expect(editorSource).toContain('@compositionstart="onCompositionStart"')
    expect(editorSource).toContain('@compositionend="onCompositionEnd"')
    expect(editorSource).toContain("emit('compositionstart')")
    expect(editorSource).toContain("emit('compositionend')")
    expect(editorSource).toContain('if (composing || editorText() === value) return')
    expect(chatPaneSource).toContain('const inputComposing = ref(false)')
    expect(chatPaneSource.match(/@compositionstart="onInputCompositionStart"/g)).toHaveLength(2)
    expect(chatPaneSource.match(/@compositionend="onInputCompositionEnd"/g)).toHaveLength(2)
    const guard = chatPaneSource.indexOf(
      'if (isImeCompositionKey(event, inputComposing.value)) return'
    )
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(chatPaneSource.indexOf("if (event.key === '@'", guard))
    expect(guard).toBeLessThan(chatPaneSource.indexOf("if (event.key !== 'Enter')", guard))
    expect(chatPaneSource).not.toContain('props.win7ImeCompat && (event.isComposing')
  })

  it('纯文本粘贴归一换行，图片粘贴同步拦截浏览器默认嵌入', () => {
    expect(editorSource).toContain("const normalized = text.replace(/\\r\\n?/g, '\\n')")
    expect(editorSource).toContain("const text = event.clipboardData?.getData('text/plain')")
    expect(editorSource).toContain('event.preventDefault()')
    expect(editorSource).toContain("if (!el.textContent && !el.querySelector('img[data-editor-emoji]')) return ''")
  })

  it('撤销 Win7 textarea 空白字体与展示覆盖层', () => {
    expect(chatPaneSource).toContain(
      '!props.win7ImeCompat && draftEmojiParts.value.some((part) => part.emoji)'
    )
    expect(chatPaneSource).not.toContain('win7-ime-safe-input')
    expect(chatPaneSource).not.toContain('win7-ime-emoji-overlay')
    expect(existsSync(oldCaretHelper)).toBe(false)
    expect(chatPaneSource).not.toContain('pulseWin7ImeCaretGeometry')
    expect(chatPaneSource).not.toContain('resetWin7ImeCaretGeometry')
  })
})
