/** 启动 / 托盘唤起粒子动效的预算与时间轴（纯函数，便于单测）。 */

export const PARTICLE_MIN = 300
export const PARTICLE_MAX = 500
export const PARTICLE_BASE = 480

/** 总时长 800ms：收拢 → 图标淡入 → 散开淡出。 */
export const MOTION_DURATION_MS = 800
export const CONVERGE_MS = 470
export const ICON_IN_MS = 540
export const ICON_FULL_MS = 650
export const DISPERSE_AT_MS = 650
/** 动画结束后 overlay 的淡出时长（CSS 过渡同步）。 */
export const OVERLAY_FADE_MS = 160
/** 减少动态效果时静态图标的停留时长。 */
export const STATIC_HOLD_MS = 650

export interface ParticleBudgetInput {
  /** window.devicePixelRatio；缺省按 1 处理 */
  dpr?: number
  /** 最近一帧间隔（ms）；缺省表示尚未测得，不降级 */
  frameMs?: number | null
}

function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.round(value)
  if (!Number.isFinite(rounded)) return min
  return Math.min(max, Math.max(min, rounded))
}

/**
 * 首帧预算：高 DPI 窗口像素更多，先按 dpr 收敛粒子数；若首帧已经偏慢，
 * 再按帧间隔降一档。结果始终落在 [300, 500]。
 */
export function resolveParticleCount(input: ParticleBudgetInput = {}): number {
  const dpr = Number.isFinite(input.dpr) && (input.dpr as number) > 0 ? (input.dpr as number) : 1
  let count: number
  if (dpr >= 2.5) count = 340
  else if (dpr >= 2) count = 380
  else if (dpr >= 1.5) count = 420
  else if (dpr >= 1.25) count = 450
  else count = PARTICLE_BASE
  const frameMs = input.frameMs
  if (typeof frameMs === 'number' && Number.isFinite(frameMs) && frameMs > 0) {
    count = degradeParticleCount(count, frameMs)
  }
  return clampInt(count, PARTICLE_MIN, PARTICLE_MAX)
}

/**
 * 运行中降级：只允许向下调，且不突破 300 下限。帧间隔 ≤22ms（约 45fps）时不降。
 * 采样窗口里的平均值再传入，避免单帧抖动误伤。
 */
export function degradeParticleCount(current: number, frameMs: number): number {
  const safe = clampInt(current, PARTICLE_MIN, PARTICLE_MAX)
  if (!Number.isFinite(frameMs) || frameMs <= 22) return safe
  const factor = frameMs >= 34 ? 0.7 : 0.85
  return Math.max(PARTICLE_MIN, Math.min(safe, Math.round(safe * factor)))
}

/** 系统开启「减少动态效果」时只显示静态图标，不创建 canvas。 */
export function motionMode(reducedMotion: boolean): 'static' | 'animate' {
  return reducedMotion ? 'static' : 'animate'
}
