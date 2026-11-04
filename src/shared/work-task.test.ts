import { describe, expect, it } from 'vitest'
import {
  getWorkTaskDisplayStatus,
  isValidWorkTaskDateRange,
  isWorkTaskDate,
  workTaskListBucket
} from './work-task'

describe('work task date-only validation', () => {
  it('accepts real calendar dates and rejects malformed or impossible ones', () => {
    expect(isWorkTaskDate('2026-11-03')).toBe(true)
    expect(isWorkTaskDate('2028-02-29')).toBe(true)
    expect(isWorkTaskDate('2026-02-29')).toBe(false)
    expect(isWorkTaskDate('2026-02-31')).toBe(false)
    expect(isWorkTaskDate('2026-1-1')).toBe(false)
    expect(isWorkTaskDate('2026-11-03T00:00:00Z')).toBe(false)
    expect(isWorkTaskDate('')).toBe(false)
    expect(isWorkTaskDate(null)).toBe(false)
  })

  it('rejects a due date before the start date only when both exist', () => {
    expect(isValidWorkTaskDateRange('2026-11-01', '2026-11-03')).toBe(true)
    expect(isValidWorkTaskDateRange('2026-11-03', '2026-11-03')).toBe(true)
    expect(isValidWorkTaskDateRange('2026-11-04', '2026-11-03')).toBe(false)
    expect(isValidWorkTaskDateRange(null, '2026-11-03')).toBe(true)
    expect(isValidWorkTaskDateRange('2026-11-03', null)).toBe(true)
    expect(isValidWorkTaskDateRange(null, null)).toBe(true)
  })
})

describe('work task display status', () => {
  it('keeps the stored status on the due day and only becomes overdue after it', () => {
    expect(getWorkTaskDisplayStatus({ status: 'in_progress', dueDate: '2026-11-03' }, '2026-11-03'))
      .toBe('in_progress')
    expect(getWorkTaskDisplayStatus({ status: 'in_progress', dueDate: '2026-11-02' }, '2026-11-03'))
      .toBe('overdue')
    expect(getWorkTaskDisplayStatus({ status: 'not_started', dueDate: '2026-11-02' }, '2026-11-03'))
      .toBe('overdue')
  })

  it('never marks a completed task overdue and clears overdue when the due date moves forward', () => {
    expect(getWorkTaskDisplayStatus({ status: 'completed', dueDate: '2020-01-01' }, '2026-11-03'))
      .toBe('completed')
    expect(getWorkTaskDisplayStatus({ status: 'in_progress', dueDate: '2026-11-10' }, '2026-11-03'))
      .toBe('in_progress')
    expect(getWorkTaskDisplayStatus({ status: 'in_progress', dueDate: null }, '2026-11-03'))
      .toBe('in_progress')
  })
})

describe('work task list buckets', () => {
  it('separates overdue, today, this week, later and no due date', () => {
    const today = '2026-11-03' // Tuesday
    expect(workTaskListBucket({ status: 'in_progress', dueDate: '2026-11-02' }, today)).toBe('overdue')
    expect(workTaskListBucket({ status: 'in_progress', dueDate: '2026-11-03' }, today)).toBe('today')
    expect(workTaskListBucket({ status: 'in_progress', dueDate: '2026-11-05' }, today)).toBe('this_week')
    expect(workTaskListBucket({ status: 'in_progress', dueDate: '2026-11-08' }, today)).toBe('this_week')
    expect(workTaskListBucket({ status: 'in_progress', dueDate: '2026-11-09' }, today)).toBe('later')
    expect(workTaskListBucket({ status: 'in_progress', dueDate: null }, today)).toBe('none')
  })

  it('keeps completed tasks in their own bucket even when the due date has passed', () => {
    expect(workTaskListBucket({ status: 'completed', dueDate: '2020-01-01' }, '2026-11-03'))
      .toBe('completed')
  })

  it('treats Sunday as the end of the week and does not overflow into next week', () => {
    expect(workTaskListBucket({ status: 'not_started', dueDate: '2026-11-08' }, '2026-11-08'))
      .toBe('today')
    expect(workTaskListBucket({ status: 'not_started', dueDate: '2026-11-09' }, '2026-11-08'))
      .toBe('later')
  })
})
