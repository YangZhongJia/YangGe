<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { tr } from '../utils/i18n'
import { pinInputSlots } from '../utils/lock-pin-input'
import doveMarkUrl from '../assets/brand/yangge-mark.svg?url'

defineProps<{
  nick: string
  iconUrl: string
}>()

const emit = defineEmits<{ unlocked: [] }>()

const pin = ref('')
const busy = ref(false)
const settling = ref(false)
const error = ref('')
const shake = ref(false)
const cooldownUntil = ref(0)
const now = ref(Date.now())
const inputRef = ref<HTMLInputElement | null>(null)
const pinShellRef = ref<HTMLElement | null>(null)
const brandRef = ref<HTMLElement | null>(null)
const doveRef = ref<HTMLElement | null>(null)
const doveAway = ref(false)
let cooldownTimer: ReturnType<typeof setInterval> | null = null
let shakeTimer: ReturnType<typeof setTimeout> | null = null
let focusHandler: (() => void) | null = null
let pendingPinEdit: { start: number; end: number } | undefined

const cooldownRemaining = computed(() => Math.max(0, cooldownUntil.value - now.value))
const canSubmit = computed(() =>
  pin.value.length === 6 && !busy.value && !settling.value && cooldownRemaining.value <= 0
)

const DOVE_SIZE = 42
const DOVE_GAP = 10
const FLIGHT_MS = 440
const RETURN_MS = 380
const PERCH_MS = 150

interface Point { x: number; y: number }
let flight: Animation | null = null
let flightResolve: (() => void) | null = null
let flightSlot: number | null = null
let flightPromise: Promise<void> | null = null
let doveActive = false

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function focusInput(): void {
  if (cooldownRemaining.value > 0) return
  inputRef.value?.focus({ preventScroll: true })
}

function positionOf(element: Element | null): Point | null {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return { x: rect.left, y: rect.top }
}

function iconTopLeft(): Point {
  const brand = brandRef.value
  if (!brand) return { x: 0, y: 0 }
  const rect = brand.getBoundingClientRect()
  return { x: rect.left + rect.width / 2 - DOVE_SIZE / 2, y: rect.top + rect.height / 2 - DOVE_SIZE / 2 }
}

function slotTopLeft(slot: number): Point | null {
  const target = pinShellRef.value?.querySelectorAll<HTMLElement>('.pin-slot')[slot]
  if (!target) return null
  const position = positionOf(target)
  if (!position) return null
  return {
    x: position.x + target.getBoundingClientRect().width / 2 - DOVE_SIZE / 2,
    y: position.y - DOVE_SIZE - DOVE_GAP
  }
}

function currentDoveTopLeft(): Point {
  const dove = doveRef.value
  return positionOf(dove) ?? iconTopLeft()
}

function cubicPoint(start: Point, c1: Point, c2: Point, end: Point, t: number): Point {
  const u = 1 - t
  return {
    x: u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
    y: u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y
  }
}

function flightFrames(start: Point, end: Point, startScale: number, endScale: number, startOpacity: number, endOpacity: number): Keyframe[] {
  const dx = end.x - start.x
  const lift = Math.max(38, Math.min(118, Math.abs(dx) * 0.28 + 46))
  const c1 = { x: start.x + dx * 0.16, y: Math.min(start.y, end.y) - lift }
  const c2 = { x: start.x + dx * 0.84, y: Math.min(start.y, end.y) - lift * 0.62 }
  const tilt = Math.max(-13, Math.min(13, dx / 20))
  const frames: Keyframe[] = []
  for (let i = 0; i <= 24; i += 1) {
    const t = i / 24
    const point = cubicPoint(start, c1, c2, end, t)
    const scale = startScale + (endScale - startScale) * t
    const opacity = startOpacity + (endOpacity - startOpacity) * t
    const rotation = Math.sin(Math.PI * t) * tilt * (1 - t * 0.25)
    frames.push({
      transform: `translate3d(${point.x}px, ${point.y}px, 0) rotate(${rotation}deg) scale(${scale})`,
      opacity,
      offset: t
    })
  }
  return frames
}

function pulseBrand(): void {
  if (prefersReducedMotion()) return
  brandRef.value?.animate([
    { transform: 'scale(1)' },
    { transform: 'scale(1.09)', offset: 0.38 },
    { transform: 'scale(1)' }
  ], { duration: 380, easing: 'cubic-bezier(.16,1,.3,1)' })
}

function cancelFlight(): void {
  if (flight) {
    flight.cancel()
    flight = null
  }
  flightSlot = null
  flightPromise = null
  const done = flightResolve
  flightResolve = null
  done?.()
}

function flyToSlot(slot: number): Promise<void> {
  const dove = doveRef.value
  const end = slotTopLeft(slot)
  if (!dove || !end) return Promise.resolve()
  if (flightSlot === slot && flightPromise) return flightPromise
  if (flightSlot === slot && doveActive) return Promise.resolve()

  const start = doveActive ? currentDoveTopLeft() : iconTopLeft()
  const startScale = doveActive ? 1 : 0.25
  const startOpacity = doveActive ? 1 : 0
  cancelFlight()
  doveAway.value = true
  dove.classList.remove('is-perched')
  dove.classList.add('is-flying')
  doveActive = true
  flightSlot = slot
  const promise = new Promise<void>((resolve) => { flightResolve = resolve })
  flightPromise = promise

  if (prefersReducedMotion()) {
    dove.style.transform = `translate3d(${end.x}px, ${end.y}px, 0) scale(1)`
    dove.style.opacity = '1'
    dove.classList.remove('is-flying')
    dove.classList.add('is-perched')
    flightSlot = null
    flightPromise = null
    const done = flightResolve
    flightResolve = null
    done?.()
    return promise
  }

  const animation = dove.animate(flightFrames(start, end, startScale, 1, startOpacity, 1), {
    duration: FLIGHT_MS,
    easing: 'cubic-bezier(.22,.82,.24,1)',
    fill: 'forwards'
  })
  flight = animation
  animation.onfinish = () => {
    if (flight !== animation) return
    flight = null
    flightSlot = null
    flightPromise = null
    dove.style.transform = `translate3d(${end.x}px, ${end.y}px, 0) scale(1)`
    dove.style.opacity = '1'
    dove.classList.remove('is-flying')
    dove.classList.add('is-perched')
    animation.cancel()
    const done = flightResolve
    flightResolve = null
    done?.()
  }
  return promise
}

function returnToIcon(): Promise<void> {
  const dove = doveRef.value
  if (!dove || !doveActive) return Promise.resolve()
  const start = currentDoveTopLeft()
  const end = iconTopLeft()
  cancelFlight()
  dove.classList.remove('is-perched')
  dove.classList.add('is-flying')
  const promise = new Promise<void>((resolve) => { flightResolve = resolve })

  if (prefersReducedMotion()) {
    dove.style.transform = `translate3d(${end.x}px, ${end.y}px, 0) scale(.22)`
    dove.style.opacity = '0'
    dove.classList.remove('is-flying', 'is-perched')
    doveActive = false
    doveAway.value = false
    const done = flightResolve
    flightResolve = null
    done?.()
    return promise
  }

  const animation = dove.animate(flightFrames(start, end, 1, 0.22, 1, 0), {
    duration: RETURN_MS,
    easing: 'cubic-bezier(.3,.8,.25,1)',
    fill: 'forwards'
  })
  flight = animation
  animation.onfinish = () => {
    if (flight !== animation) return
    flight = null
    dove.style.transform = `translate3d(${end.x}px, ${end.y}px, 0) scale(.22)`
    dove.style.opacity = '0'
    dove.classList.remove('is-flying', 'is-perched')
    doveActive = false
    animation.cancel()
    doveAway.value = false
    pulseBrand()
    const done = flightResolve
    flightResolve = null
    done?.()
  }
  return promise
}

function onBeforePinInput(event: Event): void {
  const input = event.target as HTMLInputElement
  pendingPinEdit = (event as InputEvent).inputType?.startsWith('insert')
    ? { start: input.selectionStart ?? pin.value.length, end: input.selectionEnd ?? pin.value.length }
    : undefined
}

function onPinInput(event: Event): void {
  const input = event.target as HTMLInputElement
  const previous = pin.value
  const digits = input.value.replace(/\D/g, '').slice(0, 6)
  const slots = pinInputSlots(previous, digits, pendingPinEdit)
  pendingPinEdit = undefined
  pin.value = digits
  input.value = digits
  error.value = ''

  if (slots.length > 0) {
    void flyToSlot(slots[slots.length - 1])
  } else if (digits.length < previous.length) {
    if (digits.length === 0) void returnToIcon()
    else void flyToSlot(digits.length - 1)
  }

  if (digits.length === 6) void finishEntry()
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function finishEntry(): Promise<void> {
  if (settling.value) return
  settling.value = true
  try {
    await flyToSlot(5)
    if (!prefersReducedMotion()) await wait(PERCH_MS)
    await returnToIcon()
  } finally {
    settling.value = false
  }
  await submit()
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
  void window.pantry.closeWindow()
}

function startCooldownClock(): void {
  cooldownTimer = setInterval(() => {
    now.value = Date.now()
    if (cooldownUntil.value <= 0) return
    const seconds = Math.ceil(cooldownRemaining.value / 1000)
    if (seconds > 0) {
      error.value = tr('尝试次数过多，请 {0} 秒后再试', { 0: seconds })
      return
    }
    cooldownUntil.value = 0
    error.value = ''
    focusInput()
  }, 500)
}

onMounted(async () => {
  await nextTick()
  focusInput()
  startCooldownClock()
  focusHandler = () => focusInput()
  window.addEventListener('focus', focusHandler)
  const start = iconTopLeft()
  if (doveRef.value) {
    doveRef.value.style.transform = `translate3d(${start.x}px, ${start.y}px, 0) scale(.22)`
    doveRef.value.style.opacity = '0'
  }
})

onBeforeUnmount(() => {
  cancelFlight()
  if (focusHandler) window.removeEventListener('focus', focusHandler)
  if (cooldownTimer) clearInterval(cooldownTimer)
  if (shakeTimer) clearTimeout(shakeTimer)
})
</script>

<template>
  <div class="lock-screen" role="dialog" aria-modal="true" :aria-label="tr('阳鸽已锁定')">
    <div class="lock-beam" aria-hidden="true"></div>
    <div class="lock-horizon" aria-hidden="true"></div>
    <section class="lock-card">
      <button
        type="button"
        class="lock-close"
        :aria-label="tr('关闭')"
        :title="tr('关闭')"
        @click="closeApp"
      >×</button>
      <div ref="brandRef" class="lock-brand" :class="{ 'is-empty': doveAway }">
        <img :src="iconUrl" alt="" draggable="false" />
        <span class="brand-empty" aria-hidden="true"></span>
      </div>
      <p class="lock-entry-label">{{ tr('请输入密码') }}</p>
      <div ref="pinShellRef" class="pin-shell" :class="{ shake, cooling: cooldownRemaining > 0 }">
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
          :disabled="busy || settling || cooldownRemaining > 0"
          :value="pin"
          @beforeinput="onBeforePinInput"
          @input="onPinInput"
          @keydown.enter.prevent="submit"
        />
      </div>

      <p class="lock-error" role="status" aria-live="polite">{{ error }}</p>
    </section>
    <div ref="doveRef" class="lock-dove" aria-hidden="true">
      <span class="dove-body">
        <span class="dove-glow"></span>
        <img :src="doveMarkUrl" class="dove-glyph" alt="" draggable="false" />
      </span>
      <span class="dove-shadow"></span>
    </div>
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
  color: #22365c;
  font-family: 'Microsoft YaHei', system-ui, sans-serif;
  background:
    radial-gradient(ellipse 72% 62% at 6% 90%, rgba(0,190,215,.28), transparent 64%),
    radial-gradient(ellipse 64% 60% at 94% 6%, rgba(132,100,252,.3), transparent 64%),
    linear-gradient(125deg, #e0f7fb 0%, #ecefff 48%, #f5e7ff 100%);
  -webkit-app-region: no-drag;
  user-select: none;
}
.lock-screen::before {
  content: '';
  position: absolute;
  left: 36%;
  top: 27%;
  width: min(430px, 54vw);
  height: min(430px, 54vw);
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(circle at 50% 50%, rgba(255,249,236,.98) 0 38%, rgba(255,245,226,.68) 58%, rgba(255,242,222,.16) 70%, rgba(255,240,219,0) 76%);
  filter: blur(10px);
  pointer-events: none;
  z-index: 0;
}
.lock-beam {
  position: absolute;
  left: -22%;
  top: -4%;
  width: 146%;
  height: min(320px, 38vh);
  transform: rotate(25deg);
  transform-origin: 0 0;
  background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,251,242,.62) 34%, rgba(255,251,242,.24) 58%, rgba(255,255,255,0) 76%);
  filter: blur(26px);
  opacity: .62;
  pointer-events: none;
  z-index: 0;
}
.lock-horizon {
  position: absolute;
  left: 50%;
  bottom: 15%;
  width: min(760px, 88vw);
  height: min(160px, 22vh);
  transform: translateX(-50%);
  background: radial-gradient(ellipse at center, rgba(76,96,155,.1), rgba(76,96,155,.035) 45%, transparent 72%);
  filter: blur(18px);
  opacity: .8;
  pointer-events: none;
  z-index: 0;
}
.lock-screen::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  opacity: .045;
  mix-blend-mode: multiply;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.55'/%3E%3C/svg%3E");
}
.lock-card {
  position: relative;
  z-index: 3;
  box-sizing: border-box;
  width: min(420px, calc(100vw - 40px));
  padding: 30px 32px 22px;
  border: 1px solid rgba(255,255,255,.52);
  border-radius: 28px;
  background: linear-gradient(155deg, rgba(255,255,255,.42), rgba(247,251,255,.24));
  box-shadow:
    0 24px 68px rgba(55,80,150,.12),
    inset 0 1px 0 rgba(255,255,255,.72);
  backdrop-filter: blur(16px) saturate(1.08);
  -webkit-backdrop-filter: blur(16px) saturate(1.08);
  text-align: center;
  animation: lock-card-in 320ms cubic-bezier(.16,1,.3,1);
}
.lock-close {
  position: absolute;
  z-index: 2;
  top: 10px;
  right: 10px;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: #62769c;
  font-size: 21px;
  line-height: 1;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.lock-close:hover { background: #e3ebff; color: #344fa5; }
.lock-close:focus-visible { outline: 2px solid #536ce4; outline-offset: 2px; }
.lock-brand {
  position: relative;
  width: 62px;
  height: 62px;
  margin: 0 auto;
  display: grid;
  place-items: center;
  border-radius: 20px;
  background: linear-gradient(145deg, #fff, #e6ebff);
  box-shadow: 0 10px 26px rgba(86,105,185,.13), inset 0 1px 0 #fff;
  transition: background-color 260ms ease, box-shadow 260ms ease;
}
.lock-brand img {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  object-fit: cover;
  transition: opacity 280ms ease, transform 280ms ease;
}
.brand-empty {
  position: absolute;
  inset: 8px;
  border: 1px dashed rgba(88,104,180,.34);
  border-radius: 50%;
  opacity: 0;
  transform: scale(.82);
  transition: opacity 280ms ease, transform 280ms ease;
}
.lock-brand.is-empty {
  background: rgba(255,255,255,.52);
  box-shadow: inset 0 1px 0 #fff, 0 8px 20px rgba(86,105,185,.08);
}
.lock-brand.is-empty img { opacity: .08; transform: scale(.8); }
.lock-brand.is-empty .brand-empty { opacity: 1; transform: scale(1); }
.lock-entry-label {
  margin: 12px 0 0;
  color: #4c6389;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  letter-spacing: .01em;
}
.pin-shell { position: relative; display: flex; justify-content: center; margin: 72px auto 0; }
.pin-shell::before {
  content: '';
  position: absolute;
  left: -2px;
  right: -2px;
  top: -11px;
  height: 1px;
  pointer-events: none;
  background: linear-gradient(90deg, transparent, rgba(78,98,170,.18) 14%, rgba(78,98,170,.18) 86%, transparent);
}

.pin-slots { display: flex; gap: 10px; }
.pin-slot {
  box-sizing: border-box;
  width: 44px;
  height: 54px;
  display: grid;
  place-items: center;
  border: 1px solid #b2c4eb;
  border-radius: 14px;
  background: rgba(255,255,255,.8);
  box-shadow: inset 0 1px 0 #fff, 0 3px 10px rgba(90,119,185,.05);
  transition: border-color 160ms ease, background-color 160ms ease;
}
.pin-slot.filled { border-color: #8c9ff1; background: #e9eeff; }
.pin-slot.active { border-color: #596fe0; box-shadow: 0 0 0 4px rgba(89,111,224,.12), inset 0 1px 0 #fff; }
.pin-slot i { width: 9px; height: 9px; border-radius: 50%; background: #5363db; box-shadow: 0 1px 3px rgba(63,76,170,.2); }
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
.pin-input:disabled { cursor: wait; }
.pin-shell.shake { animation: lock-shake 380ms cubic-bezier(.36,.07,.19,.97); }
.pin-shell.shake .pin-slot { border-color: #c44f70; }
.lock-error { min-height: 18px; margin: 10px 0 0; color: #b43157; font-size: 12px; }
.lock-dove {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 4;
  width: 42px;
  height: 42px;
  pointer-events: none;
  opacity: 0;
  transform-origin: 50% 50%;
  will-change: transform, opacity;
}
.dove-body { position: absolute; inset: 0; display: block; }
.lock-dove.is-perched .dove-body { animation: dove-hover 2200ms ease-in-out infinite alternate; }
.dove-glow {
  position: absolute;
  inset: -2px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255,255,255,.94) 0 26%, rgba(232,235,255,.42) 52%, transparent 74%);
  filter: blur(3px);
}
.dove-glyph {
  position: absolute;
  inset: 4px;
  width: 34px;
  height: 34px;
  filter: drop-shadow(0 0 1px rgba(255,255,255,.95)) drop-shadow(0 5px 8px rgba(63,76,170,.3));
  transform-origin: 50% 65%;
}
.dove-shadow {
  position: absolute;
  left: 50%;
  bottom: -3px;
  width: 26px;
  height: 5px;
  transform: translateX(-50%);
  border-radius: 50%;
  background: radial-gradient(ellipse, rgba(46,62,125,.22), transparent 72%);
  opacity: 0;
  transition: opacity 180ms ease;
}
.lock-dove.is-perched .dove-shadow { opacity: 1; }
.lock-dove.is-flying .dove-glyph { animation: dove-flap 170ms ease-in-out infinite alternate; }
@media (max-width: 380px) {
  .lock-card { padding-inline: 18px; }
  .pin-slot { width: 36px; height: 48px; }
  .pin-slots { gap: 7px; }
}
@keyframes lock-card-in {
  from { opacity: 0; transform: translateY(12px) scale(.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes lock-shake {
  10%, 90% { transform: translateX(-2px); }
  20%, 80% { transform: translateX(4px); }
  30%, 50%, 70% { transform: translateX(-6px); }
  40%, 60% { transform: translateX(6px); }
}
@keyframes dove-hover {
  from { transform: translateY(0) rotate(-1deg); }
  to { transform: translateY(-4px) rotate(1.5deg); }
}
@keyframes dove-flap {
  from { transform: rotate(-4deg) scaleY(1); }
  to { transform: rotate(4deg) scaleY(.86); }
}
@media (prefers-reduced-motion: reduce) {
  .lock-card,
  .pin-shell.shake {
    animation: none;
  }
  .lock-dove.is-perched .dove-body,
  .lock-dove.is-flying .dove-glyph {
    animation: none;
  }
  .lock-brand,
  .lock-brand img,
  .brand-empty,
  .dove-shadow {
    transition: none;
  }
}
</style>
