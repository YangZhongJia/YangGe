import type DatabaseT from 'better-sqlite3'

export interface TransferRow {
  transfer_id: string
  msg_id: string
  peer_id: string
  direction: string
  files: string
  status: string
  bytes_done: number
  total: number
  ts: number
  expires_at: number
}

export interface OutgoingFileManifestRow {
  msg_id: string
  files: string
  expires_at: number
}

export class TransferRepo {
  private readonly insertStmt: DatabaseT.Statement
  private readonly statusStmt: DatabaseT.Statement
  private readonly progressStmt: DatabaseT.Statement
  private readonly filesStmt: DatabaseT.Statement
  private readonly clearExpiryStmt: DatabaseT.Statement
  private readonly getStmt: DatabaseT.Statement
  private readonly listStmt: DatabaseT.Statement
  private readonly sharePutStmt: DatabaseT.Statement
  private readonly recoverableStmt: DatabaseT.Statement
  private readonly resetLegacyActiveStmt: DatabaseT.Statement
  private readonly saveManifestStmt: DatabaseT.Statement
  private readonly getManifestStmt: DatabaseT.Statement
  private readonly listManifestsStmt: DatabaseT.Statement
  private readonly deleteManifestStmt: DatabaseT.Statement

  constructor(db: DatabaseT.Database) {
    this.insertStmt = db.prepare(`
      INSERT OR REPLACE INTO transfers
        (transfer_id, msg_id, peer_id, direction, files, status, bytes_done, total, ts, expires_at)
      VALUES
        (@transferId, @msgId, @peerId, @direction, @files, @status, 0, @total, @ts, @expiresAt)
    `)
    this.statusStmt = db.prepare('UPDATE transfers SET status = ? WHERE transfer_id = ?')
    this.progressStmt = db.prepare('UPDATE transfers SET bytes_done = ? WHERE transfer_id = ?')
    this.filesStmt = db.prepare('UPDATE transfers SET files = ? WHERE transfer_id = ?')
    this.clearExpiryStmt = db.prepare('UPDATE transfers SET expires_at = 0 WHERE transfer_id = ?')
    this.getStmt = db.prepare('SELECT * FROM transfers WHERE transfer_id = ?')
    this.listStmt = db.prepare('SELECT * FROM transfers ORDER BY ts DESC LIMIT ?')
    // 「最近有人放进来」（决议 #283）：LIKE 只做粗筛缩小范围，purpose 由调用方解析 JSON 复核，
    // 不为此新增列（files 里已有 purpose，决议 #277）
    this.sharePutStmt = db.prepare(`
      SELECT * FROM transfers
      WHERE direction = 'in' AND status = 'done' AND files LIKE '%"share-put"%'
      ORDER BY ts DESC LIMIT ?
    `)
    this.recoverableStmt = db.prepare(`
      SELECT * FROM transfers
      WHERE expires_at > 0 AND (
        (direction = 'out' AND status IN ('offering', 'accepted', 'failed', 'canceled')) OR
        (direction = 'in' AND status IN ('offering', 'accepted', 'failed', 'canceled'))
      )
      ORDER BY ts ASC
    `)
    // v13 前的活动记录没有截止时间与恢复清单，启动后按旧策略安全收口。
    this.resetLegacyActiveStmt = db.prepare(
      `UPDATE transfers SET status = CASE
        WHEN direction = 'out' AND files LIKE '%"servedAt":%' THEN 'done' ELSE 'failed' END
        WHERE expires_at = 0 AND status IN ('offering', 'accepted')`
    )
    this.saveManifestStmt = db.prepare(`
      INSERT INTO outgoing_file_manifests (msg_id, files, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(msg_id) DO UPDATE SET files = excluded.files, expires_at = excluded.expires_at
    `)
    this.getManifestStmt = db.prepare('SELECT * FROM outgoing_file_manifests WHERE msg_id = ?')
    this.listManifestsStmt = db.prepare('SELECT * FROM outgoing_file_manifests')
    this.deleteManifestStmt = db.prepare('DELETE FROM outgoing_file_manifests WHERE msg_id = ?')
  }

  insert(row: {
    transferId: string
    msgId: string
    peerId: string
    direction: 'in' | 'out'
    files: string
    status: string
    total: number
    ts: number
    expiresAt?: number
  }): void {
    this.insertStmt.run({ ...row, expiresAt: row.expiresAt ?? 0 })
  }

  updateStatus(transferId: string, status: string): void {
    this.statusStmt.run(status, transferId)
  }

  updateProgress(transferId: string, bytesDone: number): void {
    this.progressStmt.run(bytesDone, transferId)
  }

  updateFiles(transferId: string, filesJson: string): void {
    this.filesStmt.run(filesJson, transferId)
  }

  clearExpiry(transferId: string): void {
    this.clearExpiryStmt.run(transferId)
  }

  get(transferId: string): TransferRow | undefined {
    return this.getStmt.get(transferId) as TransferRow | undefined
  }

  list(limit: number): TransferRow[] {
    return this.listStmt.all(limit) as TransferRow[]
  }

  /** 别人上传到我文件柜的已完成记录，新的在前（决议 #283） */
  listSharePutIncoming(limit: number): TransferRow[] {
    return this.sharePutStmt.all(limit) as TransferRow[]
  }

  listRecoverable(): TransferRow[] {
    return this.recoverableStmt.all() as TransferRow[]
  }

  resetLegacyActive(): number {
    return this.resetLegacyActiveStmt.run().changes
  }

  saveOutgoingManifest(msgId: string, filesJson: string, expiresAt: number): void {
    this.saveManifestStmt.run(msgId, filesJson, expiresAt)
  }

  getOutgoingManifest(msgId: string): OutgoingFileManifestRow | undefined {
    return this.getManifestStmt.get(msgId) as OutgoingFileManifestRow | undefined
  }

  listOutgoingManifests(): OutgoingFileManifestRow[] {
    return this.listManifestsStmt.all() as OutgoingFileManifestRow[]
  }

  deleteOutgoingManifest(msgId: string): void {
    this.deleteManifestStmt.run(msgId)
  }
}
