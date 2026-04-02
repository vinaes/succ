import { StorageDispatcherBase } from './base.js';
import { logWarn } from '../../fault-logger.js';
import { getErrorMessage } from '../../errors.js';
import type { AuditEventType, AuditChangedBy, MemoryAuditRecord } from '../types.js';

export class AuditDispatcherMixin extends StorageDispatcherBase {
  async recordAuditEvent(
    memoryId: number,
    eventType: AuditEventType,
    oldContent: string | null,
    newContent: string | null,
    changedBy: AuditChangedBy,
    global: boolean = false
  ): Promise<void> {
    try {
      if (this.backend === 'postgresql' && this.postgres) {
        const pool = await this.postgres.getPool();
        // Derive project_id from the memories table to scope audit records by tenant
        await pool.query(
          `INSERT INTO memory_audit (memory_id, event_type, old_content, new_content, changed_by, project_id)
           VALUES ($1, $2, $3, $4, $5, (SELECT project_id FROM memories WHERE id = $1))`,
          [memoryId, eventType, oldContent, newContent, changedBy]
        );
      } else {
        const sqlite = await this.getSqliteFns();
        const db = global ? sqlite.getGlobalDb() : sqlite.getDb();
        db.prepare(
          `INSERT INTO memory_audit (memory_id, event_type, old_content, new_content, changed_by) VALUES (?, ?, ?, ?, ?)`
        ).run(memoryId, eventType, oldContent, newContent, changedBy);
      }
    } catch (error) {
      logWarn('audit', 'Failed to record audit event', {
        memoryId,
        eventType,
        changedBy,
        error: getErrorMessage(error),
      });
    }
  }

  async getAuditHistory(memoryId: number, global: boolean = false): Promise<MemoryAuditRecord[]> {
    try {
      if (this.backend === 'postgresql' && this.postgres) {
        const pool = await this.postgres.getPool();
        // Scope by project_id to prevent cross-tenant audit trail leakage
        const result = await pool.query(
          `SELECT ma.id, ma.memory_id, ma.event_type, ma.old_content, ma.new_content, ma.changed_by, ma.created_at
           FROM memory_audit ma
           JOIN memories m ON m.id = ma.memory_id
           WHERE ma.memory_id = $1 AND ma.project_id = m.project_id
           ORDER BY ma.created_at DESC`,
          [memoryId]
        );
        return result.rows.map((row: any) => ({
          ...row,
          created_at:
            row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        }));
      } else {
        const sqlite = await this.getSqliteFns();
        const db = global ? sqlite.getGlobalDb() : sqlite.getDb();
        const rows = db
          .prepare(
            `SELECT id, memory_id, event_type, old_content, new_content, changed_by, created_at FROM memory_audit WHERE memory_id = ? ORDER BY created_at DESC`
          )
          .all(memoryId) as MemoryAuditRecord[];
        // Normalize SQLite CURRENT_TIMESTAMP (YYYY-MM-DD HH:MM:SS, implicitly UTC)
        // to ISO 8601 strings so both backends share the same created_at contract.
        return rows.map((row) => ({
          ...row,
          created_at: row.created_at?.includes('T')
            ? row.created_at
            : new Date(row.created_at + 'Z').toISOString(),
        }));
      }
    } catch (error) {
      logWarn('audit', 'Failed to get audit history', { memoryId, error: getErrorMessage(error) });
      return [];
    }
  }

  async pruneAuditTrail(olderThanDays: number = 90, global: boolean = false): Promise<number> {
    if (!Number.isFinite(olderThanDays) || !Number.isInteger(olderThanDays) || olderThanDays < 0) {
      logWarn('audit', `Invalid prune window: ${olderThanDays}`);
      return 0;
    }
    try {
      if (this.backend === 'postgresql' && this.postgres) {
        const pool = await this.postgres.getPool();
        // Age-based prune is intentionally cross-project — old audit records are
        // cleaned up uniformly. Per-project filtering uses the project_id column + index.
        const result = await pool.query(
          `DELETE FROM memory_audit WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
          [olderThanDays]
        );
        return result.rowCount ?? 0;
      } else {
        const sqlite = await this.getSqliteFns();
        const db = global ? sqlite.getGlobalDb() : sqlite.getDb();
        // Use datetime() to normalize both sides — created_at is TEXT DEFAULT CURRENT_TIMESTAMP
        // (format: YYYY-MM-DD HH:MM:SS) and plain text < comparison with toISOString() would fail
        // because space (ASCII 32) sorts before T (ASCII 84).
        return db
          .prepare(
            `DELETE FROM memory_audit WHERE datetime(created_at) < datetime('now', '-' || ? || ' days')`
          )
          .run(olderThanDays).changes;
      }
    } catch (error) {
      logWarn('audit', 'Failed to prune audit trail', {
        olderThanDays,
        error: getErrorMessage(error),
      });
      return 0;
    }
  }
}
