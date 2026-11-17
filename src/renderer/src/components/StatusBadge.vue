<script setup lang="ts">
import { computed } from 'vue'
import type { PresenceStatus } from '../../../shared/protocol'
import { tr } from '../utils/i18n'
import { presenceStatusLabel } from '../utils/presence-status'
import PresenceIcon from './PresenceIcon.vue'

const props = withDefaults(
  defineProps<{
    status?: PresenceStatus
    away?: boolean
    online?: boolean
    /** 聊天头部已有头像点时可关掉，避免重复。 */
    dot?: boolean
  }>(),
  { online: true, dot: true }
)

const label = computed(() => {
  if (!props.online) return tr('离线')
  if (props.status && props.status !== 'online') return presenceStatusLabel(props.status)
  if (props.away) return tr('离开')
  return tr('在线')
})

const tone = computed(() => {
  if (!props.online) return 'offline'
  if (props.status && props.status !== 'online') return props.status
  if (props.away) return 'away'
  return 'online'
})

</script>

<template>
  <span class="status-badge" :class="`is-${tone}`">
    <PresenceIcon v-if="dot" class="status-badge-icon" :status="status" :size="13" />
    <span>{{ label }}</span>
  </span>
</template>

<style scoped>
.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  line-height: inherit;
  white-space: nowrap;
}
.status-badge-icon {
  flex: 0 0 auto;
  color: var(--text-3);
}
.status-badge.is-online .status-badge-icon {
  color: var(--online);
}
.status-badge.is-away .status-badge-icon {
  color: var(--away, #e8a13c);
}
.status-badge.is-focus .status-badge-icon {
  color: var(--primary);
}
.status-badge.is-meeting .status-badge-icon {
  color: #8b5cf6;
}
.status-badge.is-lunch .status-badge-icon {
  color: var(--away, #e8a13c);
}
.status-badge.is-slacking .status-badge-icon {
  color: #14b8a6;
}
.status-badge.is-offWork .status-badge-icon {
  color: #94a3b8;
}
</style>
