<script setup lang="ts">
import { tr } from '../utils/i18n'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { PeerView } from '../../../shared/ipc'
import type { DuelAction, DuelRoundResult, DuelView } from '../../../shared/duel'
import { useChatStore } from '../stores/chat'
import AvatarMark from './AvatarMark.vue'
import CompatEmoji from './CompatEmoji.vue'
import PantryIcon from './PantryIcon.vue'

const props = defineProps<{
  view: DuelView
  peer: PeerView
}>()
const emit = defineEmits<{
  act: [action: DuelAction]
  respond: [accept: boolean]
  close: []
}>()

const chatStore = useChatStore()

const now = ref(Date.now())
const reduceMotion = ref(false)
const fx = ref<DuelRoundResult | null>(null)
const fxSeq = ref(0)
let clock: number | null = null
let fxTimer: number | null = null
let motionQuery: MediaQueryList | null = null
let lastSeq = -1
let fxPrimed = false

function onMotionPreference(event: MediaQueryListEvent): void {
  reduceMotion.value = event.matches
}

onMounted(() => {
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  reduceMotion.value = motionQuery.matches
  motionQuery.addEventListener('change', onMotionPreference)
  clock = window.setInterval(() => {
    now.value = Date.now()
  }, 200)
})

onUnmounted(() => {
  motionQuery?.removeEventListener('change', onMotionPreference)
  window.clearInterval(clock ?? undefined)
  window.clearTimeout(fxTimer ?? undefined)
})

watch(
  () => props.view.matchId,
  () => {
    fx.value = null
    lastSeq = -1
    fxPrimed = false
  }
)

/** 每收到一次权威快照就重播一轮小动画；结算画面按 reason 区分是否重播。 */
watch(
  () => props.view.seq,
  (seq) => {
    if (seq === lastSeq) return
    lastSeq = seq
    if (!fxPrimed) {
      fxPrimed = true
      return
    }
    const last = props.view.last
    if (!last) return
    const ended = props.view.phase === 'ended'
    if (ended && props.view.reason !== 'knockout' && props.view.reason !== 'rounds') return
    if (last.round !== props.view.round && props.view.round !== last.round + 1) return
    fx.value = last
    fxSeq.value += 1
    window.clearTimeout(fxTimer ?? undefined)
    fxTimer = window.setTimeout(() => {
      fx.value = null
    }, reduceMotion.value ? 600 : 1600)
  },
  { immediate: true }
)

const remainingMs = computed(() => (props.view.endsAt > 0 ? Math.max(0, props.view.endsAt - now.value) : 0))
const seconds = computed(() => Math.max(0, Math.ceil(remainingMs.value / 1000)))
const expired = computed(() => props.view.phase === 'fighting' && remainingMs.value <= 0)
const canAct = computed(
  () => props.view.phase === 'fighting' && !props.view.selfSubmitted && !expired.value
)
const selfHpPercent = computed(() =>
  Math.max(0, Math.min(100, (props.view.selfHp / props.view.maxHp) * 100))
)
const peerHpPercent = computed(() =>
  Math.max(0, Math.min(100, (props.view.peerHp / props.view.maxHp) * 100))
)
const selfLowHp = computed(() => props.view.selfHp <= 30)
const peerLowHp = computed(() => props.view.peerHp <= 30)

const isHost = computed(() => props.view.role === 'host')
const selfActionFx = computed<DuelAction | null>(() => {
  if (!fx.value) return null
  return isHost.value ? fx.value.hostAction : fx.value.guestAction
})
const peerActionFx = computed<DuelAction | null>(() => {
  if (!fx.value) return null
  return isHost.value ? fx.value.guestAction : fx.value.hostAction
})
const selfDamageFx = computed(() => {
  if (!fx.value) return 0
  return isHost.value ? fx.value.hostDamage : fx.value.guestDamage
})
const peerDamageFx = computed(() => {
  if (!fx.value) return 0
  return isHost.value ? fx.value.guestDamage : fx.value.hostDamage
})
const selfHealFx = computed(() => {
  if (!fx.value) return 0
  return isHost.value ? fx.value.hostHeal : fx.value.guestHeal
})
const peerHealFx = computed(() => {
  if (!fx.value) return 0
  return isHost.value ? fx.value.guestHeal : fx.value.hostHeal
})

const selfClasses = computed(() => ({
  'act-attack': selfActionFx.value === 'attack',
  'act-guard': selfActionFx.value === 'guard',
  'act-trick': selfActionFx.value === 'trick',
  'is-hurt': selfDamageFx.value > 0,
  'is-heal': selfHealFx.value > 0,
  'is-ko': props.view.phase === 'ended' && props.view.outcome === 'lose'
}))
const peerClasses = computed(() => ({
  'act-attack': peerActionFx.value === 'attack',
  'act-guard': peerActionFx.value === 'guard',
  'act-trick': peerActionFx.value === 'trick',
  'is-hurt': peerDamageFx.value > 0,
  'is-heal': peerHealFx.value > 0,
  'is-ko': props.view.phase === 'ended' && props.view.outcome === 'win'
}))

const outcomeText = computed(() => {
  if (props.view.outcome === 'win') return tr('胜利')
  if (props.view.outcome === 'lose') return tr('失败')
  if (props.view.outcome === 'draw') return tr('平局')
  return tr('对局结束')
})
const outcomeClass = computed(() => `is-${props.view.outcome ?? 'neutral'}`)
const reasonText = computed(() => {
  switch (props.view.reason) {
    case 'knockout':
      return tr('KO！')
    case 'rounds':
      return tr('回合耗尽，按剩余血量判定')
    case 'quit':
      return props.view.outcome === 'win' ? tr('对方退出了对局') : tr('你退出了对局')
    case 'offline':
      return tr('对手已离线，本次对局中断')
    case 'declined':
      return tr('对方拒绝了邀请')
    case 'busy':
      return tr('对方正在另一场对局中')
    case 'cancelled':
      return tr('邀请已取消')
    case 'timeout':
      return props.view.outcome ? tr('对手无响应，对局中断') : tr('邀请超时，对方未响应')
    case 'error':
      return tr('连接异常，对局结束')
    default:
      return tr('对局结束')
  }
})
const selfName = computed(() => chatStore.selfNick || tr('你'))
function actionText(action: DuelAction | null): string {
  if (action === 'attack') return tr('普通攻击')
  if (action === 'guard') return tr('防御')
  if (action === 'trick') return tr('搞怪技能')
  return ''
}
const selfActionLabel = computed(() => actionText(props.view.selfAction))
const lastActionText = computed(() => {
  const last = props.view.last
  if (!last) return ''
  const selfAction = isHost.value ? last.hostAction : last.guestAction
  const peerAction = isHost.value ? last.guestAction : last.hostAction
  return tr('上一回合：{0} vs {1}', { 0: actionText(selfAction), 1: actionText(peerAction) })
})
const phaseLabel = computed(() => {
  if (props.view.phase === 'fighting') {
    return tr('第 {0} / {1} 回合', { 0: props.view.round, 1: props.view.maxRounds })
  }
  if (props.view.phase === 'incoming') return tr('收到邀请')
  if (props.view.phase === 'inviting') return tr('邀请等待中')
  return tr('结算')
})
const closeLabel = computed(() =>
  props.view.phase === 'fighting' ? tr('退出对局') : tr('关闭角斗场')
)
</script>

<template>
  <aside
    class="duel"
    :class="[`phase-${view.phase}`, `outcome-${view.outcome ?? 'neutral'}`]"
    role="dialog"
    :aria-label="tr('角斗场')"
    :aria-modal="false"
  >
    <header class="duel-head">
      <span class="duel-eyebrow">
        <span class="live-dot" aria-hidden="true"></span>
        {{ tr('角斗场') }}
      </span>
      <span class="duel-round">{{ phaseLabel }}</span>
      <button
        class="duel-close"
        type="button"
        :aria-label="closeLabel"
        :title="closeLabel"
        @click="emit('close')"
      >
        <PantryIcon name="x" :size="15" />
      </button>
    </header>

    <div class="duel-stage">
      <div class="arena-floor" aria-hidden="true"></div>
      <section class="fighter self" :class="selfClasses">
        <div class="fighter-art" :key="`self-${fxSeq}`">
          <span class="fighter-limbs" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <span class="fighter-ring" aria-hidden="true"></span>
          <AvatarMark
            class="duel-avatar"
            :avatar="chatStore.selfAvatar"
            :avatar-hash="chatStore.selfAvatarHash"
            :name="selfName"
          />
          <span v-if="selfActionFx === 'guard'" class="guard-ring" aria-hidden="true"></span>
          <span v-if="selfActionFx === 'trick'" class="trick-orbit" aria-hidden="true">
            <CompatEmoji emoji="🌈" />
            <CompatEmoji emoji="🥳" />
          </span>
          <span
            v-if="selfDamageFx > 0"
            :key="`self-dmg-${fxSeq}`"
            class="float damage"
            aria-hidden="true"
          >-{{ selfDamageFx }}</span>
          <span
            v-if="selfHealFx > 0"
            :key="`self-heal-${fxSeq}`"
            class="float heal"
            aria-hidden="true"
          >+{{ selfHealFx }}</span>
        </div>
        <div class="fighter-name">
          <strong :title="selfName">{{ selfName }}</strong>
          <small>{{ tr('你') }}</small>
        </div>
        <div class="hp-track" :class="{ low: selfLowHp }">
          <span :style="{ width: `${selfHpPercent}%` }"></span>
        </div>
        <div class="hp-meta">
          <span>HP</span>
          <strong>{{ view.selfHp }}</strong>
        </div>
        <div v-if="view.phase === 'fighting'" class="commit" :class="{ ready: view.selfSubmitted }">
          <template v-if="view.selfSubmitted">{{ tr('已出招：{0}', { 0: selfActionLabel }) }}</template>
          <template v-else-if="expired">{{ tr('等待结果…') }}</template>
          <template v-else>{{ tr('选一个招式') }}</template>
        </div>
      </section>

      <div class="versus" aria-hidden="true">
        <span class="vs-mark">VS</span>
        <span
          v-if="view.phase === 'fighting'"
          class="countdown"
          :class="{ urgent: seconds <= 3 && !expired, waiting: expired }"
        >
          <strong>{{ expired ? '…' : seconds }}</strong>
          <small>{{ tr('秒') }}</small>
        </span>
        <span v-else-if="view.phase === 'incoming'" class="vs-note">{{ tr('邀请') }}</span>
        <span v-else-if="view.phase === 'inviting'" class="vs-note">{{ tr('等待中') }}</span>
        <span v-else class="vs-note">{{ outcomeText }}</span>
        <span class="vs-dots"><i></i><i></i><i></i></span>
      </div>

      <section class="fighter peer" :class="peerClasses">
        <div class="fighter-art" :key="`peer-${fxSeq}`">
          <span class="fighter-limbs" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <span class="fighter-ring" aria-hidden="true"></span>
          <AvatarMark
            class="duel-avatar"
            :avatar="peer.avatar"
            :avatar-hash="peer.avatarHash"
            :name="peer.remark || peer.nick"
            :presence="peer.online ? 'online' : 'offline'"
          />
          <span v-if="peerActionFx === 'guard'" class="guard-ring" aria-hidden="true"></span>
          <span v-if="peerActionFx === 'trick'" class="trick-orbit" aria-hidden="true">
            <CompatEmoji emoji="🌈" />
            <CompatEmoji emoji="🤔" />
          </span>
          <span
            v-if="peerDamageFx > 0"
            :key="`peer-dmg-${fxSeq}`"
            class="float damage"
            aria-hidden="true"
          >-{{ peerDamageFx }}</span>
          <span
            v-if="peerHealFx > 0"
            :key="`peer-heal-${fxSeq}`"
            class="float heal"
            aria-hidden="true"
          >+{{ peerHealFx }}</span>
        </div>
        <div class="fighter-name">
          <strong :title="view.peerName">{{ view.peerName }}</strong>
          <small>{{ tr('对手') }}</small>
        </div>
        <div class="hp-track" :class="{ low: peerLowHp }">
          <span :style="{ width: `${peerHpPercent}%` }"></span>
        </div>
        <div class="hp-meta">
          <span>HP</span>
          <strong>{{ view.peerHp }}</strong>
        </div>
        <div v-if="view.phase === 'fighting'" class="commit" :class="{ ready: view.peerSubmitted }">
          <template v-if="view.peerSubmitted">{{ tr('对手已出招') }}</template>
          <template v-else>{{ tr('对手正在思考') }}</template>
        </div>
      </section>
    </div>

    <p v-if="lastActionText" class="round-note">{{ lastActionText }}</p>

    <div class="duel-bottom">
      <template v-if="view.phase === 'incoming'">
        <p class="callout">{{ tr('{0} 邀请你参加角斗', { 0: view.peerName }) }}</p>
        <p class="sub">{{ tr('双方各 100 HP，倒计时内同时出招；接受后开始。') }}</p>
        <div class="actions invite-actions">
          <button class="duel-btn ghost" type="button" @click="emit('respond', false)">
            {{ tr('拒绝') }}
          </button>
          <button class="duel-btn primary" type="button" @click="emit('respond', true)">
            {{ tr('接受') }}
          </button>
        </div>
      </template>

      <template v-else-if="view.phase === 'inviting'">
        <p class="callout">{{ tr('已向 {0} 发出角斗邀请', { 0: view.peerName }) }}</p>
        <p class="sub">{{ tr('等待对方接受… {0} 秒后自动取消', { 0: seconds }) }}</p>
        <div class="actions">
          <button class="duel-btn ghost" type="button" @click="emit('close')">
            {{ tr('取消邀请') }}
          </button>
        </div>
      </template>

      <template v-else-if="view.phase === 'fighting'">
        <div class="actions move-actions">
          <button
            class="duel-btn action"
            type="button"
            :class="{ chosen: view.selfAction === 'attack' }"
            :disabled="!canAct"
            @click="emit('act', 'attack')"
          >
            <span class="action-glyph"><PantryIcon name="pk" :size="22" /></span>
            <span class="action-copy">
              <strong>{{ tr('普通攻击') }}</strong>
              <small>{{ tr('8–14 伤害') }}</small>
            </span>
          </button>
          <button
            class="duel-btn action guard"
            type="button"
            :class="{ chosen: view.selfAction === 'guard' }"
            :disabled="!canAct"
            @click="emit('act', 'guard')"
          >
            <span class="action-glyph"><PantryIcon name="shield" :size="22" /></span>
            <span class="action-copy">
              <strong>{{ tr('防御') }}</strong>
              <small>{{ tr('减伤并回复 2 HP') }}</small>
            </span>
          </button>
          <button
            class="duel-btn action trick"
            type="button"
            :class="{ chosen: view.selfAction === 'trick' }"
            :disabled="!canAct"
            @click="emit('act', 'trick')"
          >
            <span class="action-glyph"><PantryIcon name="smile" :size="22" /></span>
            <span class="action-copy">
              <strong>{{ tr('搞怪技能') }}</strong>
              <small>{{ tr('又打又奶，伤害看运气') }}</small>
            </span>
          </button>
        </div>
        <p class="hint" role="status">
          <template v-if="view.selfSubmitted">{{ tr('已锁定，等待结算…') }}</template>
          <template v-else-if="expired">{{ tr('倒计时结束，等待对手…') }}</template>
          <template v-else>{{ tr('倒计时内选一招，双方同时结算') }}</template>
        </p>
      </template>

      <template v-else>
        <div class="verdict" :class="outcomeClass" role="status">
          <strong>{{ outcomeText }}</strong>
          <span>{{ reasonText }}</span>
        </div>
        <div class="actions">
          <button class="duel-btn primary" type="button" @click="emit('close')">
            {{ tr('关闭') }}
          </button>
        </div>
      </template>
    </div>

    <p class="duel-foot">{{ tr('仅内网直连 · 结果保存在聊天中') }}</p>
  </aside>
</template>

<style scoped>
/* Iris 靛蓝：与现有窗口一致的石墨底 + 靛蓝主色；浮层只占聊天区上半部，
   保留下方消息可见，避免“进游戏就看不见聊天”。 */
.duel {
  --duel-edge: rgba(var(--primary-rgb), 0.18);
  --duel-glow: rgba(var(--primary-rgb), 0.22);
  position: absolute;
  top: 52px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 24;
  width: min(640px, calc(100% - 32px));
  max-height: calc(100% - 84px);
  overflow: auto;
  padding: 14px 18px 12px;
  border: 1px solid var(--duel-edge);
  border-radius: 18px;
  background:
    radial-gradient(120% 90% at 50% -10%, var(--duel-glow), transparent 58%),
    linear-gradient(160deg, var(--bg-window), var(--bg-list));
  box-shadow: var(--shadow-float), 0 0 0 1px rgba(255, 255, 255, 0.02);
  color: var(--text-1);
  animation: duel-in 220ms cubic-bezier(0.2, 0.9, 0.3, 1.05);
  isolation: isolate;
}
.duel::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background:
    linear-gradient(90deg, transparent, rgba(var(--primary-rgb), 0.12), transparent) top / 100% 1px no-repeat;
  pointer-events: none;
}
.duel-head {
  display: flex;
  align-items: center;
  gap: 10px;
  position: relative;
  z-index: 1;
}
.duel-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--primary);
}
.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.16);
}
.duel-round {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-3);
  text-align: right;
}
.duel-close {
  flex: none;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.duel-close:hover {
  background: var(--surface-hover);
  color: var(--text-1);
  border-color: var(--line);
}
.duel-close:focus-visible {
  outline: 2px solid rgba(var(--primary-rgb), 0.35);
  outline-offset: 2px;
}

.duel-stage {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 76px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 12px 4px 8px;
}
.arena-floor {
  position: absolute;
  left: 8%;
  right: 8%;
  bottom: 18px;
  height: 64px;
  border-radius: 50%;
  background:
    radial-gradient(ellipse at center, rgba(var(--primary-rgb), 0.14), transparent 68%),
    repeating-radial-gradient(ellipse at center, transparent 0 8px, rgba(var(--primary-rgb), 0.08) 8px 9px);
  filter: blur(0.2px);
  pointer-events: none;
  z-index: 0;
}
.fighter {
  position: relative;
  z-index: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
}
.fighter-art {
  position: relative;
  width: 84px;
  height: 84px;
  display: grid;
  place-items: center;
}
.fighter-limbs { --punch: 12px; z-index: 2; }
.fighter.peer .fighter-limbs { --punch: -12px; }
.fighter-limbs i {
  position: absolute;
  display: block;
  width: 18px;
  height: 6px;
  border-radius: 8px;
  background: var(--primary);
  opacity: 0.8;
}
.fighter-limbs i:nth-child(1) { --rot: -16deg; left: -11px; top: 48px; width: 20px; transform: rotate(var(--rot)); }
.fighter-limbs i:nth-child(2) { --rot: 16deg; right: -11px; top: 48px; width: 20px; transform: rotate(var(--rot)); }
.fighter-limbs i:nth-child(1)::after,
.fighter-limbs i:nth-child(2)::after {
  content: '';
  position: absolute;
  top: -3px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 0 2px var(--bg-window);
}
.fighter-limbs i:nth-child(1)::after { left: -5px; }
.fighter-limbs i:nth-child(2)::after { right: -5px; }
.fighter-limbs i:nth-child(3),
.fighter-limbs i:nth-child(4) {
  bottom: -7px;
  width: 10px;
  height: 5px;
  opacity: 0.5;
}
.fighter-limbs i:nth-child(3) { left: 30px; transform: rotate(72deg); }
.fighter-limbs i:nth-child(4) { right: 30px; transform: rotate(-72deg); }
.fighter-ring {
  position: absolute;
  inset: 2px;
  border-radius: 50%;
  border: 1px dashed rgba(var(--primary-rgb), 0.28);
  transform: rotate(0deg);
}
.fighter.self .fighter-ring {
  border-color: rgba(var(--primary-rgb), 0.34);
}
.fighter.peer .fighter-ring {
  border-color: var(--line);
}
.duel-avatar {
  width: 68px;
  height: 68px;
  font-size: 24px;
  box-shadow: 0 6px 18px rgba(15, 18, 30, 0.16);
}
.fighter.peer .duel-avatar {
  box-shadow: 0 6px 18px rgba(15, 18, 30, 0.12);
}
.fighter-name {
  display: flex;
  align-items: baseline;
  gap: 5px;
  max-width: 100%;
}
.fighter-name strong {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 650;
}
.fighter-name small {
  flex: none;
  color: var(--text-3);
  font-size: 11px;
}
.hp-track {
  width: min(100%, 156px);
  height: 9px;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.08);
}
.hp-track > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--primary), rgba(var(--primary-rgb), 0.68));
  transition: width 420ms cubic-bezier(0.2, 0.8, 0.2, 1), background 200ms ease;
}
.hp-track.low > span {
  background: linear-gradient(90deg, var(--danger), #ff9a6b);
}
.hp-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-3);
}
.hp-meta strong {
  color: var(--text-1);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.commit {
  min-height: 17px;
  max-width: 100%;
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.commit.ready {
  color: var(--primary);
  font-weight: 600;
}

.versus {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.vs-mark {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  color: var(--on-primary);
  background: linear-gradient(145deg, var(--bubble-mine-hi), var(--primary-hover));
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.04em;
  box-shadow: 0 6px 16px rgba(var(--primary-rgb), 0.32);
}
.countdown {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--duel-edge);
  background: var(--bg-window);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.countdown strong {
  font-size: 16px;
  color: var(--text-1);
}
.countdown small {
  font-size: 10px;
}
.countdown.urgent {
  border-color: rgba(229, 72, 77, 0.4);
  background: rgba(229, 72, 77, 0.08);
}
.countdown.urgent strong {
  color: var(--danger);
}
.countdown.waiting {
  color: var(--text-3);
}
.vs-note {
  font-size: 11px;
  color: var(--text-3);
}
.vs-dots {
  display: flex;
  gap: 3px;
}
.vs-dots i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: rgba(var(--primary-rgb), 0.36);
}
.vs-dots i:nth-child(2) {
  opacity: 0.65;
}
.vs-dots i:nth-child(3) {
  opacity: 0.35;
}

.round-note {
  position: relative;
  z-index: 1;
  margin: 0 0 7px;
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
}
.duel-bottom {
  position: relative;
  z-index: 1;
  border-top: 1px solid var(--line);
  padding-top: 11px;
  margin-top: 2px;
}
.callout {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 650;
  text-align: center;
}
.sub {
  margin: 0 0 11px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.55;
  text-align: center;
}
.actions {
  display: flex;
  justify-content: center;
  gap: 8px;
}
.invite-actions .duel-btn {
  min-width: 116px;
}
.duel-btn {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg-window);
  color: var(--text-1);
  font-size: 13px;
  font-weight: 600;
  padding: 9px 16px;
  cursor: pointer;
  transition:
    transform 110ms ease,
    border-color 140ms ease,
    background 140ms ease,
    color 140ms ease,
    box-shadow 140ms ease;
}
.duel-btn:hover:not(:disabled) {
  border-color: var(--primary-border);
  background: var(--primary-weak);
}
.duel-btn:active:not(:disabled) {
  transform: translateY(1px);
}
.duel-btn:focus-visible {
  outline: 2px solid rgba(var(--primary-rgb), 0.35);
  outline-offset: 2px;
}
.duel-btn:disabled {
  cursor: default;
  opacity: 0.56;
}
.duel-btn.primary {
  border-color: transparent;
  background: linear-gradient(145deg, var(--bubble-mine-hi), var(--primary-hover));
  color: var(--on-primary);
  box-shadow: 0 5px 14px rgba(var(--primary-rgb), 0.28);
}
.duel-btn.primary:hover:not(:disabled) {
  background: linear-gradient(145deg, var(--bubble-mine-hi), var(--primary));
}
.duel-btn.ghost {
  background: transparent;
  color: var(--text-2);
}

.move-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.duel-btn.action {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  text-align: left;
  min-width: 0;
}
.action-glyph {
  flex: none;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: var(--primary-weak);
  color: var(--primary);
}
.duel-btn.action.guard .action-glyph {
  background: rgba(16, 185, 129, 0.1);
  color: var(--online);
}
.duel-btn.action.trick .action-glyph {
  background: rgba(232, 161, 60, 0.12);
  color: var(--away);
}
.action-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.action-copy strong {
  font-size: 12.5px;
}
.action-copy small {
  color: var(--text-3);
  font-size: 10.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.duel-btn.action.chosen {
  border-color: var(--primary);
  background: var(--primary-weak);
  box-shadow: inset 0 0 0 1px rgba(var(--primary-rgb), 0.18);
}
.duel-btn.action.chosen .action-copy strong {
  color: var(--primary);
}
.hint {
  margin: 8px 0 0;
  text-align: center;
  color: var(--text-3);
  font-size: 11px;
}
.verdict {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  margin-bottom: 9px;
  text-align: center;
}
.verdict strong {
  font-size: 22px;
  letter-spacing: 0.08em;
  color: var(--text-1);
}
.verdict span {
  font-size: 12px;
  color: var(--text-3);
}
.verdict.is-win strong {
  color: var(--primary);
  text-shadow: 0 0 18px rgba(var(--primary-rgb), 0.35);
}
.verdict.is-lose strong {
  color: var(--danger);
}
.verdict.is-draw strong {
  color: var(--away);
}
.duel-foot {
  margin: 9px 0 0;
  text-align: center;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--text-3);
  opacity: 0.72;
}

/* ---------- 结算 / 出招动画 ---------- */
.guard-ring {
  position: absolute;
  inset: -2px;
  border-radius: 50%;
  border: 2px solid rgba(16, 185, 129, 0.55);
  box-shadow: 0 0 16px rgba(16, 185, 129, 0.35);
  pointer-events: none;
}
.trick-orbit {
  position: absolute;
  inset: -7px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  pointer-events: none;
  font-size: 17px;
  filter: drop-shadow(0 2px 4px rgba(15, 18, 30, 0.18));
}
.float {
  position: absolute;
  right: 4px;
  top: 2px;
  font-size: 15px;
  font-weight: 800;
  font-style: italic;
  letter-spacing: -0.02em;
  pointer-events: none;
  text-shadow: 0 1px 2px rgba(15, 18, 30, 0.22);
}
.float.damage {
  color: var(--danger);
}
.float.heal {
  color: var(--online);
  left: 4px;
  right: auto;
  top: 4px;
}

@media (prefers-reduced-motion: no-preference) {
  .fighter.self.act-attack .fighter-limbs i:nth-child(2),
  .fighter.peer.act-attack .fighter-limbs i:nth-child(1) {
    animation: duel-punch 460ms ease-out;
  }
  .fighter.act-attack .fighter-art {
    animation: duel-lunge 460ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .fighter.peer.act-attack .fighter-art {
    animation-name: duel-lunge-left;
  }
  .fighter.is-hurt .fighter-art {
    animation: duel-shake 420ms ease-in-out;
  }
  .fighter.act-guard .fighter-ring {
    animation: duel-guard-pulse 900ms ease-out;
  }
  .fighter.act-trick .fighter-art {
    animation: duel-wiggle 700ms ease-in-out;
  }
  .fighter.act-trick .fighter-ring {
    animation: duel-spin 900ms linear;
  }
  .fighter.act-trick .trick-orbit {
    animation: duel-orbit 800ms ease-out;
  }
  .fighter.is-ko .duel-avatar,
  .fighter.is-ko .fighter-ring {
    animation: duel-ko 700ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .float {
    animation: duel-float-up 900ms ease-out both;
  }
  .countdown.urgent strong {
    animation: duel-pulse 700ms ease-in-out infinite alternate;
  }
  .live-dot {
    animation: duel-breathe 1.8s ease-in-out infinite;
  }
  .guard-ring {
    animation: duel-guard-ring 900ms ease-out;
  }
}

@keyframes duel-punch {
  50% {
    transform: rotate(var(--rot, 0deg)) translateX(var(--punch, 12px)) scaleX(1.5);
  }
}

@keyframes duel-in {
  from {
    opacity: 0;
    transform: translate(-50%, -8px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0) scale(1);
  }
}
@keyframes duel-lunge {
  0%,
  100% {
    transform: translateX(0);
  }
  38% {
    transform: translateX(16px) rotate(3deg);
  }
  62% {
    transform: translateX(13px) rotate(-2deg);
  }
}
@keyframes duel-lunge-left {
  0%,
  100% {
    transform: translateX(0);
  }
  38% {
    transform: translateX(-16px) rotate(-3deg);
  }
  62% {
    transform: translateX(-13px) rotate(2deg);
  }
}
@keyframes duel-shake {
  0%,
  100% {
    transform: translateX(0);
  }
  20% {
    transform: translateX(-4px) rotate(-2deg);
  }
  45% {
    transform: translateX(4px) rotate(2deg);
  }
  70% {
    transform: translateX(-2px);
  }
}
@keyframes duel-guard-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.38);
  }
  100% {
    box-shadow: 0 0 0 14px rgba(16, 185, 129, 0);
  }
}
@keyframes duel-guard-ring {
  0% {
    opacity: 1;
    transform: scale(0.72);
  }
  100% {
    opacity: 0;
    transform: scale(1.2);
  }
}
@keyframes duel-wiggle {
  0%,
  100% {
    transform: rotate(0);
  }
  25% {
    transform: rotate(-6deg) scale(1.03);
  }
  55% {
    transform: rotate(6deg) scale(1.05);
  }
  78% {
    transform: rotate(-3deg);
  }
}
@keyframes duel-spin {
  to {
    transform: rotate(720deg);
  }
}
@keyframes duel-orbit {
  0% {
    opacity: 0;
    transform: scale(0.7) rotate(-20deg);
  }
  30% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: scale(1.3) rotate(20deg);
  }
}
@keyframes duel-ko {
  0% {
    transform: translateY(0) rotate(0);
  }
  40% {
    transform: translateY(6px) rotate(-12deg);
  }
  100% {
    transform: translateY(10px) rotate(-16deg);
    filter: grayscale(0.55);
  }
}
@keyframes duel-float-up {
  0% {
    opacity: 0;
    transform: translateY(8px) scale(0.9);
  }
  25% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translateY(-26px) scale(1.06);
  }
}
@keyframes duel-pulse {
  from {
    transform: scale(1);
  }
  to {
    transform: scale(1.12);
  }
}
@keyframes duel-breathe {
  0%,
  100% {
    box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.16);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(var(--primary-rgb), 0.05);
  }
}

@media (max-width: 640px) {
  .duel {
    top: 46px;
    width: calc(100% - 16px);
    max-height: calc(100% - 66px);
    padding: 12px 12px 10px;
    border-radius: 16px;
  }
  .duel-stage {
    grid-template-columns: minmax(0, 1fr) 56px minmax(0, 1fr);
    gap: 6px;
  }
  .fighter-art {
    width: 68px;
    height: 68px;
  }
  .duel-avatar {
    width: 56px;
    height: 56px;
    font-size: 20px;
  }
  .action-copy small {
    display: none;
  }
  .duel-btn.action {
    padding: 8px 6px;
    flex-direction: column;
    text-align: center;
    gap: 4px;
  }
  .action-glyph {
    width: 26px;
    height: 26px;
  }
  .callout {
    font-size: 13px;
  }
  .sub {
    font-size: 11px;
  }
}

@media (max-height: 560px) {
  .duel {
    top: 40px;
    max-height: calc(100% - 48px);
  }
  .duel-stage {
    padding: 6px 4px 4px;
  }
  .duel-foot {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .duel,
  .duel * {
    animation: none !important;
    transition: none !important;
  }
}
</style>
