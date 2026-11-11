import type { MessageView } from '../../../shared/ipc'

/** 设置里的提示音取值；'none' 表示关闭。 */
export type MessageSoundSetting = 'none' | 'drop' | 'wood' | 'ding'
export type MessageSoundTone = Exclude<MessageSoundSetting, 'none'>

/** 突发消息（群聊连发、批量到达）只响一次，避免叠成噪音。 */
const MIN_PLAY_INTERVAL_MS = 600

let audio: AudioContext | null = null
let lastPlayedAt = 0

/**
 * 新消息是否需要提示音：关闭、自己发的、系统提示与免打扰会话都不响。
 * 声音只代表「有新内容」，与系统通知开关相互独立。
 */
export function resolveMessageSound(input: {
  sound: MessageSoundSetting
  isMine: boolean
  kind: MessageView['kind']
  muted: boolean
}): MessageSoundTone | null {
  if (input.sound === 'none' || input.isMine || input.kind === 'system' || input.muted) return null
  return input.sound
}

function audioContext(): AudioContext | null {
  if (audio) return audio
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext
  if (!Ctor) return null
  try {
    audio = new Ctor()
  } catch {
    return null
  }
  return audio
}

/** 单个衰减正弦音，包络与时长决定音色。 */
function tone(
  ctx: AudioContext,
  start: number,
  type: OscillatorType,
  from: number,
  to: number,
  duration: number,
  peak: number
): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(from, start)
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, start + duration)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}

/** 水滴：快速下滑的高音。 */
function drop(ctx: AudioContext, start: number): void {
  tone(ctx, start, 'sine', 1500, 520, 0.18, 0.16)
  tone(ctx, start, 'sine', 2400, 1800, 0.06, 0.05)
}

/** 木鱼：短促的带通噪声 + 低频木腔。 */
function wood(ctx: AudioContext, start: number): void {
  const duration = 0.1
  const buffer = ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * duration)), ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i += 1) {
    const decay = 1 - i / data.length
    data[i] = (Math.random() * 2 - 1) * decay * decay
  }
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = 1700
  filter.Q.value = 6
  const gain = ctx.createGain()
  gain.gain.value = 0.5
  source.connect(filter)
  filter.connect(gain)
  gain.connect(ctx.destination)
  source.start(start)
  tone(ctx, start, 'sine', 700, 620, 0.07, 0.1)
}

/** 叮咚：两个持续音，尾音更长。 */
function ding(ctx: AudioContext, start: number): void {
  tone(ctx, start, 'sine', 1046.5, 1046.5, 0.5, 0.09)
  tone(ctx, start, 'sine', 1568, 1568, 0.36, 0.05)
}

export function playMessageSound(
  toneName: MessageSoundTone,
  options: { force?: boolean } = {}
): void {
  const ctx = audioContext()
  if (!ctx) return
  const now = performance.now()
  if (!options.force && now - lastPlayedAt < MIN_PLAY_INTERVAL_MS) return
  lastPlayedAt = now
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  const start = ctx.currentTime + 0.01
  if (toneName === 'drop') drop(ctx, start)
  else if (toneName === 'wood') wood(ctx, start)
  else ding(ctx, start)
}
