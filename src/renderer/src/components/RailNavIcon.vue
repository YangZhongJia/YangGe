<script setup lang="ts">
// Local Lucide 0.468.0 artwork; see build/licenses/navigation-icons.txt.
// Keep these navigation glyphs separate from the smaller in-content icon family.
withDefaults(
  defineProps<{
    name: 'chat' | 'contacts' | 'cabinet' | 'settings' | 'agent' | 'tasks' | 'ai'
    size?: number
  }>(),
  { size: 28 }
)
</script>

<template>
  <svg
    class="rail-icon"
    :data-icon="name"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <!-- lucide: message-circle; original geometry, optical stroke weight set on the root. -->
    <g v-if="name === 'chat'">
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </g>
    <!-- lucide: users; original geometry, optical stroke weight set on the root. -->
    <g v-else-if="name === 'contacts'">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </g>
    <!-- lucide: package-2; original geometry, optical stroke weight set on the root. -->
    <g v-else-if="name === 'cabinet'">
      <path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Z" />
      <path d="m3 9 2.45-4.9A2 2 0 0 1 7.24 3h9.52a2 2 0 0 1 1.8 1.1L21 9" />
      <path d="M12 3v6" />
    </g>
    <!-- lucide: bot; original geometry, optical stroke weight set on the root. -->
    <g v-else-if="name === 'agent'">
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </g>
    <!-- AI programming: sparkle indicates the Pi workspace. -->
    <g v-else-if="name === 'ai'">
      <path d="M12 3.2 13.9 8 18.7 9.9l-4.8 1.9L12 16.6l-1.9-4.8L5.3 9.9 10.1 8 12 3.2Z" />
      <path d="m18.3 15.3.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" />
    </g>
    <!-- lucide: list-checks; local geometry for the task records entry. -->
    <g v-else-if="name === 'tasks'">
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </g>
    <!-- lucide: settings; original geometry, optical stroke weight set on the root. -->
    <g v-else-if="name === 'settings'">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </g>
  </svg>
</template>

<style scoped>
.rail-icon {
  display: block;
  flex-shrink: 0;
  pointer-events: none;
}
</style>
