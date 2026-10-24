<script setup lang="ts">
import { computed } from 'vue'
import type { ScreenRecord } from '../../../shared/remote-view'
import { screenDuration, screenRecordText } from '../../../i18n/messages'
import { tr } from '../utils/i18n'
import { separatorTime } from '../utils/time'
import { screenStatusText } from '../utils/remote-view-text'
import PantryIcon from './PantryIcon.vue'
const props = defineProps<{ record: ScreenRecord }>()
function time(ts: number): string { return `${separatorTime(ts)}:${String(new Date(ts).getSeconds()).padStart(2, '0')}` }
const duration = computed(() => props.record.durationMs === undefined ? tr('未知') : screenDuration(props.record.durationMs))
const details = computed(() => {
  const r = props.record
  const lines = [`${tr('屏幕协助')} · ${tr('仅查看')}`,
    tr(r.role === 'viewer' ? '你请求查看对方屏幕' : '对方请求查看你的屏幕'), screenRecordText(r, tr),
    `${tr('请求时间')}：${time(r.requestedAt)}`]
  if (r.startedAt !== undefined) lines.push(`${tr('开始时间')}：${time(r.startedAt)}`)
  if (r.phase === 'ended') {
    lines.push(`${tr('结束时间')}：${r.endedAt === undefined ? tr('未知') : time(r.endedAt)}`)
    if (r.startedAt !== undefined) lines.push(`${tr('持续时间')}：${duration.value}`)
  }
  return lines.join('\n')
})
</script>

<template>
  <article class="screen-card" :class="{ mine: record.role === 'viewer', active: record.phase === 'active' }" :title="details" :aria-label="details">
    <PantryIcon name="screen" :size="20" />
    <div>
      <header><strong>{{ tr('屏幕协助') }}</strong><span aria-live="polite">{{ screenStatusText(record) }}</span></header>
      <p>
        <span>{{ separatorTime(record.startedAt ?? record.requestedAt) }}</span>
        <span>· {{ record.phase === 'ended' && record.startedAt !== undefined ? tr('时长 {0}', { 0: duration }) : tr('仅查看') }}</span>
      </p>
    </div>
  </article>
</template>

<style scoped>
.screen-card { width: 260px; max-width: 100%; display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-panel); color: var(--text-1); background: var(--bubble-peer); font-size: var(--font-sm); line-height: 1.5; }
.mine { background: var(--bubble-mine); border-color: transparent; color: #ffffff; }
.mine header strong { color: #ffffff; }
.mine header span,
.mine p { color: rgba(255, 255, 255, 0.86); }
header, p { display: flex; flex-wrap: wrap; gap: 2px 8px; }
header { justify-content: space-between; align-items: baseline; }
header span, p { font-size: var(--font-xs); color: var(--text-2); }
.active header span { color: var(--primary); }
.mine.active header span { color: #e6e9fd; }
p { margin: 4px 0 0; }
</style>
