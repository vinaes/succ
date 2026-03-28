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
    changedBy: AuditChangedBy
  ): Promise<void> {
    try {
      if (this.backend === 'postgresql' && this.postgres) {
        const pool = await (this.postgres as any).getPool();
        await pool.query(
          `INSERT INTO memory_audit (memory_id, event_type, old_content, new_content, changed_by) VALUES ($1, $2, $3, $4, $5)`,
          [memoryId, eventType, oldContent, newContent, changedBy]
        );
      } else {
        const sqlite = await this.getSqliteFns();
        const db = sqlite.getDb();
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

  async getAuditHistory(memoryId: number): Promise<MemoryAuditRecord[]> {
    try {
      if (this.backend === 'postgresql' && this.postgres) {
        const pool = await (this.postgres as any).getPool();
        const result = await pool.query(
          `SELECT id, memory_id, event_type, old_content, new_content, changed_by, created_at FROM memory_audit WHERE memory_id = $1 ORDER BY created_at DESC`,
          [memoryId]
        );
        return result.rows.map((row: any) => ({
          ...row,
          created_at:
            row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        }));
      } else {
        const sqlite = await this.getSqliteFns();
        const db = sqlite.getDb();
        return db
          .prepare(
            `SELECT id, memory_id, event_type, old_content, new_content, changed_by, created_at FROM memory_audit WHERE memory_id = ? ORDER BY created_at DESC`
          )
          .all(memoryId) as MemoryAuditRecord[];
      }
    } catch (error) {
      logWarn('audit', 'Failed to get audit history', { memoryId, error: getErrorMessage(error) });
      return [];
    }
  }

  async pruneAuditTrail(olderThanDays: number = 90): Promise<number> {
    try {
      if (this.backend === 'postgresql' && this.postgres) {
        const pool = await (this.postgres as any).getPool();
        const result = await pool.query(
          `DELETE FROM memory_audit WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
          [olderThanDays]
        );
        return result.rowCount ?? 0;
      } else {
        const sqlite = await this.getSqliteFns();
        const db = sqlite.getDb();
        const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
        return db.prepare(`DELETE FROM memory_audit WHERE created_at < ?`).run(cutoff).changes;
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
