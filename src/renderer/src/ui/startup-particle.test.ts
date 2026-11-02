import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodePackedTargets, edgeTargets, innerTargets } from '../utils/particle-targets'

const componentSource = readFileSync(new URL('../components/StartupParticle.vue', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')

describe('启动 / 托盘唤起粒子动效', () => {
  it('资源采样点坐标均在 0–1 之间，且轮廓与内部点充足', () => {
    for (const targets of [edgeTargets(), innerTargets()]) {
      expect(targets.length).toBeGreaterThan(1000)
      for (const value of targets) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
    expect(decodePackedTargets('AAA=')).toHaveLength(2)
    expect(() => decodePackedTargets('AA==', 160)).toThrow()
  })

  it('只有动画 stage 才挂 canvas；静态与关闭设置下不创建 canvas', () => {
    const canvasTag = componentSource.match(/<canvas[\s\S]*?<\/canvas>/)?.[0] ?? ''
    expect(canvasTag).toContain("v-if=\"stage === 'playing' || stage === 'leaving'\"")
    expect(componentSource).toContain("motionMode(reducedMotion) === 'static'")
    expect(componentSource).toMatch(/function showStatic\(\): void \{[\s\S]*?stage\.value = 'static'/)
    expect(componentSource).not.toContain('<canvas ref="canvasEl"></canvas>')
    expect(appSource).toContain('v-if="settings && settings.startupMotion"')
    expect(appSource).toContain('settings.value?.startupMotion === false')
  })

  it('overlay 不参与布局、不吃指针事件，播完即释放 canvas 与 rAF', () => {
    expect(componentSource).toContain('position: fixed')
    expect(componentSource).toContain('pointer-events: none')
    expect(componentSource).toContain('cancelAnimationFrame(rafId)')
    expect(componentSource).toContain('canvas.width = 0')
    expect(componentSource).toContain("document.addEventListener('visibilitychange', onVisibility)")
    expect(componentSource).toContain('MOTION_DURATION_MS')
  })

  it('启动只播一次，托盘唤起 / restore 通过窗口事件重播，不挂 focus', () => {
    expect(componentSource).toContain('playedStartup')
    expect(componentSource).toContain("play(reason: MotionReason = 'restore')")
    expect(appSource).toContain('window.pantry.onMainWindowShown')
    expect(appSource).toContain('motion.play(reason)')
    expect(appSource).toContain('motionPending.value')
  })
})
