import type { NudgeStyle } from '../../../shared/protocol'

export interface NudgePoint {
  x: number
  y: number
}

export interface NudgeFlightPoint extends NudgePoint {
  /** 运动方向（角度，供纸飞机旋转；墨弹忽略） */
  angle: number
}

/** 视口尺寸；用于把绕圈和弧线收在可见区域内。 */
export interface NudgeBounds {
  width: number
  height: number
}

const DEFAULT_BOUNDS: NudgeBounds = { width: 1280, height: 800 }

/** 二次贝塞尔抛物线；控制点向画面上方抬起，形成"扔出去"的弧线。 */
export function buildNudgeFlight(
  from: NudgePoint,
  to: NudgePoint,
  style: NudgeStyle,
  bounds: NudgeBounds = DEFAULT_BOUNDS
): NudgeFlightPoint[] {
  if (style === 'plane') return buildPlaneFlight(from, to, bounds)
  return buildArc(from, to, 0.26, 120, 18, bounds)
}

function buildArc(
  from: NudgePoint,
  to: NudgePoint,
  liftFactor: number,
  maxLift: number,
  samples: number,
  bounds: NudgeBounds = DEFAULT_BOUNDS
): NudgeFlightPoint[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy) || 1
  let nx = -dy / distance
  let ny = dx / distance
  // 取指向画面顶部的那条法线，避免抛物线向下扎。
  if (ny > 0) {
    nx = -nx
    ny = -ny
  }
  const lift = Math.max(40, Math.min(maxLift, distance * liftFactor))
  const control = {
    x: (from.x + to.x) / 2 + nx * lift,
    y: Math.max(30, Math.min(bounds.height - 30, (from.y + to.y) / 2 + ny * lift))
  }

  const points: NudgeFlightPoint[] = []
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples
    const mt = 1 - t
    points.push({
      x: mt * mt * from.x + 2 * mt * t * control.x + t * t * to.x,
      y: mt * mt * from.y + 2 * mt * t * control.y + t * t * to.y,
      angle: tangentAngle(
        2 * mt * (control.x - from.x) + 2 * t * (to.x - control.x),
        2 * mt * (control.y - from.y) + 2 * t * (to.y - control.y)
      )
    })
  }
  return unwrapAngles(points)
}

/** 纸飞机先爬升绕一个整圈，再扑向目标；环绕方向和出手方向一致。 */
function buildPlaneFlight(from: NudgePoint, to: NudgePoint, bounds: NudgeBounds): NudgeFlightPoint[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy) || 1
  const radius = Math.max(20, Math.min(46, distance * 0.11))
  const margin = 28
  const towardX = dx / distance
  // 头像靠近顶部时把整圈改到下方，避免飞出窗口。
  const loopAbove = from.y - radius * 2 >= margin
  const center = {
    x: Math.max(margin + radius, Math.min(bounds.width - margin - radius, from.x + towardX * radius * 0.55)),
    y: loopAbove ? from.y - radius * 1.05 : from.y + radius * 1.05
  }
  const loopStart = { x: center.x, y: loopAbove ? center.y + radius : center.y - radius }
  const clockwise = dx >= 0
  const spin = (clockwise ? -1 : 1) * (loopAbove ? 1 : -1)
  const startAngle = loopAbove ? Math.PI / 2 : -Math.PI / 2

  const points: NudgeFlightPoint[] = []
  const connectorSteps = 3
  for (let i = 0; i < connectorSteps; i += 1) {
    const t = i / connectorSteps
    points.push({
      x: from.x + (loopStart.x - from.x) * t,
      y: from.y + (loopStart.y - from.y) * t,
      angle: tangentAngle(loopStart.x - from.x, loopStart.y - from.y)
    })
  }

  const loopSteps = 30
  for (let i = 0; i <= loopSteps; i += 1) {
    const t = i / loopSteps
    const angle = startAngle + spin * t * Math.PI * 2
    points.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
      angle: tangentAngle(-Math.sin(angle) * spin, Math.cos(angle) * spin)
    })
  }

  // 绕圈回到起点后，再沿抛物线飞向目标。
  const outbound = buildArc(loopStart, to, 0.3, 150, 20, bounds)
  points.push(...outbound.slice(1))
  return unwrapAngles(points)
}

/** 消除 ±180° 回绕，保证旋转沿最短方向连续累积。 */
function unwrapAngles(points: NudgeFlightPoint[]): NudgeFlightPoint[] {
  for (let i = 1; i < points.length; i += 1) {
    while (points[i].angle - points[i - 1].angle > 180) points[i].angle -= 360
    while (points[i].angle - points[i - 1].angle < -180) points[i].angle += 360
  }
  return points
}

function tangentAngle(vx: number, vy: number): number {
  return (Math.atan2(vy, vx) * 180) / Math.PI
}

export function nudgeFlightDuration(style: NudgeStyle): number {
  return style === 'plane' ? 1900 : 780
}

/** 按进度在采样点之间插值；progress 会被夹到 [0,1]。 */
export function sampleNudgeFlight(points: NudgeFlightPoint[], progress: number): NudgeFlightPoint {
  if (points.length === 0) return { x: 0, y: 0, angle: 0 }
  if (points.length === 1) return points[0]
  const clamped = Math.min(1, Math.max(0, progress))
  const scaled = clamped * (points.length - 1)
  const index = Math.min(points.length - 2, Math.floor(scaled))
  const fraction = scaled - index
  const a = points[index]
  const b = points[index + 1]
  return {
    x: a.x + (b.x - a.x) * fraction,
    y: a.y + (b.y - a.y) * fraction,
    angle: a.angle + (b.angle - a.angle) * fraction
  }
}
