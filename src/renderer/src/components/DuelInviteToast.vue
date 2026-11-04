<script setup lang="ts">
import { tr } from '../utils/i18n'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useDuelStore } from '../stores/duel'
import { usePeersStore } from '../stores/peers'
import AvatarMark from './AvatarMark.vue'

// 非阻塞邀请提示：用户正在别的会话时也能看到并接受/拒绝。
// 不自动切会话、不抢焦点；接受成功后才由 App 打开对应聊天。

const emit = defineEmits<{ open: [peerId: string] }>()
const duelStore = useDuelStore()
const peersStore = usePeersStore()

const now = ref(Date.now())
const busy = ref(false)
let clock: number | null = null

onMounted(() => {
  clock = window.setInterval(() => {
    now.value = Date.now()
  }, 500)
})
onUnmounted(() => window.clearInterval(clock ?? undefined))

const invite = computed(() => duelStore.pendingInvite)
const peer = computed(() => (invite.value ? peersStore.byId(invite.value.peerId) ?? null : null))
const secondsLeft = computed(() => {
  if (!invite.value || invite.value.endsAt <= 0) return 0
  return Math.max(0, Math.ceil((invite.value.endsAt - now.value) / 1000))
})
const peerName = computed(() => invite.value?.peerName ?? tr('未知节点'))

async function accept(): Promise<void> {
  const view = invite.value
  if (!view || busy.value) return
  busy.value = true
  const result = await duelStore.respond(view.matchId, true)
  busy.value = false
  if (result.ok) emit('open', view.peerId)
}

async function decline(): Promise<void> {
  const view = invite.value
  if (!view || busy.value) return
  busy.value = true
  await duelStore.respond(view.matchId, false)
  busy.value = false
}
</script>

<template>
  <Transition name="duel-invite">
    <aside
      v-if="invite"
      class="duel-invite"
      role="dialog"
      :aria-label="tr('角斗邀请')"
      :aria-modal="false"
    >
      <div class="invite-glow" aria-hidden="true"></div>
      <AvatarMark
        class="invite-avatar"
        :avatar="peer?.avatar ?? -1"
        :avatar-hash="peer?.avatarHash"
        :name="peerName"
        :presence="peer?.online ? 'online' : 'offline'"
      />
      <div class="invite-copy">
        <span class="invite-eyebrow">{{ tr('角斗邀请') }}</span>
        <strong>{{ tr('{0} 邀请你参加角斗', { 0: peerName }) }}</strong>
        <span class="invite-meta">{{ tr('{0} 秒后失效', { 0: secondsLeft }) }}</span>
      </div>
      <div class="invite-actions">
        <button class="invite-btn ghost" type="button" :disabled="busy" @click="decline">
          {{ tr('拒绝') }}
        </button>
        <button class="invite-btn primary" type="button" :disabled="busy" @click="accept">
          {{ tr('接受') }}
        </button>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.duel-invite {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 78;
  width: min(356px, calc(100vw - 32px));
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px 12px 12px 13px;
  border: 1px solid rgba(var(--primary-rgb), 0.22);
  border-radius: 14px;
  background:
    radial-gradient(100% 120% at 0% 0%, rgba(var(--primary-rgb), 0.12), transparent 62%),
    var(--bg-window);
  box-shadow: var(--shadow-float);
  color: var(--text-1);
  isolation: isolate;
}
.invite-glow {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
  pointer-events: none;
}
.invite-avatar {
  flex: none;
  width: 42px;
  height: 42px;
  font-size: 17px;
}
.invite-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.invite-eyebrow {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--primary);
}
.invite-copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 650;
}
.invite-meta {
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.invite-actions {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.invite-btn {
  min-width: 54px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--bg-window);
  color: var(--text-2);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 130ms ease, border-color 130ms ease, color 130ms ease;
}
.invite-btn:hover:not(:disabled) {
  border-color: var(--primary-border);
  background: var(--primary-weak);
  color: var(--text-1);
}
.invite-btn.primary {
  border-color: transparent;
  background: linear-gradient(145deg, var(--bubble-mine-hi), var(--primary-hover));
  color: var(--on-primary);
}
.invite-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.invite-btn:focus-visible {
  outline: 2px solid rgba(var(--primary-rgb), 0.35);
  outline-offset: 2px;
}
.duel-invite-enter-active,
.duel-invite-leave-active {
  transition: opacity 180ms ease, transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.duel-invite-enter-from,
.duel-invite-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.98);
}
@media (max-width: 560px) {
  .duel-invite {
    right: 10px;
    left: 10px;
    bottom: 10px;
    width: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .duel-invite,
  .duel-invite * {
    transition: none !important;
  }
}
</style>
