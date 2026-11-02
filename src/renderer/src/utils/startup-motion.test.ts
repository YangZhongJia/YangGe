import { describe, expect, it } from 'vitest'
import {
  PARTICLE_MAX,
  PARTICLE_MIN,
  degradeParticleCount,
  motionMode,
  resolveParticleCount
} from './startup-motion'

describe('启动动效粒子预算', () => {
  it('默认 480 颗粒子，始终落在 300–500 区间', () => {
    expect(resolveParticleCount()).toBe(480)
    for (const dpr of [0, 1, 1.25, 1.5, 2, 2.5, 3, Number.NaN]) {
      const count = resolveParticleCount({ dpr })
      expect(count).toBeGreaterThanOrEqual(PARTICLE_MIN)
      expect(count).toBeLessThanOrEqual(PARTICLE_MAX)
    }
  })

  it('devicePixelRatio 越高粒子越少', () => {
    const counts = [1, 1.25, 1.5, 2, 2.5].map((dpr) => resolveParticleCount({ dpr }))
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1])
  })

  it('首帧偏慢时按帧间隔直接降档', () => {
    const normal = resolveParticleCount({ dpr: 1 })
    const slow = resolveParticleCount({ dpr: 1, frameMs: 40 })
    expect(slow).toBeLessThan(normal)
    expect(slow).toBeGreaterThanOrEqual(PARTICLE_MIN)
  })

  it('运行中降级只降不升，且守住 300 下限', () => {
    expect(degradeParticleCount(480, 16)).toBe(480)
    expect(degradeParticleCount(480, 22)).toBe(480)
    expect(degradeParticleCount(480, 28)).toBe(408)
    expect(degradeParticleCount(480, 40)).toBe(336)
    expect(degradeParticleCount(300, 60)).toBe(300)
    expect(degradeParticleCount(330, Number.NaN)).toBe(330)
    let count = 500
    for (let i = 0; i < 20; i++) {
      const next = degradeParticleCount(count, 60)
      expect(next).toBeLessThanOrEqual(count)
      count = next
    }
    expect(count).toBe(PARTICLE_MIN)
  })

  it('减少动态效果时走静态图标模式', () => {
    expect(motionMode(true)).toBe('static')
    expect(motionMode(false)).toBe('animate')
  })
})
