<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import NudgeEffect from './components/NudgeEffect.vue'
import type { DesktopNudgeEvent } from '../../shared/ipc'

const fx = ref<InstanceType<typeof NudgeEffect> | null>(null)
let stop: (() => void) | null = null

onMounted(async () => {
  await nextTick()
  stop = window.pantry.onDesktopNudge(async (event: DesktopNudgeEvent) => {
    await nextTick()
    await fx.value?.play('in', event.style)
  })
})

onBeforeUnmount(() => {
  stop?.()
  stop = null
})
</script>

<template>
  <NudgeEffect ref="fx" />
</template>

<style>
html[data-window='desktop-effect'],
html[data-window='desktop-effect'] body,
html[data-window='desktop-effect'] #app {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: transparent !important;
}
</style>
