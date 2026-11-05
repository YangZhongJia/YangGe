<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { tr } from '../utils/i18n'
import type { ReleaseHighlights } from '../data/release-highlights'

defineProps<{
  highlights: ReleaseHighlights
  iconUrl: string
}>()

const emit = defineEmits<{ close: [] }>()
const closeButton = ref<HTMLButtonElement | null>(null)

function close(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  closeButton.value?.focus({ preventScroll: true })
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div class="highlights-mask" @click.self="close">
      <section class="highlights-card" role="dialog" aria-modal="true" aria-labelledby="highlights-title">
        <button
          type="button"
          class="highlights-close"
          :aria-label="tr('关闭')"
          @click="close"
        >×</button>
        <header class="highlights-head">
          <div class="highlights-brand">
            <img :src="iconUrl" alt="" draggable="false" />
            <span>WHAT'S NEW</span>
          </div>
          <p class="highlights-version">v{{ highlights.version }}</p>
          <h2 id="highlights-title">{{ tr('本次更新') }}</h2>
          <p class="highlights-subtitle">{{ tr('看看这个版本带来了什么。') }}</p>
        </header>

        <ul class="highlights-list">
          <li v-for="note in highlights.notes" :key="note" class="highlights-item">
            <span class="highlights-dot" aria-hidden="true"></span>
            <span>{{ tr(note) }}</span>
          </li>
          <li v-if="highlights.fixed" class="highlights-item highlights-fix">
            <span class="highlights-fix-badge">FIX</span>
            <span>{{ tr('优化已知 BUG') }}</span>
          </li>
        </ul>

        <footer class="highlights-footer">
          <button ref="closeButton" type="button" class="highlights-primary" @click="close">
            {{ tr('知道了') }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.highlights-mask {
  position: fixed;
  inset: 0;
  z-index: 2500;
  display: grid;
  place-items: center;
  padding: 28px;
  background: rgba(15, 23, 42, 0.48);
  backdrop-filter: blur(8px);
  animation: highlights-fade 180ms ease-out;
}
.highlights-card {
  position: relative;
  width: min(500px, calc(100vw - 40px));
  max-height: min(680px, calc(100vh - 56px));
  overflow: auto;
  padding: 30px 30px 24px;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--material-strong);
  box-shadow: var(--highlight-edge), 0 28px 90px rgba(15, 23, 42, 0.4);
  color: var(--text-1);
  animation: highlights-rise 280ms cubic-bezier(0.22, 1, 0.36, 1);
}
.highlights-close {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
.highlights-close:hover {
  background: var(--surface-hover);
  color: var(--text-1);
}
.highlights-head {
  text-align: center;
  padding: 2px 0 18px;
}
.highlights-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--primary);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.18em;
}
.highlights-brand img {
  width: 26px;
  height: 26px;
  border-radius: 8px;
}
.highlights-version {
  margin: 12px 0 4px;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
}
.highlights-head h2 {
  margin: 0;
  font-size: 24px;
  font-weight: 650;
  letter-spacing: 0.02em;
}
.highlights-subtitle {
  margin: 7px 0 0;
  color: var(--text-2);
  font-size: 13px;
}
.highlights-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 16px 0 4px;
  border-top: 1px solid var(--line);
  list-style: none;
}
.highlights-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.62;
}
.highlights-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  margin-top: 7px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-weak);
}
.highlights-fix {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px dashed var(--line);
  color: var(--text-2);
}
.highlights-fix-badge {
  flex: 0 0 auto;
  margin-top: 1px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--success-weak, #ecfdf5);
  color: var(--success, #047857);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.08em;
}
.highlights-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 18px;
}
.highlights-primary {
  min-width: 104px;
  height: 38px;
  padding: 0 18px;
  border: 1px solid var(--primary);
  border-radius: 10px;
  background: var(--primary);
  color: var(--on-primary);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 8px 20px var(--primary-weak);
}
.highlights-primary:hover {
  filter: brightness(1.06);
}
@keyframes highlights-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes highlights-rise {
  from { opacity: 0; transform: translateY(10px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .highlights-mask,
  .highlights-card {
    animation: none;
  }
}
</style>
