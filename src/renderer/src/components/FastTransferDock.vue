<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { PeerView, TransferView } from '../../../shared/ipc'
import { useTransfersStore } from '../stores/transfers'
import { tr } from '../utils/i18n'
import { formatBytes } from '../utils/format'
import PantryIcon from './PantryIcon.vue'

// 高速通道（lansend）的全局状态层：入站 offer 弹窗 + 右下角进度坞。
// 只处理 transport === 'fast' 的视图；旧栈传输仍由文件卡片负责。

const transfersStore = useTransfersStore()
const peers = ref<PeerView[]>([])
const busy = reactive<Record<string, boolean>>({})
const lingering = reactive(new Set<string>())
const dismissedOffers = reactive(new Set<string>())
const lingerTimers = new Map<string, number>()
let peersBusy = false
let offerTimer: number | undefined

const TERMINAL = new Set<TransferView['status']>(['done', 'failed', 'canceled', 'declined', 'expired'])
const LINGER_MS = 6000

const fastViews = computed(() =>
  Object.values(transfersStore.byId).filter((view) => view.transport === 'fast')
)

const offer = computed(
  () =>
    fastViews.value.find(
      (view) =>
        view.direction === 'in' &&
        view.status === 'offering' &&
        !dismissedOffers.has(view.transferId)
    ) ?? null
)

const activeRows = computed(() =>
  fastViews.value.filter(
    (view) => view.status === 'accepted' || (view.status === 'offering' && view.direction !== 'in')
  )
)

const dockRows = computed(() => {
  const done = fastViews.value.filter(
    (view) => lingering.has(view.transferId) && TERMINAL.has(view.status)
  )
  return [...activeRows.value, ...done]
})

const offerPeerName = computed(() => peerLabel(offer.value?.peerId, offer.value?.peerName))

function peerLabel(peerId: string | undefined, knownName?: string): string {
  if (knownName) return knownName
  if (!peerId) return tr('同事')
  const peer = peers.value.find((item) => item.nodeId === peerId)
  const name = peer ? peer.remark || peer.nick : ''
  return name || peerId.slice(0, 8) || tr('同事')
}

function percentOf(view: TransferView): number {
  if (!Number.isFinite(view.totalSize) || view.totalSize <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((view.bytesDone / view.totalSize) * 100)))
}

function statusLabel(view: TransferView): string {
  if (view.queued && view.status === 'offering') return tr('排队等待发送方')
  switch (view.status) {
    case 'accepted':
      return view.direction === 'in' ? tr('接收中') : tr('发送中')
    case 'done':
      return tr('已完成')
    case 'failed':
      return tr('传输失败')
    case 'canceled':
      return tr('已取消')
    case 'declined':
      return tr('已拒绝')
    case 'expired':
      return tr('已过期')
    default:
      return tr('等待接收')
  }
}

async function loadPeers(): Promise<void> {
  if (peersBusy) return
  peersBusy = true
  try {
    peers.value = await window.pantry.fastPeers()
  } catch {
    // 探测失败时退回 peerId 前缀显示。
  } finally {
    peersBusy = false
  }
}

async function accept(): Promise<void> {
  const view = offer.value
  if (!view || busy[view.transferId]) return
  busy[view.transferId] = true
  try {
    await window.pantry.fastAccept(view.transferId)
    dismissedOffers.add(view.transferId)
  } catch {
    // 失败时保持弹窗，等待主进程推送终态或重试。
  } finally {
    busy[view.transferId] = false
  }
}

async function decline(): Promise<void> {
  const view = offer.value
  if (!view || busy[view.transferId]) return
  busy[view.transferId] = true
  try {
    await window.pantry.fastDecline(view.transferId)
    dismissedOffers.add(view.transferId)
  } catch {
    // 忽略：下一次 offer 变更会驱动界面。
  } finally {
    busy[view.transferId] = false
  }
}

async function cancel(view: TransferView): Promise<void> {
  if (busy[view.transferId]) return
  busy[view.transferId] = true
  try {
    await window.pantry.fastCancel(view.transferId)
  } catch {
    // 忽略：主进程会推送取消结果。
  } finally {
    busy[view.transferId] = false
  }
}

function clearLinger(id: string): void {
  const timer = lingerTimers.get(id)
  if (timer !== undefined) window.clearTimeout(timer)
  lingerTimers.delete(id)
  lingering.delete(id)
}

watch(
  () => fastViews.value.filter((view) => TERMINAL.has(view.status)).map((view) => view.transferId),
  (ids) => {
    const seen = new Set(ids)
    for (const id of [...lingerTimers.keys()]) {
      if (!seen.has(id)) clearLinger(id)
    }
    for (const id of ids) {
      if (lingering.has(id) || lingerTimers.has(id)) continue
      lingering.add(id)
      lingerTimers.set(id, window.setTimeout(() => clearLinger(id), LINGER_MS))
    }
  }
)

watch(
  () => offer.value?.peerId,
  (peerId) => {
    if (peerId) void loadPeers()
  }
)

watch(
  () => offer.value?.transferId,
  (transferId) => {
    if (offerTimer !== undefined) window.clearTimeout(offerTimer)
    offerTimer = undefined
    if (!transferId) return
    // Main resolves an unanswered offer as declined after 20s; do not leave
    // the dialog on screen forever if the sender silently disappears.
    offerTimer = window.setTimeout(() => {
      if (offer.value?.transferId === transferId) dismissedOffers.add(transferId)
    }, 21_000)
  }
)

onMounted(() => {
  transfersStore.init()
  void loadPeers()
})

onBeforeUnmount(() => {
  if (offerTimer !== undefined) window.clearTimeout(offerTimer)
  for (const timer of lingerTimers.values()) window.clearTimeout(timer)
  lingerTimers.clear()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="offer" class="fast-scrim" @click.self="decline">
      <div class="fast-offer" role="dialog" aria-modal="true" :aria-label="tr('高速文件传输请求')">
        <div class="fast-offer-head">
          <PantryIcon class="fast-offer-icon" name="zap" :size="18" />
          <div class="fast-offer-title">
            <strong>{{ tr('{0} 想发送文件给你', { 0: offerPeerName }) }}</strong>
          </div>
        </div>
        <div class="fast-offer-body">
          <PantryIcon name="file" :size="16" />
          <span class="fast-offer-name">{{ offer.name }}</span>
          <span class="fast-offer-meta">{{ formatBytes(offer.totalSize) }}</span>
        </div>
        <div class="fast-offer-actions">
          <button
            class="fast-btn ghost"
            type="button"
            :disabled="busy[offer.transferId]"
            @click="decline"
          >
            {{ tr('拒绝') }}
          </button>
          <button
            class="fast-btn primary"
            type="button"
            :disabled="busy[offer.transferId]"
            @click="accept"
          >
            {{ tr('接收') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <aside v-if="dockRows.length" class="fast-dock" :aria-label="tr('高速传输')">
    <header class="fast-dock-head">
      <PantryIcon name="zap" :size="14" />
      <span>{{ tr('高速传输') }}</span>
    </header>
    <div v-for="view in dockRows" :key="view.transferId" class="fast-row">
      <div class="fast-row-top">
        <span class="fast-row-name" :title="view.name">{{ view.name }}</span>
        <span class="fast-row-percent">
          {{ TERMINAL.has(view.status) ? '' : `${percentOf(view)}%` }}
        </span>
        <span class="fast-row-status">{{ statusLabel(view) }}</span>
        <button
          v-if="!TERMINAL.has(view.status)"
          class="fast-row-cancel"
          type="button"
          :disabled="busy[view.transferId]"
          :aria-label="tr('取消传输')"
          @click="cancel(view)"
        >
          <PantryIcon name="x" :size="12" />
        </button>
      </div>
      <div class="fast-row-bar" aria-hidden="true">
        <span
          class="fast-row-fill"
          :style="{ width: `${TERMINAL.has(view.status) ? 100 : percentOf(view)}%` }"
        ></span>
      </div>
      <div class="fast-row-meta">
        <span>{{ formatBytes(view.bytesDone) }} / {{ formatBytes(view.totalSize) }}</span>
        <span v-if="view.direction === 'in'">{{ peerLabel(view.peerId, view.peerName) }}</span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.fast-scrim {
  position: fixed; inset: 0; z-index: 220; display: flex;
  align-items: center; justify-content: center; padding: 24px;
  background: rgba(0, 0, 0, 0.42);
}
.fast-offer {
  width: min(360px, calc(100vw - 40px)); padding: 18px;
  border: 1px solid var(--line); border-radius: 16px;
  background: var(--bg-window); box-shadow: var(--shadow-float); color: var(--text-1);
}
.fast-offer-head { display: flex; align-items: center; gap: 10px; }
.fast-offer-icon { color: var(--primary); }
.fast-offer-title { min-width: 0; }
.fast-offer-title strong {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 13px; font-weight: 650;
}
.fast-offer-body {
  display: flex; align-items: center; gap: 6px; margin: 14px 0 16px; padding: 9px 10px;
  border: 1px solid var(--line); border-radius: 10px; color: var(--text-2); font-size: 11.5px;
}
.fast-offer-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; color: var(--text-1);
}
.fast-offer-meta { flex: none; color: var(--text-3); font-variant-numeric: tabular-nums; }
.fast-offer-actions { display: flex; justify-content: flex-end; gap: 8px; }
.fast-btn {
  padding: 6px 16px; border: 1px solid var(--line); border-radius: 9px;
  background: transparent; color: var(--text-2); font-size: 12px; font-weight: 600; cursor: pointer;
}
.fast-btn.primary { border-color: transparent; background: var(--primary); color: #fff; }
.fast-btn:disabled { opacity: 0.55; cursor: default; }
.fast-dock {
  position: fixed; right: 16px; bottom: 16px; z-index: 90;
  width: min(320px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 9px;
  padding: 10px; border: 1px solid var(--line); border-radius: 13px;
  background: var(--bg-window); box-shadow: var(--shadow-float); color: var(--text-1);
}
.fast-dock-head {
  display: flex; align-items: center; gap: 5px; padding: 0 2px;
  font-size: 10.5px; font-weight: 700; color: var(--text-3);
}
.fast-row {
  display: flex; flex-direction: column; gap: 4px; padding: 7px 8px;
  border-radius: 9px; background: var(--surface-hover);
}
.fast-row-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.fast-row-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-size: 11.5px; font-weight: 600;
}
.fast-row-percent, .fast-row-status {
  flex: none; font-size: 10.5px; color: var(--text-3); font-variant-numeric: tabular-nums;
}
.fast-row-cancel {
  flex: none; display: grid; place-items: center; width: 18px; height: 18px; padding: 0;
  border: 0; border-radius: 5px; background: transparent; color: var(--text-3); cursor: pointer;
}
.fast-row-bar { height: 3px; border-radius: 999px; background: var(--line); overflow: hidden; }
.fast-row-fill {
  display: block; height: 100%; border-radius: inherit;
  background: var(--primary);
}
.fast-row-meta {
  display: flex; justify-content: space-between; gap: 8px;
  font-size: 10px; color: var(--text-3); font-variant-numeric: tabular-nums;
}
</style>
