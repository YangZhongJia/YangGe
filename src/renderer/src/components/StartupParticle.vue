<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { edgeTargets, innerTargets } from '../utils/particle-targets'
import {
  CONVERGE_MS,
  DISPERSE_AT_MS,
  ICON_FULL_MS,
  ICON_IN_MS,
  MOTION_DURATION_MS,
  OVERLAY_FADE_MS,
  STATIC_HOLD_MS,
  degradeParticleCount,
  motionMode,
  resolveParticleCount
} from '../utils/startup-motion'

const props = defineProps<{ iconUrl: string }>()

type Stage = 'idle' | 'playing' | 'static' | 'leaving'
type MotionReason = 'startup' | 'restore'

const stage = ref<Stage>('idle')
const canvasEl = ref<HTMLCanvasElement | null>(null)

let rafId = 0
let hideTimer = 0
let leaveTimer = 0
let mediaQuery: MediaQueryList | null = null
let detachMedia: (() => void) | null = null
let stopScene: (() => void) | null = null
let playedStartup = false
let reducedMotion = false

interface Particle {
  tx: number
  ty: number
  sx: number
  sy: number
  nx: number
  ny: number
  curl: number
  dx: number
  dy: number
  dist: number
  delay: number
  pow: number
  ddelay: number
  size: number
  accent: boolean
  phase: number
}

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value
const smoothstep = (from: number, to: number, value: number): number => {
  const t = clamp((value - from) / (to - from), 0, 1)
  return t * t * (3 - 2 * t)
}

function clearTimers(): void {
  window.clearTimeout(hideTimer)
  window.clearTimeout(leaveTimer)
  hideTimer = 0
  leaveTimer = 0
}

function stopAnimation(): void {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
}

function cleanupScene(): void {
  stopAnimation()
  if (stopScene) {
    stopScene()
    stopScene = null
  }
  stage.value = 'idle'
}

function beginLeave(): void {
  if (stage.value === 'idle' || stage.value === 'leaving') return
  stopAnimation()
  stage.value = 'leaving'
  window.clearTimeout(leaveTimer)
  leaveTimer = window.setTimeout(() => {
    leaveTimer = 0
    cleanupScene()
  }, OVERLAY_FADE_MS)
}

function showStatic(): void {
  clearTimers()
  stopAnimation()
  stage.value = 'static'
  hideTimer = window.setTimeout(beginLeave, STATIC_HOLD_MS)
}

/** 启动时只播一次；托盘唤起/窗口 restore 可再次播放。 */
function play(reason: MotionReason = 'restore'): void {
  if (reason === 'startup') {
    if (playedStartup) return
    playedStartup = true
  }
  if (stage.value === 'playing' || stage.value === 'leaving') return
  if (motionMode(reducedMotion) === 'static') {
    showStatic()
    return
  }
  clearTimers()
  stage.value = 'playing'
  void nextTick(() => {
    if (stage.value !== 'playing') return
    const canvas = canvasEl.value
    if (!canvas) {
      beginLeave()
      return
    }
    startAnimation(canvas)
  })
}

function shuffledIndices(total: number): number[] {
  const order = new Array<number>(total)
  for (let i = 0; i < total; i++) order[i] = i
  for (let i = total - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = order[i]
    order[i] = order[j]
    order[j] = tmp
  }
  return order
}

function buildParticles(
  count: number,
  width: number,
  height: number,
  cx: number,
  cy: number,
  iconSize: number
): Particle[] {
  const edge = edgeTargets()
  const inner = innerTargets()
  const edgeCount = Math.floor(edge.length / 2)
  const innerCount = Math.floor(inner.length / 2)
  const edgeWanted = Math.min(edgeCount, Math.ceil(count / 2))
  const innerWanted = Math.min(innerCount, count - edgeWanted)
  const edgeOrder = shuffledIndices(edgeCount)
  const innerOrder = shuffledIndices(innerCount)
  const targets: Array<[number, number]> = []

  for (let i = 0; i < edgeWanted; i++) {
    const index = edgeOrder[i] * 2
    targets.push([edge[index], edge[index + 1]])
  }
  for (let i = 0; i < innerWanted; i++) {
    const index = innerOrder[i] * 2
    targets.push([inner[index], inner[index + 1]])
  }
  // 目标点不足时（理论上不会发生）用轮廓点补齐，保证粒子数与预算一致。
  for (let i = 0; targets.length < count; i++) {
    const index = edgeOrder[i % edgeCount] * 2
    targets.push([edge[index], edge[index + 1]])
  }

  const radius = Math.hypot(width, height) * 0.62
  return targets.slice(0, count).map(([px, py]) => {
    const tx = cx + (px - 0.5) * iconSize
    const ty = cy + (py - 0.5) * iconSize
    const angle = Math.atan2(ty - cy, tx - cx) + (Math.random() - 0.5) * 0.55
    const distance = radius * (0.92 + Math.random() * 0.62)
    const sx = cx + Math.cos(angle) * distance
    const sy = cy + Math.sin(angle) * distance
    const vx = tx - sx
    const vy = ty - sy
    const length = Math.hypot(vx, vy) || 1
    const disperseAngle = Math.atan2(ty - cy, tx - cx) + (Math.random() - 0.5) * 0.9
    return {
      tx,
      ty,
      sx,
      sy,
      nx: -vy / length,
      ny: vx / length,
      curl: (Math.random() - 0.5) * 2 * (26 + Math.random() * 76),
      dx: Math.cos(disperseAngle),
      dy: Math.sin(disperseAngle),
      dist: 42 + Math.random() * 150,
      delay: Math.random() * 70,
      pow: 2.7 + Math.random() * 1.7,
      ddelay: Math.random() * 46,
      size: 0.95 + Math.random() * 1.25,
      accent: Math.random() < 0.22,
      phase: Math.random() * Math.PI * 2
    }
  })
}

function readPrimaryRgb(): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--primary-rgb').trim()
    return /^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/.test(value) ? value.replace(/\s+/g, '') : '88,80,236'
  } catch {
    return '88,80,236'
  }
}

function darkenRgb(rgb: string, factor: number): string {
  const parts = rgb.split(',').map((part) => Math.max(0, Math.min(255, Math.round(Number(part) * factor))))
  return parts.join(',')
}

function makeSprite(rgb: string): HTMLCanvasElement {
  const size = 64
  const sprite = document.createElement('canvas')
  sprite.width = size
  sprite.height = size
  const spriteCtx = sprite.getContext('2d')
  if (spriteCtx) {
    const gradient = spriteCtx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    gradient.addColorStop(0, `rgba(${rgb},1)`)
    gradient.addColorStop(0.22, `rgba(${rgb},.62)`)
    gradient.addColorStop(0.55, `rgba(${rgb},.16)`)
    gradient.addColorStop(1, `rgba(${rgb},0)`)
    spriteCtx.fillStyle = gradient
    spriteCtx.fillRect(0, 0, size, size)
  }
  return sprite
}

function startAnimation(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(1, window.innerWidth)
  const height = Math.max(1, window.innerHeight)
  canvas.width = Math.max(1, Math.round(width * dpr))
  canvas.height = Math.max(1, Math.round(height * dpr))
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) {
    beginLeave()
    return
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.imageSmoothingQuality = 'high'

  const cx = width / 2
  const cy = height / 2 - Math.min(16, height * 0.02)
  const iconSize = clamp(Math.min(width, height) * 0.4, 190, 340)
  const dark = document.documentElement.dataset.theme === 'dark'
  const primaryRgb = readPrimaryRgb()
  const sprites = {
    main: makeSprite(primaryRgb),
    accent: makeSprite(dark ? '255,255,255' : darkenRgb(primaryRgb, 0.64))
  }

  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, iconSize * 1.15)
  glow.addColorStop(0, `rgba(${primaryRgb},${dark ? 0.4 : 0.18})`)
  glow.addColorStop(0.45, `rgba(${primaryRgb},${dark ? 0.14 : 0.07})`)
  glow.addColorStop(1, `rgba(${primaryRgb},0)`)

  let particles = buildParticles(resolveParticleCount({ dpr }), width, height, cx, cy, iconSize)
  let icon: HTMLImageElement | null = null
  const image = new Image()
  image.decoding = 'async'
  image.onload = () => {
    icon = image
  }
  image.src = props.iconUrl
  if (image.complete && image.naturalWidth > 0) icon = image

  let disposed = false
  let lastFrameAt = 0
  let frameSum = 0
  let frameSamples = 0

  const drawParticles = (time: number): void => {
    ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over'
    for (const particle of particles) {
      const converge = clamp((time - particle.delay) / CONVERGE_MS, 0, 1)
      const eased = 1 - Math.pow(1 - converge, particle.pow)
      let x = particle.sx + (particle.tx - particle.sx) * eased
      let y = particle.sy + (particle.ty - particle.sy) * eased
      const arc = Math.sin(Math.PI * eased) * particle.curl
      x += particle.nx * arc
      y += particle.ny * arc

      let alpha = Math.min(1, converge * 4.2) * 0.92
      let size = particle.size * (0.55 + 0.45 * eased)

      if (time >= DISPERSE_AT_MS) {
        const span = 150 - particle.ddelay
        const disperse = clamp((time - DISPERSE_AT_MS - particle.ddelay) / span, 0, 1)
        const easedDisperse = disperse * disperse
        x = particle.tx + particle.dx * particle.dist * easedDisperse
        y = particle.ty + particle.dy * particle.dist * easedDisperse
        alpha *= Math.pow(1 - disperse, 1.7)
        size *= 1 - 0.4 * disperse
      } else if (converge >= 1) {
        alpha *= 0.92 + 0.08 * Math.sin(time * 0.02 + particle.phase)
      }

      if (time > ICON_IN_MS) {
        const handoff = smoothstep(ICON_IN_MS, ICON_FULL_MS, time)
        alpha *= 1 - 0.55 * handoff
        x += particle.dx * 8 * handoff
        y += particle.dy * 8 * handoff
      }

      if (alpha <= 0.002) continue
      const spriteSize = size * 8
      ctx.globalAlpha = Math.min(1, alpha)
      ctx.drawImage(
        particle.accent ? sprites.accent : sprites.main,
        x - spriteSize / 2,
        y - spriteSize / 2,
        spriteSize,
        spriteSize
      )
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  const draw = (time: number): void => {
    ctx.clearRect(0, 0, width, height)
    const iconRaw = smoothstep(ICON_IN_MS, ICON_FULL_MS, time)
    const iconAlpha = 1 - Math.pow(1 - iconRaw, 3)
    const gather = smoothstep(0, ICON_IN_MS, time)

    ctx.globalAlpha = 0.16 + 0.3 * iconAlpha + 0.14 * gather * (1 - iconAlpha)
    ctx.fillStyle = glow
    ctx.fillRect(cx - iconSize * 1.2, cy - iconSize * 1.2, iconSize * 2.4, iconSize * 2.4)
    ctx.globalAlpha = 1

    if (icon && iconRaw > 0.001) {
      const scale = 0.93 + 0.07 * (1 - Math.pow(1 - iconRaw, 5))
      const size = iconSize * scale
      ctx.globalAlpha = iconAlpha
      ctx.drawImage(icon, cx - size / 2, cy - size / 2, size, size)
      ctx.globalAlpha = 1
    }

    drawParticles(time)
  }

  const onVisibility = (): void => {
    if (!document.hidden) return
    cleanup()
    stage.value = 'idle'
  }
  const onResize = (): void => {
    if (stage.value === 'playing') beginLeave()
  }

  const cleanup = (): void => {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(rafId)
    rafId = 0
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onVisibility)
    window.removeEventListener('resize', onResize)
    particles = []
    canvas.width = 0
    canvas.height = 0
    if (stopScene === cleanup) stopScene = null
  }
  stopScene = cleanup
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onVisibility)
  window.addEventListener('resize', onResize)

  const startAt = performance.now()
  const frame = (now: number): void => {
    if (disposed) return
    const interval = lastFrameAt > 0 ? now - lastFrameAt : 0
    lastFrameAt = now
    if (interval > 0 && interval < 200) {
      frameSum += interval
      frameSamples++
    }
    if (frameSamples >= 20) {
      const next = degradeParticleCount(particles.length, frameSum / frameSamples)
      if (next < particles.length) particles.length = next
      frameSum = 0
      frameSamples = 0
    }
    const time = Math.max(0, Math.min(now - startAt, MOTION_DURATION_MS))
    draw(time)
    if (time >= MOTION_DURATION_MS) {
      particles = []
      beginLeave()
      return
    }
    rafId = requestAnimationFrame(frame)
  }
  rafId = requestAnimationFrame(frame)
}

onMounted(() => {
  try {
    mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotion = mediaQuery.matches
    const onMediaChange = (event: MediaQueryListEvent): void => {
      reducedMotion = event.matches
      if (reducedMotion && stage.value === 'playing') beginLeave()
    }
    mediaQuery.addEventListener('change', onMediaChange)
    detachMedia = () => mediaQuery?.removeEventListener('change', onMediaChange)
  } catch {
    reducedMotion = false
  }
})

onBeforeUnmount(() => {
  clearTimers()
  detachMedia?.()
  detachMedia = null
  mediaQuery = null
  cleanupScene()
})

defineExpose({ play })
</script>

<template>
  <div
    v-if="stage !== 'idle'"
    class="startup-motion"
    :class="{ 'is-leaving': stage === 'leaving' }"
    aria-hidden="true"
  >
    <canvas
      v-if="stage === 'playing' || stage === 'leaving'"
      ref="canvasEl"
      class="startup-motion-canvas"
    ></canvas>
    <img v-else :src="iconUrl" class="startup-motion-icon" alt="" draggable="false" />
  </div>
</template>

<style scoped>
.startup-motion {
  position: fixed;
  inset: 0;
  z-index: 1100;
  overflow: hidden;
  pointer-events: none;
  opacity: 1;
  background: radial-gradient(42% 40% at 50% 46%, rgba(var(--primary-rgb), 0.13), transparent 72%);
  transition: opacity 160ms ease-out;
}
.startup-motion.is-leaving {
  opacity: 0;
}
.startup-motion-canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}
.startup-motion-icon {
  position: absolute;
  top: 50%;
  left: 50%;
  width: clamp(190px, 40vmin, 340px);
  height: auto;
  transform: translate(-50%, -50%);
  filter: drop-shadow(0 18px 44px rgba(15, 18, 30, 0.28));
}
@media (prefers-reduced-motion: reduce) {
  .startup-motion,
  .startup-motion-icon {
    transition: none;
    filter: none;
  }
}
</style>
