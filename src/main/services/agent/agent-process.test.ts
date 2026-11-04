import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from './agent-process'

describe('Agent 扫描并发上限', () => {
  it('按输入顺序返回结果', async () => {
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => item * 10)
    expect(result).toEqual([10, 20, 30, 40, 50])
  })

  // 用微任务让出代替真实计时：runner 同步启动、worker 在若干次微任务后结束，
  // 同时在跑的任务数完全由调度决定，不依赖机器快慢。
  const measurePeak = async (items: number[], limit: number): Promise<number> => {
    let running = 0
    let peak = 0
    await mapWithConcurrency(items, limit, async () => {
      running += 1
      peak = Math.max(peak, running)
      for (let i = 0; i < 4; i += 1) await Promise.resolve()
      running -= 1
    })
    return peak
  }

  it('同时运行的任务数不超过上限', async () => {
    expect(await measurePeak([0, 1, 2, 3, 4, 5, 6], 3)).toBe(3)
  })

  it('空列表不启动任何任务', async () => {
    let calls = 0
    expect(await mapWithConcurrency([], 2, async () => { calls += 1 })).toEqual([])
    expect(calls).toBe(0)
  })

  it('非法上限被收敛为 1', async () => {
    expect(await measurePeak([0, 1, 2], 0)).toBe(1)
  })

  it('worker 抛错时整体 reject', async () => {
    await expect(
      mapWithConcurrency([0, 1, 2], 2, async (item) => {
        if (item === 1) throw new Error('boom')
      })
    ).rejects.toThrow('boom')
  })
})
