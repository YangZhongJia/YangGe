<script setup lang="ts">
import type { PresenceStatus } from '../../../shared/protocol'

withDefaults(
  defineProps<{
    status?: PresenceStatus
    size?: number
  }>(),
  { size: 14 }
)
</script>

<template>
  <svg
    class="presence-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <g v-if="status === 'focus'">
      <circle cx="12" cy="12" r="6.8" />
      <circle cx="12" cy="12" r="3.3" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
    </g>
    <g v-else-if="status === 'meeting'">
      <circle cx="9" cy="9.2" r="2.3" />
      <path d="M4.8 17.5c.4-2.9 1.9-4.4 4.2-4.4s3.8 1.5 4.2 4.4" />
      <circle cx="16.4" cy="10.1" r="1.8" />
      <path d="M14.2 17.5c.3-2.3 1.4-3.5 3.1-3.5 1.6 0 2.7 1.2 3 3.5" />
    </g>
    <g v-else-if="status === 'lunch'">
      <path d="M4.6 12.4h14.8a7.4 7.4 0 0 1-14.8 0Z" />
      <path d="M8.2 9.2c.7-.8.7-1.8 0-2.6" />
      <path d="M12 9.2c.7-.8.7-1.8 0-2.6" />
      <path d="M15.8 9.2c.7-.8.7-1.8 0-2.6" />
    </g>
    <g v-else-if="status === 'slacking'">
      <path d="M5.2 12.3c2.8-3.4 7.6-4.2 11.2-1.4l3.4-2v6.8l-3.4-2c-3.6 2.8-8.4 2-11.2-1.4Z" />
      <circle cx="8.6" cy="11.8" r=".8" fill="currentColor" stroke="none" />
    </g>
    <g v-else-if="status === 'offWork'">
      <path d="M18.6 15.2A7.4 7.4 0 0 1 8.8 5.4 7.4 7.4 0 1 0 18.6 15.2Z" />
    </g>
    <g v-else>
      <circle cx="12" cy="12" r="6.4" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
    </g>
  </svg>
</template>

<style scoped>
.presence-icon {
  display: block;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
