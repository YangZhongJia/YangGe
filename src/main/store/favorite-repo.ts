import type DatabaseT from 'better-sqlite3'

export interface FavoriteRow {
  msg_id: string
  conv_id: string
  created_ts: number
}

/** 本机消息收藏：只存消息 ID 与时间，不复制正文，不同步。 */
export class FavoriteRepo {
  private readonly insertStmt: DatabaseT.Statement
  private readonly deleteStmt: DatabaseT.Statement
  private readonly hasStmt: DatabaseT.Statement
  private readonly idsStmt: DatabaseT.Statement
  private readonly listStmt: DatabaseT.Statement

  constructor(db: DatabaseT.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO message_favorites (msg_id, conv_id, created_ts)
      VALUES (?, ?, ?)
      ON CONFLICT(msg_id) DO UPDATE SET created_ts = excluded.created_ts
    `)
    this.deleteStmt = db.prepare('DELETE FROM message_favorites WHERE msg_id = ?')
    this.hasStmt = db.prepare('SELECT 1 FROM message_favorites WHERE msg_id = ?')
    this.idsStmt = db.prepare('SELECT msg_id FROM message_favorites ORDER BY created_ts DESC')
    this.listStmt = db.prepare(
      'SELECT msg_id, conv_id, created_ts FROM message_favorites ORDER BY created_ts DESC LIMIT ?'
    )
  }

  has(msgId: string): boolean {
    return Boolean(this.hasStmt.get(msgId))
  }

  set(msgId: string, convId: string, favorite: boolean, now: number): boolean {
    if (favorite) this.insertStmt.run(msgId, convId, now)
    else this.deleteStmt.run(msgId)
    return favorite
  }

  ids(): string[] {
    return (this.idsStmt.all() as Array<{ msg_id: string }>).map((row) => row.msg_id)
  }

  list(limit = 200): FavoriteRow[] {
    return this.listStmt.all(limit) as FavoriteRow[]
  }
}
