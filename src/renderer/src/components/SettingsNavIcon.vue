<script setup lang="ts">
withDefaults(
  defineProps<{
    name: string
    size?: number
  }>(),
  { size: 18 }
)
</script>

<template>
  <!-- 设置侧栏专用图标（决议 #239）：同一 24px 网格与 1.6px 圆角线条。 -->
  <svg
    class="settings-nav-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <g v-if="name === 'settings-profile'">
      <rect x="4.5" y="5.2" width="15" height="13.6" rx="2.5" />
      <circle cx="9.2" cy="10" r="2.1" />
      <path d="M6.8 15.5c.4-1.9 1.2-2.8 2.4-2.8s2 .9 2.4 2.8" />
      <path d="M14.2 9h2.7" />
      <path d="M14.2 12h2.7" />
      <path d="M14.2 15h1.9" />
    </g>
    <g v-else-if="name === 'settings-general'">
      <path d="M5 7h2.5" />
      <path d="M10.5 7H19" />
      <circle cx="9" cy="7" r="1.5" />
      <path d="M5 12h8" />
      <path d="M16 12h3" />
      <circle cx="14.5" cy="12" r="1.5" />
      <path d="M5 17h4.5" />
      <path d="M12.5 17H19" />
      <circle cx="11" cy="17" r="1.5" />
    </g>
    <g v-else-if="name === 'settings-notify'">
      <path d="M7.2 16.5v-5.2a4.8 4.8 0 0 1 9.6 0v5.2" />
      <path d="M5.5 16.5h13" />
      <path d="M10 19a2.2 2.2 0 0 0 4 0" />
      <path d="M12 6.5V4.8" />
    </g>
    <g v-else-if="name === 'settings-storage'">
      <path d="M4.5 5.5h11.8v9.2H9.2l-3.8 2.8.8-2.8H4.5V5.5Z" />
      <path d="M13.3 10.2h3.4l2.3 2.3v6h-5.7v-8.3Z" />
      <path d="M16.7 10.2v2.3H19" />
      <path d="M15.3 15.2H17" />
    </g>
    <g v-else-if="name === 'settings-network'">
      <circle cx="12" cy="6.5" r="2.2" />
      <circle cx="6.5" cy="17" r="2.2" />
      <circle cx="17.5" cy="17" r="2.2" />
      <path d="M12 8.7v3" />
      <path d="M6.5 14.8v-1.3c0-1 .8-1.8 1.8-1.8h7.4c1 0 1.8.8 1.8 1.8v1.3" />
    </g>
    <g v-else-if="name === 'settings-shortcuts'">
      <rect x="4.5" y="6.2" width="15" height="11.6" rx="2.2" />
      <path d="M7.5 9.8h.1" />
      <path d="M10.5 9.8h.1" />
      <path d="M13.5 9.8h.1" />
      <path d="M16.5 9.8h.1" />
      <path d="M7.5 13h.1" />
      <path d="M10.5 13h.1" />
      <path d="M13.5 13h3" />
      <path d="M8.5 15.7h7" />
    </g>
    <g v-else-if="name === 'settings-about'">
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 11.2v4.8" />
      <path d="M12 8h.01" />
    </g>
  </svg>
</template>

<style scoped>
.settings-nav-icon {
  display: block;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
