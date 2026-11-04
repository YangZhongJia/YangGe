import { describe, expect, it } from 'vitest'
import type { WorkTaskReminderCandidate } from '../store/work-task-repo'
import {
  summarizeTaskReminders,
  WorkTaskReminderService,
  type WorkTaskReminderStorePort
} from './work-task-reminders'

function candidate(overrides: Partial<WorkTaskReminderCandidate> = {}): WorkTaskReminderCandidate {
  return {
    id: 'task-1',
    ownerNodeId: 'node-self',
    title: '回归测试',
    dueDate: '2026-11-03',
    status: 'in_progress',
    dueRemindedOn: null,
    ...overrides
  }
}

class FakeStore implements WorkTaskReminderStorePort {
  candidates: WorkTaskReminderCandidate[]
  readonly state = new Map<string, string>()
  readonly marked: Array<{ entries: Array<{ ownerNodeId: string; id: string }>; date: string }> = []

  constructor(candidates: WorkTaskReminderCandidate[]) {
    this.candidates = candidates
  }

  listReminderCandidates(): WorkTaskReminderCandidate[] {
    return this.candidates.map((item) => ({ ...item }))
  }

  markDueReminded(
    entries: Array<{ ownerNodeId: string; id: string }>,
    date: string
  ): void {
    this.marked.push({ entries, date })
    const keys = new Set(entries.map((entry) => entry.ownerNodeId + '|' + entry.id))
    this.candidates = this.candidates.map((item) =>
      keys.has(item.ownerNodeId + '|' + item.id) ? { ...item, dueRemindedOn: date } : item
    )
  }

  getReminderState(key: string): string | null {
    return this.state.get(key) ?? null
  }

  setReminderState(key: string, value: string): void {
    this.state.set(key, value)
  }
}

function harness(initial: WorkTaskReminderCandidate[], nowIso: string, enabled = true) {
  let nowMs = new Date(nowIso).getTime()
  const store = new FakeStore(initial)
  const notifications: Array<{ title: string; body: string }> = []
  const badges: Array<{ dueToday: number; overdue: number }> = []
  const service = new WorkTaskReminderService({
    store,
    isEnabled: () => enabled,
    notify: (input) => notifications.push(input),
    emitBadge: (badge) => badges.push(badge),
    now: () => nowMs
  })
  return {
    store,
    service,
    notifications,
    badges,
    setNow: (value: string) => {
      nowMs = new Date(value).getTime()
    }
  }
}

describe('summarizeTaskReminders', () => {
  it('按今天/逾期分组并排除已完成任务', () => {
    const summary = summarizeTaskReminders(
      [
        candidate({ id: 'due', title: '今天到期' }),
        candidate({ id: 'late', title: '昨天到期', dueDate: '2026-11-02' }),
        candidate({ id: 'done', title: '已完成', status: 'completed' }),
        candidate({ id: 'future', title: '以后', dueDate: '2026-11-09' })
      ],
      '2026-11-03'
    )
    expect(summary.dueToday.map((item) => item.id)).toEqual(['due'])
    expect(summary.overdue.map((item) => item.id)).toEqual(['late'])
    expect(summary.badge).toEqual({ dueToday: 1, overdue: 1 })
  })
})

describe('WorkTaskReminderService', () => {
  it('截止日 09:00 前只更新角标，09:00 后聚合提醒一次', () => {
    const before = harness([candidate()], '2026-11-03T08:59:00')
    before.service.tick()
    expect(before.notifications).toHaveLength(0)
    expect(before.badges.at(-1)).toEqual({ dueToday: 1, overdue: 0 })

    const after = harness([candidate()], '2026-11-03T09:00:00')
    after.service.tick()
    expect(after.notifications).toHaveLength(1)
    expect(after.notifications[0].body).toContain('回归测试')
    expect(after.notifications[0].body).toContain('今天到期')
    expect(after.store.marked).toEqual([
      { entries: [{ ownerNodeId: 'node-self', id: 'task-1' }], date: '2026-11-03' }
    ])
    after.service.tick()
    expect(after.notifications).toHaveLength(1)
  })

  it('逾期汇总每天只弹一次，跨天后再次提醒', () => {
    const harnessed = harness([candidate({ dueDate: '2026-11-02' })], '2026-11-03T08:00:00')
    harnessed.service.tick()
    expect(harnessed.notifications).toHaveLength(1)
    expect(harnessed.notifications[0].body).toContain('已逾期')
    harnessed.service.tick()
    expect(harnessed.notifications).toHaveLength(1)

    harnessed.setNow('2026-11-04T08:00:00')
    harnessed.service.tick()
    expect(harnessed.notifications).toHaveLength(2)
  })

  it('到期与逾期在同一次 tick 合并为一条通知', () => {
    const harnessed = harness(
      [
        candidate({ id: 'due', title: '今天到期' }),
        candidate({ id: 'late', title: '逾期任务', dueDate: '2026-11-02' })
      ],
      '2026-11-03T10:00:00'
    )
    harnessed.service.tick()
    expect(harnessed.notifications).toHaveLength(1)
    expect(harnessed.notifications[0].body).toContain('今天到期')
    expect(harnessed.notifications[0].body).toContain('已逾期')
    expect(harnessed.store.marked).toHaveLength(1)
    expect(harnessed.store.getReminderState('overdue-digest')).toBe('2026-11-03')
  })

  it('关闭系统通知时只发角标，不发通知', () => {
    const harnessed = harness([candidate()], '2026-11-03T10:00:00', false)
    harnessed.service.tick()
    expect(harnessed.notifications).toHaveLength(0)
    expect(harnessed.badges.at(-1)).toEqual({ dueToday: 1, overdue: 0 })
  })

  it('任务变化立即刷新角标；截止日变化后当天可再次提醒', () => {
    const harnessed = harness([candidate({ dueRemindedOn: '2026-11-03' })], '2026-11-03T10:00:00')
    harnessed.service.handleTaskChange()
    expect(harnessed.badges.at(-1)).toEqual({ dueToday: 1, overdue: 0 })
    expect(harnessed.notifications).toHaveLength(0)

    harnessed.store.candidates = [candidate({ dueRemindedOn: null })]
    harnessed.service.handleTaskChange()
    expect(harnessed.notifications).toHaveLength(1)
  })
})
