import { describe, expect, it } from 'vitest'
import { normalizeNudgeStyle } from './protocol'
import {
  buildNudgeFlight,
  nudgeFlightDuration,
  sampleNudgeFlight
} from '../renderer/src/utils/nudge-effect'

describe('nudge interaction payload', () => {
  it('只接受纸飞机与墨弹，未知样式退回普通震动', () => {
    expect(normalizeNudgeStyle('plane')).toBe('plane')
    expect(normalizeNudgeStyle('ink')).toBe('ink')
    expect(normalizeNudgeStyle('bomb')).toBeUndefined()
    expect(normalizeNudgeStyle(undefined)).toBeUndefined()
  })
})

describe('nudge interaction flight', () => {
  it('从起点出发并准确落在目标头像中心', () => {
    const points = buildNudgeFlight({ x: 120, y: 300 }, { x: 900, y: 420 }, 'plane')
    expect(points[0].x).toBeCloseTo(120)
    expect(points[0].y).toBeCloseTo(300)
    const last = points[points.length - 1]
    expect(last.x).toBeCloseTo(900)
    expect(last.y).toBeCloseTo(420)
  })

  it('纸飞机先在空中绕圈，再飞向目标', () => {
    const plane = buildNudgeFlight({ x: 0, y: 300 }, { x: 800, y: 300 }, 'plane')
    const ink = buildNudgeFlight({ x: 0, y: 300 }, { x: 800, y: 300 }, 'ink')
    expect(plane.length).toBeGreaterThan(ink.length)
    // 绕圈阶段先向外再回卷，横向跨度至少接近一个整圈。
    const loopX = plane.slice(0, 36).map((point) => point.x)
    expect(Math.max(...loopX) - Math.min(...loopX)).toBeGreaterThan(40)
    expect(loopX.some((x, index) => index > 0 && x < loopX[index - 1])).toBe(true)
    // 纸飞机绕圈的顶点高于墨弹的抛物线顶点。
    expect(Math.min(...plane.slice(0, 36).map((point) => point.y))).toBeLessThan(
      Math.min(...ink.map((point) => point.y))
    )
    // 旋转角度连续展开，整圈累计超过 300°，不会在 ±180° 处倒转。
    let travel = 0
    for (let i = 1; i < plane.length; i += 1) {
      const delta = Math.abs(plane[i].angle - plane[i - 1].angle)
      expect(delta).toBeLessThanOrEqual(90)
      travel += delta
    }
    expect(travel).toBeGreaterThan(300)
  })

  it('起点贴近顶部时绕圈改到下方，不飞出视口', () => {
    const points = buildNudgeFlight(
      { x: 400, y: 40 },
      { x: 700, y: 400 },
      'plane',
      { width: 800, height: 600 }
    )
    expect(Math.min(...points.map((point) => point.y))).toBeGreaterThanOrEqual(0)
    expect(Math.max(...points.map((point) => point.y))).toBeLessThanOrEqual(600)
  })

  it('采样进度夹紧到 0–1 并在采样点之间插值', () => {
    const points = buildNudgeFlight({ x: 0, y: 0 }, { x: 100, y: 0 }, 'ink')
    expect(sampleNudgeFlight(points, -1)).toEqual(points[0])
    expect(sampleNudgeFlight(points, 2).x).toBeCloseTo(points[points.length - 1].x)
    const middle = sampleNudgeFlight(points, 0.5)
    expect(middle.x).toBeGreaterThan(0)
    expect(middle.x).toBeLessThan(100)
  })

  it('纸飞机留出绕圈时间，墨弹直接落下', () => {
    expect(nudgeFlightDuration('plane')).toBe(1900)
    expect(nudgeFlightDuration('ink')).toBe(780)
  })
})
