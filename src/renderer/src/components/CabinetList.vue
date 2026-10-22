<script setup lang="ts">
import { tr } from '../utils/i18n'
import { computed, onMounted, ref } from 'vue'
import { NInput } from 'naive-ui'
import { cabinetPeerName, useCabinetStore } from '../stores/cabinet'
import type { PeerView } from '../../../shared/ipc'
import AvatarMark from './AvatarMark.vue'
import PantryIcon from './PantryIcon.vue'

// 文件柜列表栏（ui-design §8.2 / 决议 #283，形态改为主窗页签见 #284）：
// 上半是「我的文件柜」摘要卡，下半是所有声明 shr1 的同事。选中项由 store 统一持有。

const cabinet = useCabinetStore()
const query = ref('')

const visiblePeers = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return cabinet.cabinetPeers
  return cabinet.cabinetPeers.filter((p) =>
    [p.remark, p.nick, p.dept, p.ip].some((f) => f.toLowerCase().includes(q))
  )
})

const modeLabel = computed(() =>
  cabinet.shareMode === 'write' ? tr('可读可传') : cabinet.shareMode === 'read' ? tr('只读') : tr('不共享')
)

/** 列表只含支持文件柜的联系人；离线条目仍可点，进入后显示具体原因。 */
function peerSubtitle(p: PeerView): string {
  if (!p.online) return p.lastSeen ? tr('离线 · 最后在线 {0}', { 0: formatSeen(p.lastSeen) }) : tr('离线')
  return [p.dept, p.ip].filter((s) => s.length > 0).join(' · ') || tr('在线')
}

function formatSeen(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return tr('今天 {0}:{1}', { 0: hh, 1: mi })
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hh}:${mi}`
}

onMounted(() => {
  void cabinet.init()
})
</script>

<template>
  <div class="cabinet-list">
    <button
      type="button"
      class="mine-card"
      :class="{ on: cabinet.target.kind === 'mine' }"
      @click="cabinet.selectMine()"
    >
      <span class="mine-top">
        <span class="mine-icon"><PantryIcon name="cabinet" :size="17" /></span>
        <span class="mine-title">
          <strong>{{ tr('我的文件柜') }}</strong>
          <small>{{ cabinet.shareRoot ? tr('同事能看到这里的内容') : tr('未开启') }}</small>
        </span>
      </span>
      <span v-if="cabinet.shareRoot" class="mine-rows">
        <span class="kv">
          <span>{{ tr('共享目录') }}</span>
          <b class="path" :title="cabinet.shareRoot">{{ cabinet.shareRoot }}</b>
        </span>
        <span class="kv"><span>{{ tr('默认权限') }}</span><b>{{ modeLabel }}</b></span>
        <span class="kv"><span>{{ tr('单独设过的同事') }}</span><b>{{ tr('{0} 人', { 0: cabinet.grants.length }) }}</b></span>
      </span>
      <span v-else class="mine-empty">{{ tr('选个目录，同事就能自己来取文件') }}</span>
    </button>

    <div class="side-head">
      <span>{{ tr('同事的文件柜') }}</span>
      <span>{{ cabinet.cabinetPeers.length }}</span>
    </div>
    <div class="side-search">
      <NInput v-model:value="query" size="small" clearable :placeholder="tr('搜索同事')">
        <template #prefix><PantryIcon name="search" :size="14" /></template>
      </NInput>
    </div>

    <div class="peers">
      <button
        v-for="p in visiblePeers"
        :key="p.nodeId"
        type="button"
        class="peer"
        :class="{
          on: cabinet.target.kind === 'peer' && cabinet.target.peerId === p.nodeId,
          off: !p.online
        }"
        @click="cabinet.selectPeer(p.nodeId)"
      >
        <AvatarMark
          class="peer-avatar"
          :avatar="p.avatar"
          :avatar-hash="p.avatarHash"
          :name="cabinetPeerName(p)"
          :presence="p.online ? 'online' : 'offline'"
        />
        <span class="peer-txt">
          <span class="peer-name">{{ cabinetPeerName(p) }}</span>
          <span class="peer-sub">{{ peerSubtitle(p) }}</span>
        </span>
      </button>
      <p v-if="cabinet.cabinetPeers.length === 0" class="side-empty">{{ tr('还没有同事开启文件柜。等对方设好共享目录，这里就会出现。') }}</p>
      <p v-else-if="visiblePeers.length === 0" class="side-empty">{{ tr('没有匹配的同事') }}</p>
    </div>
  </div>
</template>

<style scoped>
.cabinet-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* 顶部 36px 让出拖拽带与 mac 红绿灯，与会话列表的搜索栏同口径（决议 #127） */
  padding-top: 36px;
}

.mine-card {
  margin: 0 10px 12px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--material-strong);
  box-shadow: none;
  display: flex;
  flex-direction: column;
  gap: 9px;
  text-align: left;
  cursor: pointer;
  color: inherit;
  font: inherit;
}

.mine-card.on {
  border-color: var(--primary);
  background: var(--primary-weak);
  box-shadow: none;
}

.mine-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mine-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-panel);
  background: var(--primary-weak);
  color: var(--primary);
}

.mine-title {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.mine-title strong {
  font-size: 14px;
}

.mine-title small,
.mine-empty {
  font-size: 12px;
  color: var(--text-3);
}

.mine-rows {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.kv {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  color: var(--text-2);
}

.kv b {
  font-weight: 500;
  color: var(--text-1);
}

.path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}

.side-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 4px 16px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
}

.side-search {
  padding: 0 10px 8px;
}

.peers {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.peer {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 54px;
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-panel);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.peer:hover {
  background: var(--surface-hover);
}

.peer.on {
  background: var(--surface-selected);
}

.peer.off {
  opacity: 0.62;
}

.peer-avatar {
  flex: none;
  width: 34px;
  height: 34px;
  font-size: 15px;
}

.peer-txt {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.peer-name {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.peer-sub,
.side-empty {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.side-empty {
  white-space: normal;
  line-height: 1.6;
  padding: 12px 10px;
  margin: 0;
}
</style>
