import { StorageDispatcherBase } from './base.js';
import type { SqlMemoryRow } from './base.js';
import type { MemoryType } from '../types.js';
import { logWarn } from '../../fault-logger.js';

export class EmbeddingsDispatcherMixin extends StorageDispatcherBase {
  async updateMemoryEmbedding(memoryId: number, embedding: number[]): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.updateMemoryEmbedding(memoryId, embedding);
    }
    const sqlite = await this.getSqliteFns();
    sqlite.updateMemoryEmbedding(memoryId, embedding);
  }

  async updateMemoryEmbeddingsBatch(
    updates: Array<{ id: number; embedding: number[] }>
  ): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.updateMemoryEmbeddingsBatch(updates);
    }
    const sqlite = await this.getSqliteFns();
    for (const { id, embedding } of updates) {
      sqlite.updateMemoryEmbedding(id, embedding);
    }
  }

  async getMemoriesNeedingReembedding(
    limit: number = 100,
    afterId: number = 0
  ): Promise<Array<{ id: number; content: string }>> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getMemoriesNeedingReembedding(limit, afterId);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoriesNeedingReembedding(limit, afterId);
  }

  async getMemoryCount(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getMemoryCount();
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryCount();
  }

  async getMemoryEmbeddingCount(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getMemoryEmbeddingCount();
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryEmbeddingCount();
  }

  async updateMemoryTags(memoryId: number, tags: string[]): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.updateMemoryTags(memoryId, tags);
    }
    const sqlite = await this.getSqliteFns();
    sqlite.updateMemoryTags(memoryId, tags);
  }

  async upsertCentralityScore(
    memoryId: number,
    degree: number,
    normalizedDegree: number
  ): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.upsertCentralityScore(memoryId, degree, normalizedDegree);
    }
    const sqlite = await this.getSqliteFns();
    sqlite.upsertCentralityScore(memoryId, degree, normalizedDegree);
  }

  async getCentralityScores(memoryIds: number[]): Promise<Map<number, number>> {
    if (memoryIds.length === 0) return new Map();
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getCentralityScores(memoryIds);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.getCentralityScores(memoryIds);
  }

  async getAllMemoriesWithEmbeddings(options?: {
    types?: string[];
    excludeInvalidated?: boolean;
  }): Promise<
    Array<{
      id: number;
      content: string;
      tags: string[];
      source: string | null;
      embedding: number[] | null;
      type: MemoryType | null;
      quality_score: number | null;
      created_at: string;
      invalidated_by: number | null;
    }>
  > {
    if (this.backend === 'postgresql' && this.postgres) {
      const rows = await this.postgres.getAllMemoriesWithEmbeddings();
      let result = rows.map((r: any) => ({
        id: r.id,
        content: r.content,
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags ?? []),
        source: r.source ?? null,
        embedding: r.embedding ?? null,
        type: (r.type as MemoryType) ?? null,
        quality_score: r.qualityScore ?? r.quality_score ?? null,
        created_at: r.createdAt ?? r.created_at ?? new Date().toISOString(),
        invalidated_by: r.invalidatedBy ?? r.invalidated_by ?? null,
      }));
      if (options?.excludeInvalidated) result = result.filter((r) => r.invalidated_by == null);
      if (options?.types?.length)
        result = result.filter((r) => r.type != null && options.types!.includes(r.type));
      return result;
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    let sql = `SELECT id, content, tags, source, embedding, type, quality_score, created_at, invalidated_by FROM memories`;
    const conditions: string[] = [];
    if (options?.excludeInvalidated) conditions.push('invalidated_by IS NULL');
    if (options?.types?.length) {
      const placeholders = options.types.map(() => '?').join(', ');
      conditions.push(`type IN (${placeholders})`);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY id ASC';

    const params = options?.types?.length ? options.types : [];
    const rows = db.prepare(sql).all(...params) as SqlMemoryRow[];
    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      tags: row.tags ? JSON.parse(row.tags) : [],
      source: row.source,
      embedding: row.embedding
        ? Array.from(
            new Float32Array(
              row.embedding.buffer,
              row.embedding.byteOffset,
              row.embedding.byteLength / 4
            )
          )
        : null,
      type: (row.type as MemoryType) ?? null,
      quality_score: row.quality_score,
      created_at: row.created_at,
      invalidated_by: row.invalidated_by ?? null,
    }));
  }

  async getMemoryEmbeddingsByIds(ids: number[]): Promise<Map<number, number[]>> {
    if (ids.length === 0) return new Map();

    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await pool.query(
        `SELECT id, embedding::text FROM memories WHERE id IN (${placeholders})`,
        ids
      );
      const map = new Map<number, number[]>();
      for (const row of rows) {
        if (row.embedding) {
          try {
            // pgvector returns embedding as JSON array string "[0.1,0.2,...]"
            const vec = JSON.parse(row.embedding);
            map.set(row.id, vec);
          } catch {
            logWarn('storage', `Failed to parse embedding for memory ${row.id}, skipping`);
          }
        }
      }
      return map;
    }

    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, embedding FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: number; embedding: Buffer | null }>;
    const map = new Map<number, number[]>();
    for (const row of rows) {
      if (row.embedding) {
        map.set(
          row.id,
          Array.from(
            new Float32Array(
              row.embedding.buffer,
              row.embedding.byteOffset,
              row.embedding.byteLength / 4
            )
          )
        );
      }
    }
    return map;
  }
}
