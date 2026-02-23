import { StorageDispatcherBase } from './base.js';
import type { SqlLearningDelta } from './base.js';
import type { StorageDispatcher } from './index.js';

export class ExportImportDispatcherMixin extends StorageDispatcherBase {
  async getAllMemoriesForExport(): Promise<
    Array<{
      id: number;
      content: string;
      tags: string[];
      source: string | null;
      embedding: number[] | null;
      type: string | null;
      quality_score: number | null;
      quality_factors: Record<string, number> | null;
      access_count: number;
      last_accessed: string | null;
      created_at: string;
      invalidated_by: number | null;
    }>
  > {
    const { getAllMemoriesForExportImpl } = await import('../dispatcher-export.js');
    return getAllMemoriesForExportImpl(this as unknown as StorageDispatcher);
  }

  async getAllDocumentsForExport(): Promise<
    Array<{
      id: number;
      file_path: string;
      chunk_index: number;
      content: string;
      start_line: number;
      end_line: number;
      embedding: number[] | null;
      created_at: string;
    }>
  > {
    const { getAllDocumentsForExportImpl } = await import('../dispatcher-export.js');
    return getAllDocumentsForExportImpl(this as unknown as StorageDispatcher);
  }

  async getAllMemoryLinksForExport(): Promise<
    Array<{
      id: number;
      source_id: number;
      target_id: number;
      relation: string;
      weight: number;
      created_at: string;
      llm_enriched: boolean;
    }>
  > {
    const { getAllMemoryLinksForExportImpl } = await import('../dispatcher-export.js');
    return getAllMemoryLinksForExportImpl(this as unknown as StorageDispatcher);
  }

  async getAllCentralityForExport(): Promise<
    Array<{
      memory_id: number;
      degree: number;
      normalized_degree: number;
      updated_at: string;
    }>
  > {
    const { getAllCentralityForExportImpl } = await import('../dispatcher-export.js');
    return getAllCentralityForExportImpl(this as unknown as StorageDispatcher);
  }

  // ===========================================================================
  // Learning Deltas
  // ===========================================================================

  async appendLearningDelta(delta: {
    timestamp: string;
    source: string;
    memoriesBefore: number;
    memoriesAfter: number;
    newMemories: number;
    typesAdded: Record<string, number>;
    avgQualityOfNew?: number | null;
  }): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      await pool.query(
        `INSERT INTO learning_deltas (project_id, timestamp, source, memories_before, memories_after, new_memories, types_added, avg_quality)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          this.postgres.getProjectId(),
          delta.timestamp,
          delta.source,
          delta.memoriesBefore,
          delta.memoriesAfter,
          delta.newMemories,
          Object.keys(delta.typesAdded).length > 0 ? JSON.stringify(delta.typesAdded) : null,
          delta.avgQualityOfNew ?? null,
        ]
      );
      return;
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    db.prepare(
      `INSERT INTO learning_deltas (timestamp, source, memories_before, memories_after, new_memories, types_added, avg_quality)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      delta.timestamp,
      delta.source,
      delta.memoriesBefore,
      delta.memoriesAfter,
      delta.newMemories,
      Object.keys(delta.typesAdded).length > 0 ? JSON.stringify(delta.typesAdded) : null,
      delta.avgQualityOfNew ?? null
    );
  }

  async appendRawLearningDelta(text: string): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      await pool.query(
        `INSERT INTO learning_deltas (project_id, timestamp, source, memories_before, memories_after, new_memories)
         VALUES ($1, $2, $3, 0, 0, 0)`,
        [this.postgres.getProjectId(), new Date().toISOString(), text]
      );
      return;
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    db.prepare(
      `INSERT INTO learning_deltas (timestamp, source, memories_before, memories_after, new_memories)
       VALUES (?, ?, 0, 0, 0)`
    ).run(new Date().toISOString(), text);
  }

  async getLearningDeltas(
    options: {
      limit?: number;
      since?: string;
    } = {}
  ): Promise<
    Array<{
      id: number;
      timestamp: string;
      source: string;
      memories_before: number;
      memories_after: number;
      new_memories: number;
      types_added: string | null;
      avg_quality: number | null;
      created_at: string;
    }>
  > {
    const limit = options.limit && options.limit > 0 ? options.limit : 20;

    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const params: any[] = [this.postgres.getProjectId()];
      let sql = `SELECT id, timestamp::text as timestamp, source, memories_before, memories_after,
                        new_memories, types_added, avg_quality, created_at::text as created_at
                 FROM learning_deltas WHERE LOWER(project_id) = $1`;
      if (options.since) {
        params.push(options.since);
        sql += ` AND timestamp >= $${params.length}`;
      }
      params.push(limit);
      sql += ` ORDER BY timestamp DESC LIMIT $${params.length}`;
      const { rows } = await pool.query(sql, params);
      return rows;
    }

    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const params: any[] = [];
    let sql = 'SELECT * FROM learning_deltas';
    if (options.since) {
      sql += ' WHERE timestamp >= ?';
      params.push(options.since);
    }
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params) as SqlLearningDelta[];
  }

  // ===========================================================================
  // AI Readiness Stats
  // ===========================================================================

  async getCodeFileCount(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE LOWER(project_id) = $1 AND file_path LIKE 'code:%'`,
        [this.postgres.getProjectId()]
      );
      return parseInt(rows[0]?.count ?? '0');
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE file_path LIKE 'code:%'`
      )
      .get() as { count: number };
    return row.count;
  }

  async getDocsFileCount(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE LOWER(project_id) = $1 AND file_path NOT LIKE 'code:%'`,
        [this.postgres.getProjectId()]
      );
      return parseInt(rows[0]?.count ?? '0');
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE file_path NOT LIKE 'code:%'`
      )
      .get() as { count: number };
    return row.count;
  }

  async getAverageMemoryQuality(): Promise<{ avg: number | null; count: number }> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const { rows } = await pool.query(
        `SELECT AVG(quality_score) as avg, COUNT(*) as count FROM memories WHERE LOWER(project_id) = $1 AND quality_score IS NOT NULL`,
        [this.postgres.getProjectId()]
      );
      return {
        avg: rows[0]?.avg ? parseFloat(rows[0].avg) : null,
        count: parseInt(rows[0]?.count ?? '0'),
      };
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const row = db
      .prepare(
        `SELECT AVG(quality_score) as avg, COUNT(*) as count FROM memories WHERE quality_score IS NOT NULL`
      )
      .get() as { avg: number | null; count: number };
    return { avg: row.avg, count: row.count };
  }

  // ===========================================================================
  // Filtered Memory Export (for agents-md-generator)
  // ===========================================================================

  async getMemoriesForAgentsExport(options: {
    types: string[];
    minQuality: number;
    limit: number;
  }): Promise<
    Array<{
      id: number;
      content: string;
      type: string | null;
      tags: string[];
      source: string | null;
      quality_score: number | null;
      created_at: string;
    }>
  > {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const typePlaceholders = options.types.map((_, i) => `$${i + 2}`).join(', ');
      const { rows } = await pool.query(
        `SELECT id, content, type, tags, source, quality_score, created_at::text as created_at
         FROM memories
         WHERE LOWER(project_id) = $1
           AND invalidated_by IS NULL
           AND type IN (${typePlaceholders})
           AND (quality_score IS NULL OR quality_score >= $${options.types.length + 2})
         ORDER BY
           CASE type
             WHEN 'dead_end' THEN 0 WHEN 'decision' THEN 1
             WHEN 'pattern' THEN 2 WHEN 'learning' THEN 3 ELSE 4
           END,
           quality_score DESC NULLS LAST
         LIMIT $${options.types.length + 3}`,
        [this.postgres.getProjectId(), ...options.types, options.minQuality, options.limit]
      );
      return rows.map((r: any) => ({
        ...r,
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags ?? []),
      }));
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const typePlaceholders = options.types.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT id, content, type, tags, source, quality_score, created_at
       FROM memories
       WHERE invalidated_by IS NULL
         AND type IN (${typePlaceholders})
         AND (quality_score IS NULL OR quality_score >= ?)
       ORDER BY
         CASE type
           WHEN 'dead_end' THEN 0 WHEN 'decision' THEN 1
           WHEN 'pattern' THEN 2 WHEN 'learning' THEN 3 ELSE 4
         END,
         quality_score DESC
       LIMIT ?`
      )
      .all(...options.types, options.minQuality, options.limit) as Array<{
      id: number;
      content: string;
      type: string | null;
      tags: string | null;
      source: string | null;
      quality_score: number | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      ...r,
      tags: r.tags ? JSON.parse(r.tags) : [],
    }));
  }

  // ===========================================================================
  // Consolidation Helpers
  // ===========================================================================

  async bulkRestore(data: {
    memories: Array<{
      id: number;
      content: string;
      tags: string[];
      source: string | null;
      embedding: number[] | null;
      type: string | null;
      quality_score: number | null;
      quality_factors: Record<string, number> | null;
      access_count: number;
      last_accessed: string | null;
      created_at: string;
    }>;
    memoryLinks: Array<{
      source_id: number;
      target_id: number;
      relation: string;
      weight: number;
      created_at: string;
      llm_enriched?: boolean;
    }>;
    centrality: Array<{
      memory_id: number;
      degree: number;
      normalized_degree: number;
      updated_at: string;
    }>;
    documents: Array<{
      file_path: string;
      chunk_index: number;
      content: string;
      start_line: number;
      end_line: number;
      embedding: number[] | null;
      created_at: string;
    }>;
    overwrite: boolean;
    restoreDocuments: boolean;
  }): Promise<{
    memoriesRestored: number;
    linksRestored: number;
    documentsRestored: number;
    memoryIdMap: Map<number, number>;
  }> {
    const { bulkRestoreImpl } = await import('../dispatcher-export.js');
    return bulkRestoreImpl(this as unknown as StorageDispatcher, data);
  }

  // ===========================================================================
  // Backend Info
  // ===========================================================================

  async backfillQdrant(
    target: 'memories' | 'global_memories' | 'documents' | 'all' = 'all',
    options?: { onProgress?: (msg: string) => void; dryRun?: boolean }
  ): Promise<{ memories: number; globalMemories: number; documents: number }> {
    const { backfillQdrantImpl } = await import('../dispatcher-export.js');
    return backfillQdrantImpl(this as unknown as StorageDispatcher, target, options);
  }
}
