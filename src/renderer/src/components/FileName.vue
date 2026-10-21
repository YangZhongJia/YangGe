<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { fitFileName } from '../utils/file-name'

const props = defineProps<{ name: string }>()
const label = ref<HTMLElement>()
const probe = ref<HTMLElement>()
const popup = ref<HTMLElement>()
const displayed = ref(props.name)
const truncated = computed(() => displayed.value !== props.name)
const visible = ref(false)
const position = ref({ left: '0px', top: '0px' })
const tooltipId = useId()
let observer: ResizeObserver | undefined

function fit(): void {
  if (!label.value || !probe.value) return
  const measure = (text: string): number => {
    probe.value!.textContent = text
    return probe.value!.getBoundingClientRect().width
  }
  displayed.value = fitFileName(props.name, label.value.getBoundingClientRect().width, measure)
  hide()
}

function hide(): void {
  visible.value = false
  window.removeEventListener('scroll', hide, true)
  window.removeEventListener('resize', hide)
  window.removeEventListener('blur', hide)
}

async function show(): Promise<void> {
  if (!truncated.value || !label.value) return
  visible.value = true
  window.addEventListener('scroll', hide, true)
  window.addEventListener('resize', hide)
  window.addEventListener('blur', hide)
  await nextTick()
  if (!visible.value || !popup.value || !label.value) return
  const anchor = label.value.getBoundingClientRect()
  const box = popup.value.getBoundingClientRect()
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8))
  const below = anchor.bottom + 6
  const top = below + box.height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - box.height - 6)
  position.value = { left: `${left}px`, top: `${top}px` }
}

onMounted(() => {
  observer = new ResizeObserver(fit)
  observer.observe(label.value!)
  fit()
  void document.fonts.ready.then(fit)
})
watch(() => props.name, fit, { flush: 'post' })
onBeforeUnmount(() => { observer?.disconnect(); hide() })
</script>

<template>
  <span
    ref="label" class="file-name" :aria-label="name" :tabindex="truncated ? 0 : undefined"
    :aria-describedby="visible ? tooltipId : undefined"
    @mouseenter="show" @mouseleave="hide" @focus="show" @blur="hide"
    @keydown.esc.stop="hide" @contextmenu="hide"
  >{{ displayed }}<span ref="probe" class="file-name-probe" aria-hidden="true"></span>
    <Teleport to="body">
      <div v-if="visible" :id="tooltipId" ref="popup" role="tooltip" class="file-name-popup" :style="position">{{ name }}</div>
    </Teleport>
  </span>
</template>

<style scoped>
.file-name {
  display: block;
  min-width: 0;
  overflow: hidden;
  white-space: pre;
}
.file-name-probe {
  position: fixed;
  left: 0;
  top: 0;
  width: max-content;
  visibility: hidden;
  pointer-events: none;
}
.file-name-popup {
  position: fixed;
  z-index: 1000;
  width: max-content;
  max-width: min(480px, calc(100vw - 16px));
  padding: 8px 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--material-strong);
  box-shadow: var(--shadow-float);
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  pointer-events: none;
}
</style>
