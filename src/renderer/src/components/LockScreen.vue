<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { tr } from '../utils/i18n'

defineProps<{
  nick: string
  iconUrl: string
}>()

const emit = defineEmits<{ unlocked: [] }>()

const pin = ref('')
const busy = ref(false)
const error = ref('')
const shake = ref(false)
const cooldownUntil = ref(0)
const now = ref(Date.now())
const inputRef = ref<HTMLInputElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
let cooldownTimer: ReturnType<typeof setInterval> | null = null
let shakeTimer: ReturnType<typeof setTimeout> | null = null
let stopParticles: (() => void) | null = null
let focusHandler: (() => void) | null = null

const cooldownRemaining = computed(() => Math.max(0, cooldownUntil.value - now.value))
const cooldownSeconds = computed(() => Math.ceil(cooldownRemaining.value / 1000))
const canSubmit = computed(() => pin.value.length === 6 && !busy.value && cooldownRemaining.value <= 0)

function focusInput(): void {
  if (cooldownRemaining.value > 0) return
  inputRef.value?.focus({ preventScroll: true })
}

function onPinInput(event: Event): void {
  const input = event.target as HTMLInputElement
  const digits = input.value.replace(/\D/g, '').slice(0, 6)
  pin.value = digits
  input.value = digits
  error.value = ''
  if (digits.length === 6) void submit()
}

function triggerShake(): void {
  shake.value = false
  if (shakeTimer) clearTimeout(shakeTimer)
  void nextTick(() => {
    shake.value = true
    shakeTimer = setTimeout(() => {
      shake.value = false
      shakeTimer = null
    }, 420)
  })
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await window.pantry.verifyLockPin(pin.value)
    if (result.ok) {
      pin.value = ''
      emit('unlocked')
      return
    }
    if (result.retryAfterMs && result.retryAfterMs > 0) {
      cooldownUntil.value = Date.now() + result.retryAfterMs
      now.value = Date.now()
      error.value = tr('尝试次数过多，请 {0} 秒后再试', { 0: Math.ceil(result.retryAfterMs / 1000) })
    } else {
      error.value = tr('密码错误，请重试')
    }
    pin.value = ''
    triggerShake()
    await nextTick()
    focusInput()
  } catch {
    error.value = tr('解锁失败，请重试')
    pin.value = ''
  } finally {
    busy.value = false
  }
}

function closeApp(): void {
  // 与标题栏关闭一致：主进程按「关闭进托盘」处理；锁屏期间窗口控制被遮住，这里补回关闭入口。
  void window.pantry.closeWindow()
}

function startCooldownClock(): void {
  cooldownTimer = setInterval(() => {
    now.value = Date.now()
    if (cooldownUntil.value > 0 && cooldownRemaining.value <= 0) {
      cooldownUntil.value = 0
      error.value = ''
      focusInput()
    }
  }, 500)
}

interface Particle {
  x: number
  y: number
  depth: number
  phase: number
  speed: number
  radius: number
  cyan: boolean
}

/** A quiet constellation field with two drifting streams, bounded for office hardware. */
function startParticles(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return () => undefined
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let width = 1
  let height = 1
  let frame = 0
  let last = 0
  let elapsed = 0
  let particles: Particle[] = []

  const paint = (advance: number): void => {
    elapsed += advance
    ctx.clearRect(0, 0, width, height)
    const t = elapsed / 1000
    const cx = width * 0.5
    const cy = height * 0.49
    const scale = Math.min(width, height)

    // Elliptical paths frame the sign-in card without obscuring its controls.
    for (let ring = 0; ring < 3; ring += 1) {
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(-0.24 + ring * 0.12)
      ctx.beginPath()
      ctx.ellipse(0, 0, scale * (0.43 + ring * 0.105), scale * (0.21 + ring * 0.047), 0, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(151, 169, 255, ${0.075 - ring * 0.016})`
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.restore()
    }

    for (const p of particles) {
      p.x += advance * p.speed * p.depth
      if (p.x > 1.08) p.x = -0.08
      const x = p.x * width
      const y = (p.y + Math.sin(t * 0.24 + p.phase) * 0.012 * p.depth) * height
      const twinkle = motion.matches ? 0.75 : 0.7 + 0.3 * Math.sin(t * 0.9 + p.phase)
      const alpha = (0.22 + p.depth * 0.52) * twinkle
      const color = p.cyan ? '125, 225, 247' : '185, 190, 255'
      if (p.depth > 0.72) {
        const glow = ctx.createRadialGradient(x, y, 0, x, y, p.radius * 7)
        glow.addColorStop(0, `rgba(${color}, ${alpha * 0.3})`)
        glow.addColorStop(1, `rgba(${color}, 0)`)
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(x, y, p.radius * 7, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.fillStyle = `rgba(${color}, ${alpha})`
      ctx.beginPath()
      ctx.arc(x, y, p.radius, 0, Math.PI * 2)
      ctx.fill()
    }

    // A few luminous motes travel along the arcs; the long tail suggests motion at a glance.
    for (let i = 0; i < 5; i += 1) {
      const angle = t * (0.09 + i * 0.007) + i * 2.17
      const radius = scale * (0.43 + (i % 3) * 0.105)
      const rx = radius
      const ry = scale * (0.21 + (i % 3) * 0.047)
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(-0.24 + (i % 3) * 0.12)
      ctx.beginPath()
      ctx.ellipse(0, 0, rx, ry, 0, angle - 0.24, angle)
      ctx.strokeStyle = 'rgba(164, 194, 255, 0.28)'
      ctx.lineWidth = 1.2
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(Math.cos(angle) * rx, Math.sin(angle) * ry, 2, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(222, 235, 255, 0.8)'
      ctx.fill()
      ctx.restore()
    }
  }

  const tick = (time: number): void => {
    frame = 0
    if (document.hidden || motion.matches) return
    const delta = last ? Math.min(time - last, 48) : 0
    last = time
    paint(delta)
    frame = requestAnimationFrame(tick)
  }
  const schedule = (): void => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    last = 0
    paint(0)
    if (!document.hidden && !motion.matches) frame = requestAnimationFrame(tick)
  }
  const resize = (): void => {
    const rect = canvas.getBoundingClientRect()
    width = Math.max(1, rect.width)
    height = Math.max(1, rect.height)
    const dpr = Math.min(1.5, window.devicePixelRatio || 1)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const count = Math.min(140, Math.max(65, Math.round(width * height / 8000)))
    particles = Array.from({ length: count }, () => ({
      x: Math.random(), y: Math.random(), depth: 0.25 + Math.random() * 0.75,
      phase: Math.random() * Math.PI * 2, speed: 0.000006 + Math.random() * 0.000012,
      radius: 0.5 + Math.random() * 1.4, cyan: Math.random() < 0.25
    }))
    schedule()
  }
  window.addEventListener('resize', resize)
  document.addEventListener('visibilitychange', schedule)
  motion.addEventListener('change', schedule)
  resize()
  return () => {
    if (frame) cancelAnimationFrame(frame)
    window.removeEventListener('resize', resize)
    document.removeEventListener('visibilitychange', schedule)
    motion.removeEventListener('change', schedule)
  }
}

onMounted(async () => {
  await nextTick()
  focusInput()
  startCooldownClock()
  focusHandler = () => focusInput()
  window.addEventListener('focus', focusHandler)
  if (canvasRef.value) stopParticles = startParticles(canvasRef.value)
})

onBeforeUnmount(() => {
  stopParticles?.()
  stopParticles = null
  if (focusHandler) window.removeEventListener('focus', focusHandler)
  if (cooldownTimer) clearInterval(cooldownTimer)
  if (shakeTimer) clearTimeout(shakeTimer)
})
</script>

<template>
  <div class="lock-screen" role="dialog" aria-modal="true" :aria-label="tr('阳鸽已锁定')">
    <canvas ref="canvasRef" class="lock-particles" aria-hidden="true"></canvas>
    <div class="lock-aurora" aria-hidden="true"></div>
    <div class="lock-vignette" aria-hidden="true"></div>
    <section class="lock-card">
      <button
        type="button"
        class="lock-close"
        :aria-label="tr('关闭')"
        :title="tr('关闭')"
        @click="closeApp"
      >×</button>
      <div class="lock-brand">
        <img :src="iconUrl" alt="" draggable="false" />
      </div>
      <h1>{{ tr('阳鸽已锁定') }}</h1>
      <p class="lock-account">
        <strong>{{ nick || tr('本机账户') }}</strong>
        <span>{{ tr('输入 6 位数字密码继续') }}</span>
      </p>

      <div class="pin-shell" :class="{ shake, cooling: cooldownRemaining > 0 }">
        <div class="pin-slots" aria-hidden="true">
          <span
            v-for="n in 6"
            :key="n"
            class="pin-slot"
            :class="{ filled: pin.length >= n, active: pin.length === n - 1 && !cooldownRemaining }"
          >
            <i v-if="pin.length >= n"></i>
          </span>
        </div>
        <input
          ref="inputRef"
          class="pin-input"
          type="password"
          inputmode="numeric"
          autocomplete="off"
          spellcheck="false"
          maxlength="6"
          :aria-label="tr('6 位数字密码')"
          :disabled="busy || cooldownRemaining > 0"
          :value="pin"
          @input="onPinInput"
          @keydown.enter.prevent="submit"
        />
      </div>

      <p class="lock-hint">{{ tr('密码仅以加盐哈希保存在本机') }}</p>
      <p class="lock-error" role="status" aria-live="polite">{{ error }}</p>
      <button class="unlock-btn" type="button" :disabled="!canSubmit" @click="submit">
        {{ busy ? tr('验证中…') : cooldownRemaining > 0 ? tr('{0} 秒后重试', { 0: cooldownSeconds }) : tr('解锁') }}
      </button>
    </section>
  </div>
</template>

<style scoped>
.lock-screen {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: grid;
  place-items: center;
  overflow: hidden;
  color: #eef2ff;
  background:
    radial-gradient(ellipse at 50% 48%, rgba(72, 85, 160, 0.2), transparent 52%),
    radial-gradient(ellipse at 12% 80%, rgba(52, 117, 163, 0.22), transparent 42%),
    linear-gradient(145deg, #060a17 0%, #10132b 48%, #080d20 100%);
  -webkit-app-region: no-drag;
  user-select: none;
}
.lock-particles,
.lock-aurora,
.lock-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.lock-particles {
  z-index: 1;
  width: 100%;
  height: 100%;
}
.lock-aurora {
  background:
    radial-gradient(circle at 50% 38%, rgba(99, 102, 241, 0.14), transparent 34%),
    conic-gradient(from 210deg at 50% 50%, transparent 0 28%, rgba(56, 189, 248, 0.06) 42%, transparent 58% 100%);
  animation: lock-aurora 18s linear infinite;
  filter: blur(18px);
}
.lock-vignette {
  background: radial-gradient(circle at 50% 48%, transparent 30%, rgba(2, 6, 23, 0.3) 100%);
}
.lock-card {
  position: relative;
  z-index: 2;
  width: min(420px, calc(100vw - 40px));
  padding: 34px 34px 28px;
  border: 1px solid rgba(187, 202, 255, 0.22);
  border-radius: 24px;
  background: linear-gradient(155deg, rgba(24, 31, 61, 0.9), rgba(8, 13, 30, 0.94));
  box-shadow:
    0 30px 80px rgba(2, 6, 23, 0.6),
    inset 0 1px 0 rgba(225, 232, 255, 0.13);
  backdrop-filter: blur(14px) saturate(1.15);
  text-align: center;
  animation: lock-card-in 420ms cubic-bezier(0.22, 1, 0.36, 1);
}
.lock-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: rgba(203, 213, 225, 0.55);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.lock-close:hover {
  background: rgba(148, 163, 184, 0.16);
  color: #eef2ff;
}
.lock-close:focus-visible {
  outline: 2px solid rgba(165, 180, 252, 0.7);
  outline-offset: 2px;
}
.lock-brand {
  width: 58px;
  height: 58px;
  margin: 0 auto 16px;
  display: grid;
  place-items: center;
  border-radius: 18px;
  background: rgba(129, 140, 248, 0.12);
  box-shadow: 0 0 0 1px rgba(165, 180, 252, 0.18), 0 12px 30px rgba(49, 46, 129, 0.35);
}
.lock-brand img {
  width: 38px;
  height: 38px;
  border-radius: 11px;
  object-fit: cover;
}
.lock-eyebrow {
  margin: 0 0 8px;
  color: rgba(165, 180, 252, 0.72);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.24em;
}
.lock-card h1 {
  margin: 0;
  font-size: 25px;
  font-weight: 650;
  letter-spacing: 0.02em;
}
.lock-account {
  margin: 12px 0 22px;
  color: rgba(203, 213, 225, 0.66);
  font-size: 13px;
  line-height: 1.7;
}
.lock-account strong {
  display: block;
  color: #e0e7ff;
  font-weight: 600;
}
.pin-shell {
  position: relative;
  display: flex;
  justify-content: center;
  margin: 0 auto;
}
.pin-slots {
  display: flex;
  gap: 9px;
}
.pin-slot {
  width: 42px;
  height: 50px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(129, 140, 248, 0.22);
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.6);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  transition: border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease;
}
.pin-slot.filled {
  border-color: rgba(129, 140, 248, 0.55);
  background: rgba(67, 56, 202, 0.2);
}
.pin-slot.active {
  border-color: rgba(165, 180, 252, 0.8);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.14);
}
.pin-slot i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #c7d2fe;
  box-shadow: 0 0 10px rgba(165, 180, 252, 0.75);
}
.pin-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: text;
  border: 0;
  font-size: 16px;
}
.pin-input:disabled {
  cursor: wait;
}
.pin-shell.shake {
  animation: lock-shake 380ms cubic-bezier(0.36, 0.07, 0.19, 0.97);
}
.pin-shell.shake .pin-slot {
  border-color: rgba(248, 113, 113, 0.65);
}
.lock-hint {
  margin: 12px 0 0;
  color: rgba(148, 163, 184, 0.55);
  font-size: 11px;
}
.lock-error {
  min-height: 18px;
  margin: 12px 0 4px;
  color: #fca5a5;
  font-size: 12px;
}
.unlock-btn {
  width: 100%;
  height: 42px;
  margin-top: 4px;
  border: 1px solid rgba(165, 180, 252, 0.36);
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.94), rgba(67, 56, 202, 0.94));
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.08em;
  cursor: pointer;
  box-shadow: 0 10px 28px rgba(49, 46, 129, 0.38);
  transition: filter 160ms ease, transform 100ms ease, opacity 160ms ease;
}
.unlock-btn:hover:not(:disabled) {
  filter: brightness(1.08);
}
.unlock-btn:active:not(:disabled) {
  transform: translateY(1px);
}
.unlock-btn:disabled {
  opacity: 0.42;
  cursor: not-allowed;
  box-shadow: none;
}
@keyframes lock-card-in {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
@keyframes lock-aurora {
  to {
    transform: rotate(360deg) scale(1.12);
  }
}
@keyframes lock-shake {
  10%, 90% { transform: translateX(-2px); }
  20%, 80% { transform: translateX(4px); }
  30%, 50%, 70% { transform: translateX(-6px); }
  40%, 60% { transform: translateX(6px); }
}
@media (prefers-reduced-motion: reduce) {
  .lock-card,
  .lock-aurora,
  .pin-shell.shake {
    animation: none;
  }
}
</style>
