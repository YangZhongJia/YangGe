<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { tr } from '../utils/i18n'
import { isPlainEscape } from '../utils/escape'
import PantryIcon from './PantryIcon.vue'
defineProps<{ name: string; ip: string; busy: boolean }>()
const emit = defineEmits<{ close: []; confirm: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
let previous: HTMLElement | null = null
onMounted(() => {
  previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.showModal()
})
onBeforeUnmount(() => { dialog.value?.close(); if (previous?.isConnected) previous.focus() })
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !isPlainEscape(event)) event.preventDefault()
}
</script>

<template>
  <dialog ref="dialog" class="screen-confirm" aria-modal="true" aria-labelledby="screen-request-title"
    aria-describedby="screen-request-hint" @cancel.prevent="!busy && emit('close')" @keydown="keydown" @click.stop>
    <h3 id="screen-request-title"><PantryIcon name="screen" :size="20" />{{ tr('请求查看屏幕') }}</h3>
    <p><strong>{{ name }}</strong><small>{{ ip }}</small></p>
    <p id="screen-request-hint">{{ tr('对方同意并选择屏幕后才会开始共享。你只能查看画面，无法操作对方电脑；双方都可以随时结束。') }}</p>
    <div class="actions">
      <button autofocus :disabled="busy" @click="emit('close')">{{ tr('取消') }}</button>
      <button class="primary" :disabled="busy" @click="emit('confirm')">{{ busy ? tr('正在发送…') : tr('发送请求') }}</button>
    </div>
  </dialog>
</template>

<style scoped>
.screen-confirm { width: min(400px, calc(100vw - 40px)); margin: auto; padding: 20px; border: 1px solid var(--line); border-radius: 8%; color: var(--text-1); background: var(--bg-window); box-shadow: var(--shadow-float); font-size: var(--font-sm); }
.screen-confirm::backdrop { background: var(--scrim); }
h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 16px; font-size: var(--font-lg); }
p { margin: 0 0 16px; line-height: 1.7; overflow-wrap: anywhere; }
small { display: block; color: var(--text-2); font-size: var(--font-xs); }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
button { min-height: 32px; padding: 5px 16px; border: 1px solid var(--line); border-radius: var(--radius-control); font: inherit; color: inherit; background: var(--bg-window); cursor: pointer; }
button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
button.primary { background: var(--primary-weak); border-color: var(--primary); font-weight: 600; }
button:disabled { opacity: .5; cursor: default; }
</style>
