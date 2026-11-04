import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'

describe('v22 任务记录迁移', () => {
  it('追加在 v21 之后且只建任务记录自有表', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(22)
    const v22 = MIGRATIONS[21]
    for (const table of ['work_task_projects', 'work_tasks', 'work_task_shares']) {
      expect(v22).toContain(`CREATE TABLE ${table}`)
    }
    expect(v22).not.toMatch(/\b(?:agent_tasks|agent_task_steps|agent_task_events)\b/)
    expect(v22).not.toMatch(/\b(?:peers|conversations|messages|groups)\b/)
    expect(v22).not.toMatch(/\bALTER TABLE\b/)
  })

  it('v23 增加本地提醒标记与汇总状态表', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(23)
    const v23 = MIGRATIONS[22]
    expect(v23).toContain('ALTER TABLE work_tasks ADD COLUMN due_reminded_on')
    expect(v23).toContain('CREATE TABLE work_task_reminder_state')
    expect(v23).not.toMatch(/\b(?:messages|groups|peers)\b/)
  })

  it('任务表包含项目、日期、状态、revision 与共享投递字段', () => {
    const v22 = MIGRATIONS[21]
    for (const column of [
      'owner_node_id',
      'project_id',
      'start_date',
      'due_date',
      'status',
      'revision',
      'active'
    ]) {
      expect(v22).toContain(column)
    }
    expect(v22).toContain('delivery_state')
    expect(v22).toContain("'queued'")
  })
})
