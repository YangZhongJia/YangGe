import { tr } from '../../i18n'
import { localTodayIso } from '../../shared/work-task'
import type { WorkTaskReminderCandidate } from '../store/work-task-repo'

const DUE_REMINDER_MINUTES = 9 * 60
const OVERDUE_DIGEST_KEY = 'overdue-digest'
const DEFAULT_INTERVAL_MS = 60_000
const MAX_TITLES = 3

export interface TaskReminderBadge {
  dueToday: number
  overdue: number
}

export interface TaskReminderSummary {
  dueToday: WorkTaskReminderCandidate[]
  overdue: WorkTaskReminderCandidate[]
  badge: TaskReminderBadge
}

/** 纯函数：提醒分组只依赖本地日期；已完成任务永远不参与提醒。 */
export function summarizeTaskReminders(
  tasks: WorkTaskReminderCandidate[],
  todayIso: string
): TaskReminderSummary {
  const dueToday: WorkTaskReminderCandidate[] = []
  const overdue: WorkTaskReminderCandidate[] = []
  for (const task of tasks) {
    if (task.status === 'completed' || !task.dueDate) continue
    if (task.dueDate === todayIso) dueToday.push(task)
    else if (task.dueDate < todayIso) overdue.push(task)
  }
  return {
    dueToday,
    overdue,
    badge: { dueToday: dueToday.length, overdue: overdue.length }
  }
}

export function isTaskReminderTime(now: Date): boolean {
  return now.getHours() * 60 + now.getMinutes() >= DUE_REMINDER_MINUTES
}

export interface WorkTaskReminderStorePort {
  listReminderCandidates(): WorkTaskReminderCandidate[]
  markDueReminded(
    entries: Array<{ ownerNodeId: string; id: string }>,
    date: string,
    updatedAt: number
  ): void
  getReminderState(key: string): string | null
  setReminderState(key: string, value: string, updatedAt: number): void
}

export interface WorkTaskReminderOptions {
  store: WorkTaskReminderStorePort
  /** 系统通知总开关；关闭时仍更新角标。 */
  isEnabled: () => boolean
  notify: (input: { title: string; body: string; onClick?: () => void }) => void
  emitBadge: (badge: TaskReminderBadge) => void
  now?: () => number
  intervalMs?: number
}

function titleList(tasks: WorkTaskReminderCandidate[]): string {
  const names = tasks.slice(0, MAX_TITLES).map((task) => task.title)
  const suffix =
    tasks.length > MAX_TITLES ? tr(' 等 {0} 个', { 0: tasks.length }) : ''
  return names.join(tr('、')) + suffix
}

export class WorkTaskReminderService {
  private readonly store: WorkTaskReminderStorePort
  private readonly isEnabled: () => boolean
  private readonly notify: WorkTaskReminderOptions['notify']
  private readonly emitBadge: WorkTaskReminderOptions['emitBadge']
  private readonly now: () => number
  private readonly intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private lastBadge: TaskReminderBadge = { dueToday: 0, overdue: 0 }

  constructor(options: WorkTaskReminderOptions) {
    this.store = options.store
    this.isEnabled = options.isEnabled
    this.notify = options.notify
    this.emitBadge = options.emitBadge
    this.now = options.now ?? Date.now
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  }

  start(): void {
    if (this.timer) return
    this.tick()
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** 任务增删改或收到共享更新后立即刷新角标，并在需要时补发当天提醒。 */
  handleTaskChange(): void {
    this.tick()
  }

  getBadge(): TaskReminderBadge {
    return { ...this.lastBadge }
  }

  tick(): void {
    const nowMs = this.now()
    const now = new Date(nowMs)
    const today = localTodayIso(now)
    const summary = summarizeTaskReminders(this.store.listReminderCandidates(), today)
    this.lastBadge = summary.badge
    this.emitBadge(summary.badge)
    if (!this.isEnabled()) return

    const due =
      isTaskReminderTime(now) && summary.dueToday.length > 0
        ? summary.dueToday.filter((task) => task.dueRemindedOn !== today)
        : []
    const overdue =
      summary.overdue.length > 0 && this.store.getReminderState(OVERDUE_DIGEST_KEY) !== today
        ? summary.overdue
        : []
    if (due.length === 0 && overdue.length === 0) return

    const lines: string[] = []
    if (due.length > 0) lines.push(tr('今天到期：{0}', { 0: titleList(due) }))
    if (overdue.length > 0) lines.push(tr('已逾期：{0}', { 0: titleList(overdue) }))
    this.notify({ title: tr('任务提醒'), body: lines.join('\n') })

    if (due.length > 0) {
      this.store.markDueReminded(
        due.map((task) => ({ ownerNodeId: task.ownerNodeId, id: task.id })),
        today,
        nowMs
      )
    }
    if (overdue.length > 0) {
      this.store.setReminderState(OVERDUE_DIGEST_KEY, today, nowMs)
    }
  }
}
