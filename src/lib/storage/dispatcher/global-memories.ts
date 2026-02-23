import { StorageDispatcherBase } from './base.js';
import { logWarn } from '../../fault-logger.js';
import type {
  GlobalMemory,
  GlobalMemorySearchResult,
  GlobalMemoryStats,
  HybridGlobalMemoryResult,
  MemoryType,
  MemoryRecord,
  MemorySearchResult,
} from '../types.js';

export class GlobalMemoriesDispatcherMixin extends StorageDispatcherBase {
  async saveGlobalMemory(
    content: string,
    embedding: number[],
    tags: string[] = [],
    source?: string,
    options?: {
      type?: MemoryType;
      deduplicate?: boolean;
      qualityScore?: number;
      qualityFactors?: Record<string, number>;
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

    if (this.backend === 'postgresql' && this.postgres) {
      if (deduplicate) {
        const similar = await this.findSimilarGlobalMemory(embedding, 0.95);
        if (similar) {
          this._sessionCounters.memoriesDuplicated++;
          return { id: similar.id, created: false, duplicate: similar };
        }
      }
      const id = await this.postgres.saveGlobalMemory(
        content,
        embedding,
        tags,
        source,
        type,
        qualityScore,
        qualityFactors
      );

      if (this.hasQdrant()) {
        try {
          await this.qdrant!.upsertGlobalMemoryWithPayload(id, embedding, {
            content,
            tags,
            source,
            type,
            createdAt: new Date().toISOString(),
          });
        } catch (error) {
          this._warnQdrantFailure(`Failed to sync global memory vector ${id}`, error);
        }
      }
      this._sessionCounters.globalMemoriesCreated++;
      return { id, created: true };
    }

    const sqlite = await this.getSqliteFns();
    const result = sqlite.saveGlobalMemory(content, embedding, tags, source, undefined, {
      type,
      deduplicate,
    });

    if (this.hasQdrant() && !result.isDuplicate) {
      try {
        await this.qdrant!.upsertGlobalMemoryWithPayload(result.id, embedding, {
          content,
          tags,
          source,
          type,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        this._warnQdrantFailure(`Failed to sync global memory vector ${result.id}`, error);
      }
    }

    if (!result.isDuplicate) {
      this._sessionCounters.globalMemoriesCreated++;
    } else {
      this._sessionCounters.memoriesDuplicated++;
    }
    return {
      id: result.id,
      created: !result.isDuplicate,
      duplicate:
        result.isDuplicate && result.similarity != null
          ? { id: result.id, content: '', similarity: result.similarity }
          : undefined,
    };
  }

  async searchGlobalMemories(
    queryEmbedding: number[],
    limit: number = 5,
    threshold: number = 0.3,
    tags?: string[]
  ): Promise<Array<GlobalMemorySearchResult | MemorySearchResult | HybridGlobalMemoryResult>> {
    if (this.hasQdrant()) {
      try {
        const results = await this.qdrant!.hybridSearchGlobalMemories(
          '',
          queryEmbedding,
          limit,
          threshold,
          { tags }
        );
        if (results.length > 0) return results;
      } catch (error) {
        this._warnQdrantFailure('searchGlobalMemories failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.searchGlobalMemories(queryEmbedding, limit, threshold, tags);
    const sqlite = await this.getSqliteFns();
    return sqlite.searchGlobalMemories(queryEmbedding, limit, threshold, tags);
  }

  async getRecentGlobalMemories(limit: number = 10): Promise<Array<GlobalMemory | MemoryRecord>> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getRecentGlobalMemories(limit);
    const sqlite = await this.getSqliteFns();
    return sqlite.getRecentGlobalMemories(limit);
  }

  async deleteGlobalMemory(id: number): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) {
      const deleted = await this.postgres.deleteGlobalMemory(id);
      if (deleted && this.vectorBackend === 'qdrant' && this.qdrant)
        await this.qdrant.deleteGlobalMemoryVector(id);
      return deleted;
    }
    const sqlite = await this.getSqliteFns();
    const deleted = sqlite.deleteGlobalMemory(id);
    if (deleted && this.vectorBackend === 'qdrant' && this.qdrant) {
      try {
        await this.qdrant.deleteGlobalMemoryVector(id);
      } catch (err) {
        logWarn('storage', `Qdrant global vector delete failed for memory ${id}`, {
          error: String(err),
        });
      }
    }
    return deleted;
  }

  async findSimilarGlobalMemory(
    embedding: number[],
    threshold?: number
  ): Promise<{ id: number; content: string; similarity: number } | null> {
    const thresh = threshold ?? 0.92;
    if (this.vectorBackend === 'qdrant' && this.qdrant) {
      try {
        const results = await this.qdrant.findSimilarWithContent(
          'global_memories',
          embedding,
          3,
          thresh
        );
        if (results.length > 0 && results[0].similarity >= thresh) {
          return {
            id: results[0].id,
            content: results[0].content,
            similarity: results[0].similarity,
          };
        }
        if (results.length === 0 && this.backend === 'postgresql' && this.postgres) {
          const qr = await this.qdrant.searchGlobalMemories(embedding, 3, thresh);
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
        this._warnQdrantFailure('findSimilarGlobalMemory failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.findSimilarGlobalMemory(embedding, threshold);
    const sqlite = await this.getSqliteFns();
    return sqlite.findSimilarGlobalMemory(embedding, threshold);
  }

  async getGlobalMemoryStats(): Promise<GlobalMemoryStats> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getGlobalMemoryStats();
    const sqlite = await this.getSqliteFns();
    return sqlite.getGlobalMemoryStats();
  }

  // ===========================================================================
  // Skills
  // ===========================================================================
}
