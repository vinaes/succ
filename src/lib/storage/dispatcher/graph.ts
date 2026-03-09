import { StorageDispatcherBase } from './base.js';
import type {
  ConnectedMemory,
  GraphStats,
  GraphStatsAsOf,
  LinkCandidate,
  LinkInfo,
  MemoryWithLinks,
  LinkRelation,
} from '../types.js';

export class GraphDispatcherMixin extends StorageDispatcherBase {
  async createMemoryLink(
    sourceId: number,
    targetId: number,
    relation: LinkRelation = 'related',
    weight: number = 1.0,
    validFrom?: string,
    validUntil?: string,
    metadata?: Record<string, unknown>
  ): Promise<{ id: number; created: boolean }> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.createMemoryLink(
        sourceId,
        targetId,
        relation,
        weight,
        validFrom,
        validUntil,
        metadata
      );
    const sqlite = await this.getSqliteFns();
    return sqlite.createMemoryLink(sourceId, targetId, relation, weight, {
      validFrom,
      validUntil,
      metadata,
    });
  }

  async deleteMemoryLink(
    sourceId: number,
    targetId: number,
    relation?: LinkRelation
  ): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.deleteMemoryLink(sourceId, targetId, relation);
    const sqlite = await this.getSqliteFns();
    return sqlite.deleteMemoryLink(sourceId, targetId, relation);
  }

  async getMemoryLinks(memoryId: number): Promise<LinkInfo> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getMemoryLinks(memoryId);
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryLinks(memoryId);
  }

  async getMemoryWithLinks(
    memoryId: number,
    options?: { asOfDate?: Date; includeExpired?: boolean }
  ): Promise<MemoryWithLinks | null> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getMemoryWithLinks(memoryId, options);
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryWithLinks(memoryId, options);
  }

  async findConnectedMemories(memoryId: number, maxDepth?: number): Promise<ConnectedMemory[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.findConnectedMemories(memoryId, maxDepth);
    const sqlite = await this.getSqliteFns();
    return sqlite.findConnectedMemories(memoryId, maxDepth);
  }

  async findRelatedMemoriesForLinking(
    memoryId: number,
    threshold?: number,
    maxLinks?: number
  ): Promise<LinkCandidate[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.findRelatedMemoriesForLinking(memoryId, threshold, maxLinks);
    const sqlite = await this.getSqliteFns();
    return sqlite.findRelatedMemoriesForLinking(memoryId, threshold, maxLinks);
  }

  async createAutoLinks(memoryId: number, threshold?: number, maxLinks?: number): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.createAutoLinks(memoryId, threshold, maxLinks);
    const sqlite = await this.getSqliteFns();
    return sqlite.createAutoLinks(memoryId, threshold, maxLinks);
  }

  async autoLinkSimilarMemories(threshold?: number, maxLinks?: number): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.autoLinkSimilarMemories(threshold, maxLinks);
    const sqlite = await this.getSqliteFns();
    return sqlite.autoLinkSimilarMemories(threshold, maxLinks);
  }

  async getGraphStats(): Promise<GraphStats> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getGraphStats();
    const sqlite = await this.getSqliteFns();
    return sqlite.getGraphStats();
  }

  async invalidateMemoryLink(
    sourceId: number,
    targetId: number,
    relation?: LinkRelation
  ): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.invalidateMemoryLink(sourceId, targetId, relation);
    const sqlite = await this.getSqliteFns();
    return sqlite.invalidateMemoryLink(sourceId, targetId, relation);
  }

  async getMemoryLinksAsOf(memoryId: number, asOfDate: Date): Promise<LinkInfo> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getMemoryLinksAsOf(memoryId, asOfDate);
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryLinksAsOf(memoryId, asOfDate);
  }

  async findConnectedMemoriesAsOf(
    memoryId: number,
    asOfDate: Date,
    maxDepth?: number
  ): Promise<ConnectedMemory[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.findConnectedMemoriesAsOf(memoryId, asOfDate, maxDepth);
    const sqlite = await this.getSqliteFns();
    return sqlite.findConnectedMemoriesAsOf(memoryId, asOfDate, maxDepth);
  }

  async getGraphStatsAsOf(asOfDate: Date): Promise<GraphStatsAsOf> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getGraphStatsAsOf(asOfDate);
    const sqlite = await this.getSqliteFns();
    return sqlite.getGraphStatsAsOf(asOfDate);
  }

  // ===========================================================================
  // Graph Enrichment
  // ===========================================================================

  async updateMemoryLink(
    linkId: number,
    updates: { relation?: string; weight?: number; llmEnriched?: boolean }
  ): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.updateMemoryLink(linkId, updates);
    }
    const sqlite = await this.getSqliteFns();
    sqlite.updateMemoryLink(linkId, updates);
  }

  async deleteMemoryLinksByIds(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const BATCH_SIZE = 999;
      let totalDeleted = 0;
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map((_, idx) => `$${idx + 1}`).join(',');
        const result = await pool.query(
          `DELETE FROM memory_links WHERE id IN (${placeholders})`,
          batch
        );
        totalDeleted += result.rowCount ?? 0;
      }
      return totalDeleted;
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.deleteMemoryLinksByIds(ids);
  }

  async findIsolatedMemoryIds(): Promise<number[]> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const scopeCond = this.postgres.getProjectId()
        ? 'AND (LOWER(m.project_id) = $1 OR m.project_id IS NULL)'
        : 'AND m.project_id IS NULL';
      const params = this.postgres.getProjectId() ? [this.postgres.getProjectId()] : [];
      const result = await pool.query(
        `SELECT m.id FROM memories m
         WHERE NOT EXISTS (
           SELECT 1 FROM memory_links WHERE source_id = m.id OR target_id = m.id
         ) ${scopeCond}`,
        params
      );
      return result.rows.map((r: { id: number }) => r.id);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.findIsolatedMemoryIds();
  }

  // ===========================================================================
  // File Hashes
  // ===========================================================================

  async deleteMemoryLinksForMemory(memoryId: number): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const result = await pool.query(
        'DELETE FROM memory_links WHERE (source_id = $1 OR target_id = $1) AND LOWER(project_id) = $2',
        [memoryId, this.postgres.getProjectId()]
      );
      return result.rowCount ?? 0;
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const result = db
      .prepare('DELETE FROM memory_links WHERE source_id = ? OR target_id = ?')
      .run(memoryId, memoryId);
    return result.changes;
  }

  // ===========================================================================
  // Bulk Restore (for checkpoint restore)
  // ===========================================================================

  /**
   * Bulk restore memories, links, centrality, and documents from checkpoint data.
   * Used by checkpoint.ts to avoid direct SQLite/PG access.
   */
}
