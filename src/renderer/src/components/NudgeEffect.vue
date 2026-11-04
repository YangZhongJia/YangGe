<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import type { NudgeStyle } from '../../../shared/protocol'
import {
  buildNudgeFlight,
  nudgeFlightDuration,
  sampleNudgeFlight,
  type NudgeFlightPoint,
  type NudgePoint
} from '../utils/nudge-effect'

interface ImpactState extends NudgePoint {
  style: NudgeStyle
}

interface TrailDot extends NudgePoint {
  id: number
}

const flightEl = ref<HTMLElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)
const flightVisible = ref(false)
const flightStyle = ref<NudgeStyle>('plane')
const impact = ref<ImpactState | null>(null)
const launch = ref<NudgePoint | null>(null)
const trail = ref<TrailDot[]>([])

let raf = 0
let dotTimer = 0
let dotSeq = 0
let timers: Array<ReturnType<typeof setTimeout>> = []

function clear(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  if (dotTimer) clearInterval(dotTimer)
  dotTimer = 0
  for (const timer of timers) clearTimeout(timer)
  timers = []
  trail.value = []
  impact.value = null
  launch.value = null
  flightVisible.value = false
}

function lastVisible(selector: string, clipToChat = false): DOMRect | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector))
  const container = clipToChat ? document.querySelector<HTMLElement>('.msgs')?.getBoundingClientRect() : null
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const rect = nodes[i].getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) continue
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue
    if (rect.right < 0 || rect.left > window.innerWidth) continue
    // 消息列表底部会被输入区盖住：只取滚动区里完整可见的消息头像。
    if (container && (rect.top < container.top || rect.bottom > container.bottom)) continue
    return rect
  }
  return null
}

function centerOf(selector: string, clipToChat = false): NudgePoint | null {
  const rect = lastVisible(selector, clipToChat)
  return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
}

function chatCenter(): NudgePoint {
  const rect = document.querySelector<HTMLElement>('.msgs')?.getBoundingClientRect()
  if (rect && rect.width > 0) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 }
}

function resolveAnchors(direction: 'out' | 'in'): { from: NudgePoint; to: NudgePoint } {
  if (direction === 'out') {
    return {
      from:
        centerOf('.row.mine .msg-avatar', true) ??
        centerOf('.rail .avatar-wrap .avatar') ??
        { x: window.innerWidth * 0.12, y: window.innerHeight * 0.24 },
      to: centerOf('.row.peer .msg-avatar', true) ?? centerOf('.head-avatar') ?? chatCenter()
    }
  }
  return {
    from:
      centerOf('.row.peer .msg-avatar', true) ??
      centerOf('.head-avatar') ??
      { x: window.innerWidth * 0.88, y: window.innerHeight * 0.24 },
    to: centerOf('.row.mine .msg-avatar', true) ?? centerOf('.rail .avatar-wrap .avatar') ?? chatCenter()
  }
}

function clampPoint(point: NudgePoint, margin = 24): NudgePoint {
  return {
    x: Math.min(Math.max(point.x, margin), window.innerWidth - margin),
    y: Math.min(Math.max(point.y, margin), window.innerHeight - margin)
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function showImpact(point: NudgePoint, style: NudgeStyle, holdMs: number): void {
  impact.value = { x: point.x, y: point.y, style }
  timers.push(
    setTimeout(() => {
      impact.value = null
    }, holdMs)
  )
}

async function play(direction: 'out' | 'in', style: NudgeStyle): Promise<void> {
  clear()
  const anchors = resolveAnchors(direction)
  const from = clampPoint(anchors.from)
  // 墨弹主体直径约 92px，纸屑约 50px；落点向内收，避免爆炸被窗口边缘裁掉。
  const to = clampPoint(anchors.to, style === 'ink' ? 64 : 40)
  const reduced = prefersReducedMotion()

  if (reduced) {
    showImpact(to, style, 1100)
    return
  }

  launch.value = from
  timers.push(
    setTimeout(() => {
      launch.value = null
    }, 360)
  )

  const points = buildNudgeFlight(from, to, style, { width: window.innerWidth, height: window.innerHeight })
  const duration = nudgeFlightDuration(style)
  flightStyle.value = style
  flightVisible.value = true
  await nextTick()

  const apply = (point: NudgeFlightPoint): void => {
    if (flightEl.value) {
      flightEl.value.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`
    }
    if (bodyEl.value) {
      bodyEl.value.style.transform = `translate(-50%, -50%) rotate(${point.angle}deg)`
    }
  }
  apply(points[0])

  if (style === 'ink') {
    dotTimer = window.setInterval(() => {
      const point = points[points.length - 1]
      if (!flightVisible.value) return
      const rect = flightEl.value?.getBoundingClientRect()
      const x = rect ? rect.left + rect.width / 2 : point.x
      const y = rect ? rect.top + rect.height / 2 : point.y
      trail.value = [...trail.value.slice(-13), { id: (dotSeq += 1), x, y }]
    }, 45)
  }

  const started = performance.now()
  const tick = (now: number): void => {
    const progress = Math.min(1, (now - started) / duration)
    const eased = style === 'plane' ? progress * progress * (3 - 2 * progress) : 1 - (1 - progress) ** 2.2
    apply(sampleNudgeFlight(points, eased))
    if (progress < 1) {
      raf = requestAnimationFrame(tick)
      return
    }
    raf = 0
    flightVisible.value = false
    if (dotTimer) {
      clearInterval(dotTimer)
      dotTimer = 0
    }
    showImpact(to, style, style === 'ink' ? 1500 : 780)
    timers.push(
      setTimeout(() => {
        trail.value = []
      }, 420)
    )
  }
  raf = requestAnimationFrame(tick)
}

defineExpose({ play })

onBeforeUnmount(clear)
</script>

<template>
  <Teleport to="body">
    <div class="nudge-fx-layer" aria-hidden="true">
    <span
      v-if="launch"
      class="nudge-launch"
      :style="{ left: `${launch.x}px`, top: `${launch.y}px` }"
    ></span>

    <div
      v-if="flightVisible"
      ref="flightEl"
      class="nudge-flight"
      :data-style="flightStyle"
    >
      <div ref="bodyEl" class="nudge-flight-body">
        <svg v-if="flightStyle === 'plane'" class="nudge-plane" viewBox="0 0 40 32">
          <path class="plane-wing" d="M3 3.5 37 16 3 28.5 9 18.5 3 16 9 13.5Z" />
          <path class="plane-fold" d="M9 13.5 37 16 9 18.5 13 16Z" />
          <path class="plane-crease" d="M3 3.5 13 16 3 28.5 M13 16h24" />
        </svg>
        <span v-else class="nudge-ink"><i></i></span>
      </div>
    </div>

    <span
      v-for="dot in trail"
      :key="dot.id"
      class="nudge-trail"
      :style="{ left: `${dot.x}px`, top: `${dot.y}px` }"
    ></span>

    <div
      v-if="impact"
      class="nudge-impact"
      :data-style="impact.style"
      :style="{ transform: `translate3d(${impact.x}px, ${impact.y}px, 0)` }"
    >
      <span class="impact-ring"></span>
      <span v-if="impact.style === 'ink'" class="impact-ring ink-ring-second"></span>
      <template v-if="impact.style === 'ink'">
        <span class="ink-burst"></span>
        <svg class="ink-splat" viewBox="-22 -22 44 44">
          <path
            class="splat-main"
            d="M0-16C5-21 9-12 13-15S15-9 20-8 15-3 18 1 17 5 13 7 13 14 8 13 4 19 0 15-5 19-8 13-15 14-13 7-21 5-18 1-21-6-16-8-17-15-12-12-6-20 0-16Z"
          />
          <circle class="splat-dot" cx="-19" cy="-11" r="2.8" />
          <circle class="splat-dot" cx="17" cy="-14" r="2.2" />
          <circle class="splat-dot" cx="19" cy="7" r="2.6" />
          <circle class="splat-dot" cx="-16" cy="13" r="2" />
          <ellipse class="splat-gloss" cx="-6" cy="-7" rx="5.2" ry="3" transform="rotate(-24 -6 -7)" />
        </svg>
        <svg class="ink-splat ink-splat-small" viewBox="-22 -22 44 44">
          <path
            class="splat-main"
            d="M0-16C5-21 9-12 13-15S15-9 20-8 15-3 18 1 17 5 13 7 13 14 8 13 4 19 0 15-5 19-8 13-15 14-13 7-21 5-18 1-21-6-16-8-17-15-12-12-6-20 0-16Z"
          />
          <circle class="splat-dot" cx="-17" cy="-12" r="2.1" />
          <circle class="splat-dot" cx="17" cy="7" r="2.4" />
        </svg>
        <i
          v-for="n in 14"
          :key="`drop-${n}`"
          class="ink-drop"
          :style="{
            '--a': `${(n * 360) / 14 + (n % 4) * 6}deg`,
            '--d': `${52 + ((n * 17) % 58)}px`,
            '--s': `${5 + (n % 4) * 1.7}px`,
            '--delay': `${(n % 5) * 16}ms`
          }"
        ></i>
        <i
          v-for="n in 3"
          :key="`drip-${n}`"
          class="ink-drip"
          :style="{
            '--x': `${(n - 2) * 12}px`,
            '--h': `${26 + (n % 3) * 10}px`,
            '--delay': `${140 + n * 40}ms`
          }"
        ></i>
        <i
          v-for="n in 6"
          :key="`mist-${n}`"
          class="ink-mist"
          :style="{
            '--a': `${n * 60 + 12}deg`,
            '--d': `${30 + n * 7}px`,
            '--delay': `${40 + n * 18}ms`
          }"
        ></i>
      </template>
      <template v-else>
        <i
          v-for="n in 6"
          :key="n"
          class="paper-bit"
          :style="{ '--a': `${n * 60}deg`, '--d': `${30 + (n % 2) * 12}px` }"
        ></i>
      </template>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.nudge-fx-layer {
  position: fixed;
  inset: 0;
  z-index: 60;
  overflow: hidden;
  pointer-events: none;
}

/* 起手：头像边缘的一圈轻响 */
.nudge-launch {
  position: absolute;
  top: 0;
  left: 0;
  width: 44px;
  height: 44px;
  margin: -22px 0 0 -22px;
  border: 2px solid var(--primary);
  border-radius: 50%;
  opacity: 0;
  animation: nudge-launch-ring 340ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

.nudge-flight {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
}

.nudge-flight-body {
  position: absolute;
  top: 0;
  left: 0;
  width: 44px;
  height: 36px;
}

.nudge-plane {
  display: block;
  width: 44px;
  height: 36px;
  color: var(--primary);
  filter: drop-shadow(0 7px 10px rgb(32 28 74 / 0.28));
}

.nudge-plane .plane-wing {
  fill: var(--bg-window);
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linejoin: round;
}

.nudge-plane .plane-fold {
  fill: currentColor;
  opacity: 0.26;
}

.nudge-plane .plane-crease {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.15;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.nudge-flight[data-style='plane'] .nudge-flight-body::after {
  content: '';
  position: absolute;
  top: 50%;
  right: 100%;
  width: 30px;
  height: 2px;
  margin-top: -1px;
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--primary));
  opacity: 0.35;
}

.nudge-ink {
  position: relative;
  display: block;
  width: 21px;
  height: 21px;
  margin: 6px;
  border-radius: 48% 52% 56% 44%;
  background:
    radial-gradient(circle at 34% 28%, rgb(255 255 255 / 0.42), transparent 46%),
    var(--primary);
  box-shadow:
    0 0 0 2px rgb(76 64 160 / 0.14),
    0 7px 14px rgb(32 28 74 / 0.32);
  animation: nudge-ink-wobble 260ms ease-in-out infinite alternate;
}

.nudge-ink i {
  position: absolute;
  top: 3px;
  right: 4px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgb(255 255 255 / 0.5);
}

.nudge-trail {
  position: absolute;
  top: 0;
  left: 0;
  width: 7px;
  height: 7px;
  margin: -3.5px 0 0 -3.5px;
  border-radius: 50%;
  background: var(--primary);
  opacity: 0.5;
  animation: nudge-trail-fade 420ms ease-out forwards;
}

.nudge-impact {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
}

.impact-ring {
  position: absolute;
  top: 0;
  left: 0;
  width: 46px;
  height: 46px;
  margin: -23px 0 0 -23px;
  border: 2px solid var(--primary);
  border-radius: 50%;
  opacity: 0;
  animation: nudge-impact-ring 520ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

.ink-burst {
  position: absolute;
  top: 0;
  left: 0;
  width: 118px;
  height: 118px;
  margin: -59px 0 0 -59px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--primary) 0%, transparent 68%);
  opacity: 0;
  filter: blur(2px);
  animation: nudge-ink-burst 620ms ease-out forwards;
}

.ink-splat {
  --rot: 0deg;
  position: absolute;
  top: 0;
  left: 0;
  width: 100px;
  height: 100px;
  margin: -50px 0 0 -50px;
  color: var(--primary);
  overflow: visible;
  filter: drop-shadow(0 4px 8px rgb(32 28 74 / 0.22));
  animation: nudge-splat 1050ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

.ink-splat-small {
  --rot: 142deg;
  width: 58px;
  height: 58px;
  margin: -29px 0 0 -29px;
  opacity: 0.55;
  animation-delay: 40ms;
}

.ink-splat .splat-main {
  fill: currentColor;
  opacity: 0.92;
}

.ink-splat .splat-dot {
  fill: currentColor;
  opacity: 0.75;
}

.ink-splat .splat-gloss {
  fill: rgb(255 255 255 / 0.28);
}

.ink-drop {
  position: absolute;
  top: 0;
  left: 0;
  width: var(--s, 7px);
  height: var(--s, 7px);
  margin: calc(var(--s, 7px) / -2) 0 0 calc(var(--s, 7px) / -2);
  border-radius: 50%;
  background: var(--primary);
  opacity: 0.9;
  animation: nudge-drop 860ms cubic-bezier(0.16, 1, 0.3, 1) var(--delay, 0ms) forwards;
}

.ink-drip {
  position: absolute;
  top: 12px;
  left: var(--x, 0);
  width: 4px;
  height: 0;
  margin-left: -2px;
  border-radius: 3px;
  background: var(--primary);
  opacity: 0;
  animation: nudge-drip 1040ms ease-in var(--delay, 0ms) forwards;
}

.ink-ring-second {
  width: 72px;
  height: 72px;
  margin: -36px 0 0 -36px;
  border-width: 3px;
  animation-delay: 70ms;
}

.ink-mist {
  position: absolute;
  top: 0;
  left: 0;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  border-radius: 50%;
  background: var(--primary);
  opacity: 0;
  filter: blur(3px);
  animation: nudge-mist 760ms ease-out var(--delay, 0ms) forwards;
}

.paper-bit {
  position: absolute;
  top: 0;
  left: 0;
  width: 11px;
  height: 7px;
  margin: -3.5px 0 0 -5.5px;
  background: var(--primary);
  clip-path: polygon(0 0, 100% 50%, 0 100%);
  opacity: 0.9;
  animation: nudge-paper-bit 560ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes nudge-launch-ring {
  0% {
    opacity: 0.55;
    transform: scale(0.4);
  }
  100% {
    opacity: 0;
    transform: scale(1.35);
  }
}

@keyframes nudge-ink-wobble {
  from {
    border-radius: 48% 52% 56% 44%;
    transform: rotate(-6deg);
  }
  to {
    border-radius: 56% 44% 46% 54%;
    transform: rotate(7deg);
  }
}

@keyframes nudge-trail-fade {
  from {
    opacity: 0.5;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.35);
  }
}

@keyframes nudge-impact-ring {
  0% {
    opacity: 0.55;
    transform: scale(0.25);
  }
  100% {
    opacity: 0;
    transform: scale(1.5);
  }
}

@keyframes nudge-ink-burst {
  0% {
    opacity: 0.32;
    transform: scale(0.15);
  }
  55% {
    opacity: 0.16;
  }
  100% {
    opacity: 0;
    transform: scale(1.35);
  }
}

@keyframes nudge-splat {
  0% {
    opacity: 0;
    transform: rotate(var(--rot)) scale(0.2);
  }
  30% {
    opacity: 0.92;
    transform: rotate(var(--rot)) scale(1.08);
  }
  65% {
    opacity: 0.82;
    transform: rotate(var(--rot)) scale(1);
  }
  100% {
    opacity: 0;
    transform: rotate(var(--rot)) scale(1.03);
  }
}

@keyframes nudge-drop {
  0% {
    opacity: 0.95;
    transform: rotate(var(--a)) translateX(10px) scale(0.5);
  }
  70% {
    opacity: 0.85;
  }
  100% {
    opacity: 0;
    transform: rotate(var(--a)) translateX(var(--d)) scale(0.12);
  }
}

@keyframes nudge-drip {
  0% {
    height: 0;
    opacity: 0.85;
  }
  55% {
    height: var(--h, 24px);
    opacity: 0.75;
  }
  100% {
    height: var(--h, 24px);
    opacity: 0;
    transform: translateY(8px);
  }
}

@keyframes nudge-mist {
  0% {
    opacity: 0.26;
    transform: rotate(var(--a)) translateX(4px) scale(0.4);
  }
  100% {
    opacity: 0;
    transform: rotate(var(--a)) translateX(var(--d)) scale(1.3);
  }
}

@keyframes nudge-paper-bit {
  0% {
    opacity: 0.9;
    transform: rotate(var(--a)) translateX(6px) rotate(0deg);
  }
  100% {
    opacity: 0;
    transform: rotate(var(--a)) translateX(var(--d)) rotate(150deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .nudge-launch,
  .nudge-flight,
  .nudge-trail,
  .ink-drop,
  .ink-drip,
  .ink-mist,
  .ink-burst,
  .paper-bit {
    display: none;
  }

  .impact-ring {
    animation: none;
    opacity: 0;
  }

  .ink-splat,
  .nudge-plane {
    animation: none;
  }

  .ink-splat {
    opacity: 1;
  }
}
</style>
