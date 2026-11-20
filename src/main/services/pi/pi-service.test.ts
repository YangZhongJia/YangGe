import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PiService } from './pi-service'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('Pi 服务运行状态', () => {
  it('一次回复结束不会把 Pi 服务标记为未运行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-service-state-'))
    tempDirs.push(dir)
    const emitted: unknown[] = []
    const service = new PiService({
      userDataDir: dir,
      emit: (event) => emitted.push(event)
    })
    const internals = service as unknown as {
      state: { running: boolean } | null
      onEvent: (record: Record<string, unknown>) => void
    }
    internals.state = { running: true }

    internals.onEvent({ type: 'agent_settled', aborted: false })

    expect(internals.state?.running).toBe(true)
    expect(emitted).toContainEqual({ type: 'settled', aborted: false })
    service.dispose()
  })
})
