import type DatabaseT from 'better-sqlite3'
import type {
  AgentAuditView,
  AgentProfileUpdate,
  AgentSessionStatus,
  AgentSessionView,
  AgentSource,
  AgentView
} from '../../shared/ipc'

// ACP Agent 持久化（v17）。只追加本模块使用的表，不碰 peers/messages/groups。

interface AgentRow {
  id: string
  name: string
  display_name: string
  description: string
  instructions: string
  command: string
  args: string
  cwd: string
  version: string
  source: string
  probe_error: string
  enabled: number
  created_ts: number
  last_used_ts: number
  last_probe_ts: number
}

interface SessionRow {
  id: string
  agent_id: string
  agent_name: string | null
  acp_session_id: string | null
  cwd: string
  title: string
  status: string
  created_ts: number
  updated_ts: number
}

interface AuditRow {
  id: string
  run_id: string
  ts: number
  method: string
  tool_call_id: string | null
  option_kind: string | null
  decision: string
  path: string | null
  command: string | null
  detail: string | null
}

const PROMPT_MAX_CHARS = 16_000

function parseArgs(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : []
  } catch {
    return []
  }
}

function parseSource(value: string): AgentSource {
  return value === 'windows-dir' || value === 'manual' ? value : 'path'
}

function parseStatus(value: string): AgentSessionStatus {
  return value === 'starting' || value === 'idle' || value === 'running' ||
    value === 'failed' || value === 'closed'
    ? value
    : 'failed'
}

function toAgentView(row: AgentRow): AgentView {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    instructions: row.instructions,
    command: row.command,
    args: parseArgs(row.args),
    cwd: row.cwd,
    version: row.version,
    source: parseSource(row.source),
    probeError: row.probe_error,
    enabled: row.enabled === 1,
    createdAt: row.created_ts,
    lastUsedAt: row.last_used_ts,
    lastProbeTs: row.last_probe_ts
  }
}

function toSessionView(row: SessionRow): AgentSessionView {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name ?? row.agent_id,
    acpSessionId: row.acp_session_id,
    cwd: row.cwd,
    title: row.title,
    status: parseStatus(row.status),
    createdAt: row.created_ts,
    updatedAt: row.updated_ts
  }
}

export class AgentRepo {
  private readonly selectAgentsStmt: DatabaseT.Statement
  private readonly selectAgentStmt: DatabaseT.Statement
  private readonly upsertAgentStmt: DatabaseT.Statement
  private readonly setEnabledStmt: DatabaseT.Statement
  private readonly updateAgentProfileStmt: DatabaseT.Statement
  private readonly touchAgentStmt: DatabaseT.Statement
  private readonly insertSessionStmt: DatabaseT.Statement
  private readonly updateSessionStmt: DatabaseT.Statement
  private readonly selectSessionStmt: DatabaseT.Statement
  private readonly selectSessionsStmt: DatabaseT.Statement
  private readonly insertRunStmt: DatabaseT.Statement
  private readonly finishRunStmt: DatabaseT.Statement
  private readonly insertAuditStmt: DatabaseT.Statement
  private readonly selectAuditStmt: DatabaseT.Statement

  constructor(db: DatabaseT.Database) {
    this.selectAgentsStmt = db.prepare(
      'SELECT * FROM agent_agents ORDER BY last_used_ts DESC, name COLLATE NOCASE'
    )
    this.selectAgentStmt = db.prepare('SELECT * FROM agent_agents WHERE id = ?')
    this.upsertAgentStmt = db.prepare(`
      INSERT INTO agent_agents (
        id, name, command, args, cwd, version, source, probe_error, env_names,
        enabled, created_ts, last_used_ts, last_probe_ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        command = excluded.command,
        args = excluded.args,
        version = excluded.version,
        source = excluded.source,
        probe_error = excluded.probe_error,
        last_probe_ts = excluded.last_probe_ts
    `)
    this.setEnabledStmt = db.prepare('UPDATE agent_agents SET enabled = ? WHERE id = ?')
    this.updateAgentProfileStmt = db.prepare(`
      UPDATE agent_agents SET
        display_name = ?,
        description = ?,
        instructions = ?,
        enabled = ?
      WHERE id = ?
    `)
    this.touchAgentStmt = db.prepare('UPDATE agent_agents SET last_used_ts = ? WHERE id = ?')
    this.insertSessionStmt = db.prepare(`
      INSERT INTO agent_sessions (
        id, agent_id, acp_session_id, cwd, title, status, created_ts, updated_ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.updateSessionStmt = db.prepare(`
      UPDATE agent_sessions SET
        acp_session_id = COALESCE(?, acp_session_id),
        title = COALESCE(?, title),
        status = COALESCE(?, status),
        updated_ts = ?
      WHERE id = ?
    `)
    this.selectSessionStmt = db.prepare(`
      SELECT s.*, COALESCE(NULLIF(a.display_name, ''), a.name) AS agent_name
      FROM agent_sessions s LEFT JOIN agent_agents a ON a.id = s.agent_id
      WHERE s.id = ?
    `)
    this.selectSessionsStmt = db.prepare(`
      SELECT s.*, COALESCE(NULLIF(a.display_name, ''), a.name) AS agent_name
      FROM agent_sessions s LEFT JOIN agent_agents a ON a.id = s.agent_id
      ORDER BY s.updated_ts DESC
      LIMIT ?
    `)
    this.insertRunStmt = db.prepare(`
      INSERT INTO agent_runs (id, session_id, prompt, stop_reason, started_ts, ended_ts, error)
      VALUES (?, ?, ?, NULL, ?, NULL, NULL)
    `)
    this.finishRunStmt = db.prepare(
      'UPDATE agent_runs SET stop_reason = ?, ended_ts = ?, error = ? WHERE id = ?'
    )
    this.insertAuditStmt = db.prepare(`
      INSERT INTO agent_audit (
        id, run_id, ts, method, tool_call_id, option_kind, decision, path, command, detail
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.selectAuditStmt = db.prepare('SELECT * FROM agent_audit ORDER BY ts DESC LIMIT ?')
  }

  listAgents(): AgentView[] {
    return (this.selectAgentsStmt.all() as AgentRow[]).map(toAgentView)
  }

  getAgent(id: string): AgentView | null {
    const row = this.selectAgentStmt.get(id) as AgentRow | undefined
    return row ? toAgentView(row) : null
  }

  /** 扫描/手动结果落库；保留用户已有的 enabled、cwd、简介、名称与角色提示词。 */
  upsertAgents(agents: AgentView[]): void {
    const transaction = (list: AgentView[]): void => {
      for (const agent of list) {
        this.upsertAgentStmt.run(
          agent.id,
          agent.name,
          agent.command,
          JSON.stringify(agent.args),
          agent.cwd,
          agent.version,
          agent.source,
          agent.probeError,
          agent.enabled ? 1 : 0,
          agent.createdAt,
          agent.lastUsedAt,
          agent.lastProbeTs
        )
      }
    }
    transaction(agents)
  }

  setEnabled(id: string, enabled: boolean): void {
    this.setEnabledStmt.run(enabled ? 1 : 0, id)
  }

  updateAgentProfile(input: AgentProfileUpdate): AgentView | null {
    this.updateAgentProfileStmt.run(
      input.displayName,
      input.description,
      input.instructions,
      input.enabled ? 1 : 0,
      input.id
    )
    return this.getAgent(input.id)
  }

  touchAgent(id: string, ts = Date.now()): void {
    this.touchAgentStmt.run(ts, id)
  }

  createSession(session: AgentSessionView): void {
    this.insertSessionStmt.run(
      session.id,
      session.agentId,
      session.acpSessionId,
      session.cwd,
      session.title,
      session.status,
      session.createdAt,
      session.updatedAt
    )
  }

  updateSession(
    id: string,
    patch: {
      acpSessionId?: string | null
      title?: string | null
      status?: AgentSessionStatus | null
      updatedAt?: number
    }
  ): AgentSessionView | null {
    this.updateSessionStmt.run(
      patch.acpSessionId ?? null,
      patch.title ?? null,
      patch.status ?? null,
      patch.updatedAt ?? Date.now(),
      id
    )
    return this.getSession(id)
  }

  getSession(id: string): AgentSessionView | null {
    const row = this.selectSessionStmt.get(id) as SessionRow | undefined
    return row ? toSessionView(row) : null
  }

  listSessions(limit = 50): AgentSessionView[] {
    const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50
    return (this.selectSessionsStmt.all(safeLimit) as SessionRow[]).map(toSessionView)
  }

  createRun(run: { id: string; sessionId: string; prompt: string; startedAt: number }): void {
    this.insertRunStmt.run(
      run.id,
      run.sessionId,
      run.prompt.slice(0, PROMPT_MAX_CHARS),
      run.startedAt
    )
  }

  finishRun(
    id: string,
    patch: { stopReason: string | null; error: string | null; endedAt?: number }
  ): void {
    this.finishRunStmt.run(patch.stopReason, patch.endedAt ?? Date.now(), patch.error, id)
  }

  addAudit(entry: {
    id: string
    runId: string
    ts: number
    method: string
    toolCallId: string
    optionKind: string
    decision: string
    path: string
    command: string
    detail: string
  }): void {
    this.insertAuditStmt.run(
      entry.id,
      entry.runId,
      entry.ts,
      entry.method,
      entry.toolCallId || null,
      entry.optionKind || null,
      entry.decision,
      entry.path || null,
      entry.command || null,
      entry.detail || null
    )
  }

  listAudit(limit = 100): AgentAuditView[] {
    const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 100
    return (this.selectAuditStmt.all(safeLimit) as AuditRow[]).map((row) => ({
      id: row.id,
      runId: row.run_id,
      ts: row.ts,
      method: row.method,
      toolCallId: row.tool_call_id ?? '',
      optionKind: row.option_kind ?? '',
      decision: row.decision,
      path: row.path ?? '',
      command: row.command ?? '',
      detail: row.detail ?? ''
    }))
  }
}

export type AgentStore = Pick<
  AgentRepo,
  | 'listAgents'
  | 'getAgent'
  | 'upsertAgents'
  | 'setEnabled'
  | 'updateAgentProfile'
  | 'touchAgent'
  | 'createSession'
  | 'updateSession'
  | 'getSession'
  | 'listSessions'
  | 'createRun'
  | 'finishRun'
  | 'addAudit'
  | 'listAudit'
>
