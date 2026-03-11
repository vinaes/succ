import { StorageDispatcherBase } from './base.js';
import { logWarn } from '../../fault-logger.js';
import type { MemoryBatchInput } from '../../db/memories.js';
import type {
  ConsolidationRecord,
  HybridMemoryResult,
  MemoryType,
  MemoryBatchResult,
  MemoryRecord,
  MemorySearchResult,
  MemoryStats,
  SourceType,
  WorkingMemoryRecord,
} from '../types.js';

export class MemoriesDispatcherMixin extends StorageDispatcherBase {
  async saveMemory(
    content: string,
    embedding: number[],
    tags: string[] = [],
    source?: string,
    options?: {
      type?: MemoryType;
      deduplicate?: boolean;
      qualityScore?: number;
      qualityFactors?: Record<string, number>;
      validFrom?: string;
      validUntil?: string;
      confidence?: number;
      sourceType?: SourceType;
    }
  ): Promise<{
    id: number;
    created: boolean;
    duplicate?: { id: number; content: string; similarity: number };
  }> {
    const type = options?.type ?? 'observation';
    const deduplicate = options?.deduplicate ?? true;
    const qualityScore = options?.qualityScore;
    const qualityFactors = options?.qualityFactors;
    const validFrom = options?.validFrom;
    const validUntil = options?.validUntil;
    const confidence = options?.confidence ?? 0.5;
    // No default — DB layers default to 'human'. Callers should pass explicitly.
    const sourceType = options?.sourceType;

    // Auto-correction: detect similar (but not duplicate) memories in 0.82-0.92 range
    if (deduplicate) {
      try {
        const correctionCandidate = await this.findSimilarMemory(embedding, 0.82);
        if (correctionCandidate) {
          if (correctionCandidate.similarity >= 0.92) {
            // Exact/near-exact duplicate — skip saving
            this._sessionCounters.memoriesDuplicated++;
            return { id: correctionCandidate.id, created: false, duplicate: correctionCandidate };
          }
          // Similar but different = correction/refinement — increment existing
          await this.incrementCorrectionCount(correctionCandidate.id);
        }
      } catch (error) {
        logWarn('storage', 'Correction candidate detection failed during saveMemory', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let savedId: number;
    let wasDuplicate = false;

    if (this.backend === 'postgresql' && this.postgres) {
      savedId = await this.postgres.saveMemory(
        content,
        embedding,
        tags,
        source,
        type,
        qualityScore,
        qualityFactors,
        validFrom,
        validUntil,
        false, // isGlobal
        confidence,
        sourceType
      );

      // Sync to Qdrant with full payload
      if (this.hasQdrant()) {
        try {
          await this.qdrant!.upsertMemoryWithPayload(savedId, embedding, {
            content,
            tags,
            source,
            type,
            projectId: this.qdrant!.getProjectId(),
            createdAt: new Date().toISOString(),
            validFrom,
            validUntil,
            confidence,
            sourceType,
          });
        } catch (error) {
          this._warnQdrantFailure(`Failed to sync memory vector ${savedId}`, error);
        }
      }
    } else {
      const sqlite = await this.getSqliteFns();
      const result = sqlite.saveMemory(content, embedding, tags, source, {
        type,
        deduplicate: false, // dedup already handled above
        qualityScore:
          qualityScore != null ? { score: qualityScore, factors: qualityFactors ?? {} } : undefined,
        validFrom,
        validUntil,
        confidence,
        sourceType,
      });

      savedId = result.id;
      wasDuplicate = result.isDuplicate;

      // SQLite + Qdrant: sync memory
      if (this.hasQdrant() && !wasDuplicate) {
        try {
          await this.qdrant!.upsertMemoryWithPayload(savedId, embedding, {
            content,
            tags,
            source,
            type,
            projectId: this.qdrant!.getProjectId(),
            createdAt: new Date().toISOString(),
            validFrom,
            validUntil,
            confidence,
            sourceType,
          });
        } catch (error) {
          this._warnQdrantFailure(`Failed to sync memory vector ${savedId}`, error);
        }
      }
    }

    if (!wasDuplicate) {
      this._sessionCounters.memoriesCreated++;
      this._sessionCounters.typesCreated[type] =
        (this._sessionCounters.typesCreated[type] ?? 0) + 1;

      // Auto-detect invariant content and set is_invariant + compute priority_score
      // Hybrid: regex fast path (8 languages) + embedding similarity fallback (any language)
      // Skip observations — they're subagent reports/facts, not rules/constraints.
      // Invariant detection only makes sense for decision/learning/pattern/error types.
      try {
        if (type !== 'observation') {
          const { detectInvariant, detectInvariantWithEmbedding } =
            await import('../../working-memory-pipeline.js');
          const isInvariant =
            detectInvariant(content) || (await detectInvariantWithEmbedding(content, embedding));
          if (isInvariant) {
            await this.setMemoryInvariant(savedId, true);
          }
        }
        await this.recomputePriorityScore(savedId);
      } catch (error) {
        logWarn('storage', 'Invariant detection or priority recompute failed during saveMemory', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      this._sessionCounters.memoriesDuplicated++;
    }

    return {
      id: savedId,
      created: !wasDuplicate,
      duplicate: wasDuplicate ? { id: savedId, content: '', similarity: 1.0 } : undefined,
    };
  }

  async searchMemories(
    queryEmbedding: number[],
    limit: number = 5,
    threshold: number = 0.3,
    tags?: string[],
    since?: Date,
    options?: { includeExpired?: boolean; asOfDate?: Date }
  ): Promise<Array<MemorySearchResult | HybridMemoryResult>> {
    if (this.hasQdrant()) {
      try {
        const results = await this.qdrant!.hybridSearchMemories(
          '',
          queryEmbedding,
          limit,
          threshold,
          {
            projectId: this.qdrant!.getProjectId(),
            tags,
            since,
            asOfDate: options?.asOfDate,
            includeExpired: options?.includeExpired,
          }
        );
        if (results.length > 0) return results;
      } catch (error) {
        this._warnQdrantFailure('searchMemories hybrid failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.searchMemories(queryEmbedding, limit, threshold, tags, since, options);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.searchMemories(queryEmbedding, limit, threshold, tags, since, options);
  }

  async getMemoryById(id: number): Promise<MemoryRecord | null> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getMemoryById(id);
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryById(id);
  }

  async getMemoriesByTag(tag: string, limit: number = 5): Promise<MemoryRecord[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getMemoriesByTag(tag, limit);
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoriesByTag(tag, limit);
  }

  async deleteMemory(id: number): Promise<boolean> {
    // Tier 1 immutability guard: pinned memories cannot be deleted
    await this._guardPinned(id);
    return this._deleteMemoryUnchecked(id);
  }

  /**
   * Force-delete a memory, bypassing the pinned guard.
   * Atomically unpins (if needed) and deletes in one operation,
   * avoiding the race where a crash between unpin and delete
   * leaves the memory permanently unpinned.
   */
  async forceDeleteMemory(id: number): Promise<boolean> {
    return this._deleteMemoryUnchecked(id);
  }

  private async _deleteMemoryUnchecked(id: number): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) {
      const deleted = await this.postgres.deleteMemory(id);
      if (deleted && this.vectorBackend === 'qdrant' && this.qdrant) {
        try {
          await this.qdrant.deleteMemoryVector(id);
        } catch (err) {
          logWarn('storage', `Qdrant vector delete failed for memory ${id}`, {
            error: String(err),
          });
        }
      }
      return deleted;
    }
    const sqlite = await this.getSqliteFns();
    const deleted = sqlite.deleteMemory(id);
    if (deleted && this.vectorBackend === 'qdrant' && this.qdrant) {
      try {
        await this.qdrant.deleteMemoryVector(id);
      } catch (err) {
        logWarn('storage', `Qdrant vector delete failed for memory ${id}`, { error: String(err) });
      }
    }
    return deleted;
  }

  async getRecentMemories(limit: number = 10): Promise<WorkingMemoryRecord[]> {
    // Two-phase fetch: pinned memories + over-fetched recent
    const overfetchLimit = limit * 3;
    let raw: WorkingMemoryRecord[];
    let pinned: WorkingMemoryRecord[];
    if (this.backend === 'postgresql' && this.postgres) {
      [raw, pinned] = await Promise.all([
        this.postgres.getRecentMemories(overfetchLimit),
        this.postgres.getPinnedMemories(),
      ]);
    } else {
      const sqlite = await this.getSqliteFns();
      raw = sqlite.getRecentMemories(overfetchLimit);
      pinned = sqlite.getPinnedMemories();
    }
    // Apply working memory pipeline: pinned first → validity filter → score → rank
    const { applyWorkingMemoryPipeline, applyDiversityFilter } =
      await import('../../working-memory-pipeline.js');
    // Over-request to account for diversity filtering
    const pipelineLimit = Math.min(limit * 2, raw.length + pinned.length);
    const pipeline = applyWorkingMemoryPipeline(raw, pipelineLimit, new Date(), pinned);
    // Diversity filter: remove near-duplicate embeddings
    const diverse = await applyDiversityFilter(pipeline, (ids) =>
      this.getMemoryEmbeddingsByIds(ids)
    );
    return diverse.slice(0, limit);
  }

  async findSimilarMemory(
    embedding: number[],
    threshold?: number
  ): Promise<{ id: number; content: string; similarity: number } | null> {
    const thresh = threshold ?? 0.92;
    if (this.vectorBackend === 'qdrant' && this.qdrant) {
      try {
        const results = await this.qdrant.findSimilarWithContent('memories', embedding, 3, thresh);
        if (results.length > 0 && results[0].similarity >= thresh) {
          return {
            id: results[0].id,
            content: results[0].content,
            similarity: results[0].similarity,
          };
        }
        // v1 schema fallback: IDs only -> PG
        if (results.length === 0 && this.backend === 'postgresql' && this.postgres) {
          const qr = await this.qdrant.searchMemories(embedding, 3, thresh);
          if (qr.length > 0) {
            const pgRows = await this.postgres.getMemoriesByIds(
              qr.map((r) => r.id),
              { excludeInvalidated: false }
            );
            if (pgRows.length > 0) {
              const score = qr.find((r) => r.id === pgRows[0].id)?.similarity ?? 0;
              if (score >= thresh)
                return { id: pgRows[0].id, content: pgRows[0].content, similarity: score };
            }
          }
        }
      } catch (error) {
        this._warnQdrantFailure('findSimilarMemory failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.findSimilarMemory(embedding, threshold);
    const sqlite = await this.getSqliteFns();
    return sqlite.findSimilarMemory(embedding, threshold);
  }

  async saveMemoriesBatch(
    memories: MemoryBatchInput[],
    deduplicateThreshold?: number,
    options?: { autoLink?: boolean; linkThreshold?: number; deduplicate?: boolean }
  ): Promise<MemoryBatchResult> {
    let result: MemoryBatchResult;
    if (this.backend === 'postgresql' && this.postgres) {
      result = await this.postgres.saveMemoriesBatch(memories, deduplicateThreshold, options);
    } else {
      const sqlite = await this.getSqliteFns();
      result = await sqlite.saveMemoriesBatch(memories, deduplicateThreshold, options);
    }

    // Sync newly saved memories to Qdrant
    if (this.hasQdrant() && result?.results?.length > 0) {
      try {
        const saved = result.results.filter(
          (r): r is (typeof result.results)[number] & { id: number } =>
            !r.isDuplicate && r.id != null
        );
        if (saved.length > 0) {
          const items = saved.map((r) => {
            const mem = memories[r.index];
            return {
              id: r.id,
              embedding: mem.embedding,
              meta: {
                content: mem.content,
                tags: mem.tags ?? [],
                source: mem.source,
                type: mem.type,
                projectId: this.qdrant!.getProjectId(),
                createdAt: new Date().toISOString(),
                validFrom: mem.validFrom
                  ? mem.validFrom instanceof Date
                    ? mem.validFrom.toISOString()
                    : mem.validFrom
                  : null,
                validUntil: mem.validUntil
                  ? mem.validUntil instanceof Date
                    ? mem.validUntil.toISOString()
                    : mem.validUntil
                  : null,
                confidence: mem.confidence ?? null,
                sourceType: mem.sourceType ?? null,
              },
            };
          });
          await this.qdrant!.upsertMemoriesBatchWithPayload(items);
        }
      } catch (error) {
        this._warnQdrantFailure(`Failed to sync ${result.saved} batch memories`, error);
      }
    }

    return result;
  }

  async invalidateMemory(memoryId: number, supersededById: number): Promise<boolean> {
    // Tier 1 immutability guard: pinned memories cannot be invalidated
    await this._guardPinned(memoryId);

    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.invalidateMemory(memoryId, supersededById);
    const sqlite = await this.getSqliteFns();
    return sqlite.invalidateMemory(memoryId, supersededById);
  }

  async restoreInvalidatedMemory(memoryId: number): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.restoreInvalidatedMemory(memoryId);
    const sqlite = await this.getSqliteFns();
    return sqlite.restoreInvalidatedMemory(memoryId);
  }

  async getConsolidationHistory(limit?: number): Promise<ConsolidationRecord[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getConsolidationHistory(limit);
    const sqlite = await this.getSqliteFns();
    return sqlite.getConsolidationHistory(limit);
  }

  async getMemoryStats(): Promise<MemoryStats> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getMemoryStats();
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryStats();
  }

  async getMemoryHealth(): Promise<{
    total: number;
    never_accessed: number;
    stale_unused_90d: number;
    avg_age_days: number;
    avg_access: number;
  }> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getMemoryHealth();
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryHealth();
  }

  async deleteMemoriesOlderThan(date: Date): Promise<number> {
    // Collect affected IDs before deletion for Qdrant vector cleanup.
    // Note: TOCTOU gap between ID collection and deletion is acceptable
    // for bulk retention operations — extra Qdrant deletes are no-ops.
    let affectedIds: number[] = [];
    if (this.hasQdrant()) {
      if (this.backend === 'postgresql' && this.postgres) {
        const all = await this.postgres.getAllMemoriesForRetention();
        affectedIds = all.filter((m) => new Date(m.created_at) < date).map((m) => m.id);
      } else {
        const sqlite = await this.getSqliteFns();
        const all = sqlite.getAllMemoriesForRetention();
        affectedIds = all.filter((m) => new Date(m.created_at) < date).map((m) => m.id);
      }
    }

    let deleted: number;
    if (this.backend === 'postgresql' && this.postgres) {
      deleted = await this.postgres.deleteMemoriesOlderThan(date);
    } else {
      const sqlite = await this.getSqliteFns();
      deleted = sqlite.deleteMemoriesOlderThan(date);
    }

    // Clean up Qdrant vectors for deleted memories
    if (deleted > 0 && affectedIds.length > 0 && this.hasQdrant()) {
      try {
        await this.qdrant!.deleteMemoryVectors(affectedIds);
      } catch (err) {
        logWarn('storage', `Qdrant vector cleanup failed for ${affectedIds.length} old memories`, {
          error: String(err),
        });
      }
    }

    return deleted;
  }

  async deleteMemoriesByTag(tag: string): Promise<number> {
    // Collect affected IDs before deletion for Qdrant vector cleanup.
    // Note: TOCTOU gap between ID collection and deletion is acceptable
    // for bulk retention operations — extra Qdrant deletes are no-ops.
    let affectedIds: number[] = [];
    if (this.hasQdrant()) {
      const TAG_FETCH_LIMIT = 100_000;
      const matching = await this.getMemoriesByTag(tag, TAG_FETCH_LIMIT);
      affectedIds = matching.map((m) => m.id);
      if (matching.length >= TAG_FETCH_LIMIT) {
        logWarn(
          'storage',
          `Tag "${tag}" has ${TAG_FETCH_LIMIT}+ memories — Qdrant cleanup may be incomplete`
        );
      }
    }

    let deleted: number;
    if (this.backend === 'postgresql' && this.postgres) {
      deleted = await this.postgres.deleteMemoriesByTag(tag);
    } else {
      const sqlite = await this.getSqliteFns();
      deleted = sqlite.deleteMemoriesByTag(tag);
    }

    // Clean up Qdrant vectors for deleted memories
    if (deleted > 0 && affectedIds.length > 0 && this.hasQdrant()) {
      try {
        await this.qdrant!.deleteMemoryVectors(affectedIds);
      } catch (err) {
        logWarn(
          'storage',
          `Qdrant vector cleanup failed for ${affectedIds.length} tagged memories`,
          {
            error: String(err),
          }
        );
      }
    }

    return deleted;
  }

  async deleteMemoriesByIds(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    // Filter out pinned memories (Tier 1 immutability)
    const safeIds = await this._filterOutPinned(ids);
    if (safeIds.length === 0) return 0;

    let deleted: number;
    if (this.backend === 'postgresql' && this.postgres) {
      deleted = await this.postgres.deleteMemoriesByIds(safeIds);
    } else {
      const sqlite = await this.getSqliteFns();
      deleted = sqlite.deleteMemoriesByIds(safeIds);
    }

    // Clean up Qdrant vectors for deleted memories
    if (deleted > 0 && this.hasQdrant()) {
      try {
        await this.qdrant!.deleteMemoryVectors(safeIds);
      } catch (err) {
        logWarn('storage', `Qdrant vector batch delete failed for ${safeIds.length} memories`, {
          error: String(err),
        });
      }
    }

    return deleted;
  }

  async searchMemoriesAsOf(
    queryEmbedding: number[],
    asOfDate: Date,
    limit?: number,
    threshold?: number
  ): Promise<Array<MemorySearchResult | HybridMemoryResult>> {
    const lim = limit ?? 5;
    const thresh = threshold ?? 0.3;
    if (this.hasQdrant()) {
      try {
        const results = await this.qdrant!.hybridSearchMemories('', queryEmbedding, lim, thresh, {
          createdBefore: asOfDate,
          asOfDate,
          includeExpired: false,
        });
        if (results.length > 0) return results;
      } catch (error) {
        this._warnQdrantFailure('searchMemoriesAsOf failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.searchMemoriesAsOf(queryEmbedding, asOfDate, limit, threshold);
    const sqlite = await this.getSqliteFns();
    return sqlite.searchMemoriesAsOf(queryEmbedding, asOfDate, limit, threshold);
  }

  // ===========================================================================
  // Memory Links
  // ===========================================================================
}
