import pLimit from 'p-limit';
import { StorageDispatcherBase } from './base.js';
import { getErrorMessage } from '../../errors.js';
import { logWarn } from '../../fault-logger.js';
import type { MemoryBatchInput } from '../../db/memories.js';
import type {
  AutoMemoryRow,
  AutoMemoryStatsRow,
  ConsolidationRecord,
  HybridMemoryResult,
  MemoryType,
  MemoryBatchResult,
  MemoryRecord,
  MemorySearchResult,
  MemoryStats,
  SourceType,
  WorkingMemoryRecord,
  AuditChangedBy,
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
      sourceContext?: string;
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
    const sourceContext = options?.sourceContext;

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

    // Version detection: classify relationship with similar existing memory
    let versionInfo: {
      parentMemoryId: number;
      rootMemoryId: number;
      version: number;
      relation: 'updates' | 'extends' | 'derives';
    } | null = null;

    if (deduplicate) {
      try {
        const { getConfig } = await import('../../config.js');
        const config = getConfig();
        if (config.auto_memory?.version_detection) {
          // Find the most similar memory in the 0.82-0.92 range for version detection
          const candidate = await this.findSimilarMemory(embedding, 0.85);
          if (candidate && candidate.similarity < 0.92) {
            const { classifyVersionRelation } =
              await import('../../auto-memory/version-classifier.js');
            const classification = await classifyVersionRelation(content, candidate);
            if (classification) {
              // Get existing memory's version info
              const existing = await this.getMemoryById(candidate.id);
              const rootId = existing?.root_memory_id ?? null;

              versionInfo = {
                parentMemoryId: candidate.id,
                rootMemoryId: rootId ?? candidate.id,
                version: (existing?.version ?? 1) + 1,
                relation: classification.relation as 'updates' | 'extends' | 'derives',
              };
            }
          }
        }
      } catch (error) {
        logWarn('storage', 'Version detection failed during saveMemory (continuing without)', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let savedId: number;
    let wasDuplicate = false;

    // Compute forget_after at save time so it's included in the INSERT
    const forgetAfter =
      sourceType === 'auto_extracted'
        ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
        : undefined;

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
        sourceType,
        sourceContext,
        forgetAfter
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
            sourceContext,
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
        sourceContext,
        forgetAfter,
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
            sourceContext,
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

      // Record audit trail for memory creation
      try {
        const changedBy: AuditChangedBy =
          sourceType === 'auto_extracted' ? 'extraction' : source === 'hook' ? 'hook' : 'user';
        await this.recordAuditEvent(savedId, 'create', null, content, changedBy);
      } catch (auditError) {
        logWarn('storage', 'Audit trail recording failed for saveMemory', {
          memoryId: savedId,
          error: getErrorMessage(auditError),
        });
      }

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

      // Create version link if version detection found a relationship
      if (versionInfo) {
        try {
          await this.createMemoryLink(
            savedId,
            versionInfo.parentMemoryId,
            versionInfo.relation,
            versionInfo.version / 10 // weight proportional to version depth
          );
        } catch (error) {
          logWarn('storage', 'Failed to create version link', {
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // If 'updates': mark old memory as not latest AFTER successful save
        // NOTE (v1 known limitation): TOCTOU race between findSimilarMemory and
        // this update — concurrent saves could both mark the same candidate as
        // not-latest and fork the version chain. Acceptable for v1 since the
        // feature is config-gated and the LLM call serializes most concurrent saves.
        if (versionInfo.relation === 'updates') {
          try {
            await this.markMemoryNotLatest(versionInfo.parentMemoryId);
          } catch (err) {
            logWarn('storage', 'Failed to mark old memory as not latest', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
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

  async getMemoriesByTag(
    tag: string,
    limit: number = 5,
    offset: number = 0
  ): Promise<MemoryRecord[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getMemoriesByTag(tag, limit, offset);
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoriesByTag(tag, limit, offset);
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
              const scoreMap = new Map(qr.map((r) => [r.id, r.similarity]));
              const score = scoreMap.get(pgRows[0].id) ?? 0;
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
    // Pre-compute forget_after for auto-extracted memories so it's included in the INSERT
    const enriched = memories.map((mem) => ({
      ...mem,
      forgetAfter:
        mem.sourceType === 'auto_extracted'
          ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
          : (mem.forgetAfter ?? undefined),
    }));

    let result: MemoryBatchResult;
    if (this.backend === 'postgresql' && this.postgres) {
      result = await this.postgres.saveMemoriesBatch(enriched, deduplicateThreshold, options);
    } else {
      const sqlite = await this.getSqliteFns();
      result = await sqlite.saveMemoriesBatch(enriched, deduplicateThreshold, options);
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
                sourceContext: mem.sourceContext ?? null,
              },
            };
          });
          await this.qdrant!.upsertMemoriesBatchWithPayload(items);
        }
      } catch (error) {
        this._warnQdrantFailure(`Failed to sync ${result.saved} batch memories`, error);
      }
    }

    // Record audit trail for batch creates with bounded parallelism (CONCURRENCY=5)
    // to avoid SQLITE_BUSY while not serializing every insert.
    if (result?.results?.length > 0) {
      const saved = result.results.filter(
        (r): r is (typeof result.results)[number] & { id: number } => !r.isDuplicate && r.id != null
      );
      const auditWriteLimit = pLimit(5);
      await Promise.all(
        saved.map((r) =>
          auditWriteLimit(async () => {
            try {
              const mem = memories[r.index];
              const changedBy: AuditChangedBy =
                mem.sourceType === 'auto_extracted'
                  ? 'extraction'
                  : mem.source === 'hook'
                    ? 'hook'
                    : 'user';
              await this.recordAuditEvent(r.id, 'create', null, mem.content, changedBy);
            } catch (auditError) {
              logWarn('storage', 'Audit trail recording failed for saveMemoriesBatch', {
                memoryId: r.id,
                error: getErrorMessage(auditError),
              });
            }
          })
        )
      );
    }

    return result;
  }

  async invalidateMemory(
    memoryId: number,
    supersededById: number,
    changedBy: AuditChangedBy = 'consolidation'
  ): Promise<boolean> {
    // Tier 1 immutability guard: pinned memories cannot be invalidated
    await this._guardPinned(memoryId);

    let oldContent: string | null = null;
    try {
      const memory = await this.getMemoryById(memoryId);
      if (memory) oldContent = memory.content;
    } catch (fetchError) {
      logWarn('storage', 'Failed to fetch memory content for audit before invalidation', {
        memoryId,
        error: getErrorMessage(fetchError),
      });
    }

    let result: boolean;
    if (this.backend === 'postgresql' && this.postgres) {
      result = await this.postgres.invalidateMemory(memoryId, supersededById);
    } else {
      const sqlite = await this.getSqliteFns();
      result = sqlite.invalidateMemory(memoryId, supersededById);
    }

    if (result) {
      try {
        await this.recordAuditEvent(memoryId, 'delete', oldContent, null, changedBy);
      } catch (auditError) {
        logWarn('storage', 'Audit trail recording failed for invalidateMemory', {
          memoryId,
          error: getErrorMessage(auditError),
        });
      }
    }

    return result;
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

  async deleteOldRecallEvents(olderThanDays: number): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.deleteOldRecallEvents(olderThanDays);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.deleteOldRecallEvents(olderThanDays);
  }

  async deleteMemoriesByTag(tag: string): Promise<number> {
    // Collect affected IDs before deletion for Qdrant vector cleanup.
    // Note: TOCTOU gap between ID collection and deletion is acceptable
    // for bulk retention operations — extra Qdrant deletes are no-ops.
    const affectedIds: number[] = [];
    if (this.hasQdrant()) {
      const PAGE_SIZE = 1000;
      let pageOffset = 0;
      let page: MemoryRecord[];
      do {
        page = await this.getMemoriesByTag(tag, PAGE_SIZE, pageOffset);
        affectedIds.push(...page.map((m) => m.id));
        pageOffset += PAGE_SIZE;
      } while (page.length === PAGE_SIZE);
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

  async collectExpiredMemoryIds(): Promise<number[]> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.collectExpiredMemoryIds();
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.collectExpiredMemoryIds();
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

  async promoteMemoryConfidence(memoryId: number): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.promoteMemoryConfidence(memoryId);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.promoteMemoryConfidence(memoryId);
  }

  async degradeMemoryConfidence(memoryId: number, amount: number = 0.05): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.degradeMemoryConfidence(memoryId, amount);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.degradeMemoryConfidence(memoryId, amount);
  }

  async boostMemoryConfidence(memoryId: number, amount: number = 0.02): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.boostMemoryConfidence(memoryId, amount);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.boostMemoryConfidence(memoryId, amount);
  }

  async setForgetAfter(memoryId: number, forgetAfter: string | null): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.setForgetAfter(memoryId, forgetAfter);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.setForgetAfter(memoryId, forgetAfter);
  }

  async setForgetAfterDays(memoryId: number, days: number): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.setForgetAfterDays(memoryId, days);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.setForgetAfterDays(memoryId, days);
  }

  async getAutoExtractedMemories(): Promise<AutoMemoryRow[]> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getAutoExtractedMemories();
    }
    const sqlite = await this.getSqliteFns();
    const rows = sqlite.getAutoExtractedMemories();
    // Convert SQLite Buffer embeddings to number[] for uniform interface
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      embedding: sqlite.bufferToFloatArray(r.embedding),
      access_count: r.access_count,
      confidence: r.confidence,
      created_at: r.created_at,
    }));
  }

  async collectPruneableAutoMemoryIds(maxUnusedDays: number): Promise<number[]> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.collectPruneableAutoMemoryIds(maxUnusedDays);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.collectPruneableAutoMemoryIds(maxUnusedDays);
  }

  async getAutoMemoryStatsRow(): Promise<AutoMemoryStatsRow> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getAutoMemoryStatsRow();
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.getAutoMemoryStatsRow();
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
