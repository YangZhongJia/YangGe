// 个人/共享任务记录的领域契约与日期派生规则。
// 所有日期都是本地日历日期字符串（YYYY-MM-DD），不转 UTC 时间戳，避免时区把日期挪一天。

export const WORK_TASK_STATUSES = ['not_started', 'in_progress', 'completed'] as const
export type WorkTaskStatus = (typeof WORK_TASK_STATUSES)[number]

/** 「延期」只用于展示，不落库。 */
export type WorkTaskDisplayStatus = WorkTaskStatus | 'overdue'

export const WORK_TASK_ASSIGNMENT_STATES = ['pending', 'accepted', 'declined'] as const
export type WorkTaskAssignmentState = (typeof WORK_TASK_ASSIGNMENT_STATES)[number]

export function isWorkTaskAssignmentState(value: unknown): value is WorkTaskAssignmentState {
  return (WORK_TASK_ASSIGNMENT_STATES as readonly unknown[]).includes(value)
}

/** 任务列表的截止日期分组；已结束任务单独成组，避免过期日期把已完成任务标成延期。 */
export type WorkTaskListBucket =
  | 'overdue'
  | 'today'
  | 'this_week'
  | 'later'
  | 'none'
  | 'completed'

export const WORK_TASK_DELIVERY_STATES = [
  'sent',
  'queued',
  'failed',
  'unsupported',
  'revoked'
] as const
export type WorkTaskDeliveryState = (typeof WORK_TASK_DELIVERY_STATES)[number]

export const WORK_TASK_LIMITS = {
  title: 200,
  projectName: 100,
  /** 说明按 UTF-8 字节计，与 IPC/协议现有文本上限口径一致。 */
  descriptionBytes: 8_000
} as const

export function isWorkTaskStatus(value: unknown): value is WorkTaskStatus {
  return (WORK_TASK_STATUSES as readonly unknown[]).includes(value)
}

export function isWorkTaskDeliveryState(value: unknown): value is WorkTaskDeliveryState {
  return (WORK_TASK_DELIVERY_STATES as readonly unknown[]).includes(value)
}

/** 真实日历日期，格式严格为 YYYY-MM-DD（拒绝 2026-02-31、2026-1-1、带时间后缀）。 */
export function isWorkTaskDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

export function isValidWorkTaskDateRange(
  startDate: string | null | undefined,
  dueDate: string | null | undefined
): boolean {
  if (!startDate || !dueDate) return true
  return dueDate >= startDate
}

export function getWorkTaskDisplayStatus(
  task: { status: WorkTaskStatus; dueDate: string | null },
  todayIso: string
): WorkTaskDisplayStatus {
  if (task.status === 'completed') return 'completed'
  if (task.dueDate && task.dueDate < todayIso) return 'overdue'
  return task.status
}

function parseIsoParts(iso: string): [number, number, number] {
  const [year, month, day] = iso.split('-').map(Number)
  return [year, month, day]
}

function toIsoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate()
  ).padStart(2, '0')}`
}

/** 周一到周日为一周；返回本周日（含当天）。 */
export function endOfWeekIso(todayIso: string): string {
  const [year, month, day] = parseIsoParts(todayIso)
  const date = new Date(Date.UTC(year, month - 1, day))
  const weekday = date.getUTCDay()
  const daysUntilSunday = weekday === 0 ? 0 : 7 - weekday
  date.setUTCDate(date.getUTCDate() + daysUntilSunday)
  return toIsoDate(date)
}

export function workTaskListBucket(
  task: { status: WorkTaskStatus; dueDate: string | null },
  todayIso: string
): WorkTaskListBucket {
  if (task.status === 'completed') return 'completed'
  if (!task.dueDate) return 'none'
  if (task.dueDate < todayIso) return 'overdue'
  if (task.dueDate === todayIso) return 'today'
  return task.dueDate <= endOfWeekIso(todayIso) ? 'this_week' : 'later'
}

/** 当前本地日历日期（YYYY-MM-DD），供主进程与渲染层共用。 */
export function localTodayIso(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}
