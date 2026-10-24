import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const messageSource = readFileSync(new URL('../components/MessageRow.vue', import.meta.url), 'utf8')
const fileCardSource = readFileSync(new URL('../components/FileCard.vue', import.meta.url), 'utf8')
const fileIconSource = readFileSync(new URL('../components/FileTypeIcon.vue', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../SettingsApp.vue', import.meta.url), 'utf8')

function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `缺少样式规则 ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

function readPngHeader(path: URL): { width: number; height: number; bitDepth: number; colorType: number } {
  const png = readFileSync(path)
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colorType: png[25]
  }
}

describe('消息与文件视觉统一', () => {
  it('文字气泡移除顶部高光（Iris：己方实色靛蓝无阴影）', () => {
    expect(ruleBody(messageSource, '.row.peer .bubble')).not.toContain('--highlight-edge')
    expect(ruleBody(messageSource, '.row.mine .bubble')).not.toContain('--highlight-edge')
    expect(ruleBody(messageSource, '.row.mine .bubble')).toContain('box-shadow: none')
    expect(ruleBody(messageSource, '.row.mine .bubble')).toContain('color: #ffffff')
  })

  it('文字气泡使用 16px 均匀圆角且无尾尖，文件卡保持面板圆角', () => {
    expect(ruleBody(messageSource, '.bubble')).toContain('border-radius: 16px')
    expect(messageSource).not.toContain('.bubble::before')
    expect(messageSource).not.toContain('border-top-left-radius')
    expect(fileCardSource).toContain('border-radius: var(--radius-panel)')
  })

  it('发送方主动取消使用独立的灰色状态，不落入失败重发入口', () => {
    expect(fileCardSource).toContain("props.msg.status === 'canceled' ? tr('发送取消') : tr('已取消')")
    expect(fileCardSource).toContain("if (props.msg.status === 'canceled') return tr('发送取消')")
    expect(messageSource).toContain("v-else-if=\"props.msg.status === 'canceled'\"")
    expect(messageSource).toContain(":title=\"tr('发送取消')\"")
    expect(ruleBody(messageSource, '.status .canceled')).toContain('color: var(--text-3)')
  })

  it('历史引用按消息 ID 补载，缺失时显示可见提示', () => {
    expect(messageSource).toContain('await chatStore.getMessageById(replyTo)')
    expect(messageSource).toContain("message?.convId === convId ? message : null")
    expect(messageSource).toContain("'原消息不可用'")
  })

  it('普通文件到期按收发方向显示独立提示', () => {
    expect(fileCardSource).toContain("t.direction === 'out' ? tr('发送已到期') : tr('文件已过期')")
    expect(fileCardSource).toContain("if (expired > 0 && !active) return tr('发送已到期')")
    expect(settingsSource).toContain("view.direction === 'out' ? tr('发送已到期') : tr('文件已过期')")
  })

  it('文件类型 atlas 是 512 RGBA PNG', () => {
    expect(
      readPngHeader(new URL('../assets/file-types/file-type-atlas.png', import.meta.url))
    ).toEqual({ width: 512, height: 512, bitDepth: 8, colorType: 6 })
  })

  it('文件类型组件使用 atlas 并覆盖全部类型', () => {
    expect(fileIconSource).toContain("file-type-atlas.png?url")
    expect(fileIconSource).not.toContain('<svg')
    const atlasPositions = fileIconSource.match(/const ATLAS_POS[\s\S]*?\n\}/)?.[0] ?? ''
    for (const type of [
      'word', 'excel', 'ppt', 'pdf', 'archive', 'image', 'audio', 'video',
      'text', 'code', 'app', 'generic', 'folder'
    ]) {
      expect(atlasPositions).toContain(`${type}: [`)
    }
  })
})
