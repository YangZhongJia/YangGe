import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from '../../store/migrations'

describe('v17 Agent 迁移', () => {
  it('追加在 v16 之后且只建 Agent 自有表', () => {
    expect(MIGRATIONS).toHaveLength(17)
    const v17 = MIGRATIONS[16]
    for (const table of ['agent_agents', 'agent_sessions', 'agent_runs', 'agent_audit']) {
      expect(v17).toContain(`CREATE TABLE ${table}`)
    }
    expect(v17).not.toMatch(/\b(?:peers|conversations|messages|groups)\b/)
    expect(v17).not.toMatch(/ALTER TABLE/)
  })

  it('保留 v16 群简介/公告迁移', () => {
    expect(MIGRATIONS[15]).toContain('ALTER TABLE groups ADD COLUMN description')
    expect(MIGRATIONS[15]).toContain('ALTER TABLE groups ADD COLUMN announce')
  })
})
