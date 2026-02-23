import { StorageDispatcherBase } from './base.js';
import { logWarn } from '../../fault-logger.js';
import type { MemoryForRetention, WorkingMemoryRecord } from '../types.js';

export class RetentionDispatcherMixin extends StorageDispatcherBase {
  async incrementMemoryAccess(memoryId: number, weight?: number): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.incrementMemoryAccess(memoryId, weight);
    } else {
      const sqlite = await this.getSqliteFns();
      sqlite.incrementMemoryAccess(memoryId, weight);
    }
    // Recompute priority_score after access change
    await this.recomputePriorityScore(memoryId);
  }

  async incrementMemoryAccessBatch(
    accesses: Array<{ memoryId: number; weight: number }>
  ): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.incrementMemoryAccessBatch(accesses);
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.incrementMemoryAccessBatch(accesses);
  }

  async incrementCorrectionCount(memoryId: number): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.incrementCorrectionCount(memoryId);
    } else {
      const sqlite = await this.getSqliteFns();
      sqlite.incrementCorrectionCount(memoryId);
    }
    // Recompute priority_score after correction change
    await this.recomputePriorityScore(memoryId);
  }

  async setMemoryInvariant(memoryId: number, isInvariant: boolean): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.setMemoryInvariant(memoryId, isInvariant);
    } else {
      const sqlite = await this.getSqliteFns();
      sqlite.setMemoryInvariant(memoryId, isInvariant);
    }
    // Recompute priority_score after invariant change
    await this.recomputePriorityScore(memoryId);
  }

  async getPinnedMemories(threshold?: number): Promise<WorkingMemoryRecord[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getPinnedMemories(threshold);
    const sqlite = await this.getSqliteFns();
    return sqlite.getPinnedMemories(threshold);
  }

  async updatePriorityScore(memoryId: number, score: number): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.updatePriorityScore(memoryId, score);
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.updatePriorityScore(memoryId, score);
  }

  async recomputePriorityScore(memoryId: number): Promise<void> {
    try {
      const memory = await this.getMemoryById(memoryId);
      if (!memory) return;
      const { computePriorityScore } = await import('../../working-memory-pipeline.js');
      const score = computePriorityScore(
        {
          is_invariant: memory.is_invariant,
          quality_score: memory.quality_score,
          correction_count: memory.correction_count,
          type: memory.type ?? null,
          tags: memory.tags,
          access_count: memory.access_count,
          last_accessed: this.toIsoOrNull(memory.last_accessed),
          created_at: this.toIsoOrNull(memory.created_at) ?? new Date().toISOString(),
        },
        new Date()
      );
      await this.updatePriorityScore(memoryId, score);
    } catch (error) {
      logWarn('storage', 'priority_score recompute failed', {
        memoryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Filter out pinned memory IDs from a list (for bulk operations) */

  async _filterOutPinned(ids: number[]): Promise<number[]> {
    const { isPinned } = await import('../../working-memory-pipeline.js');
    const safe: number[] = [];
    for (const id of ids) {
      const memory = await this.getMemoryById(id);
      if (!memory) {
        safe.push(id);
        continue;
      }
      if (
        !isPinned({
          is_invariant: memory.is_invariant,
          correction_count: memory.correction_count,
        })
      ) {
        safe.push(id);
      }
    }
    return safe;
  }

  /** Throw PinnedMemoryError if the memory is pinned (Tier 1 immutability) */

  async _guardPinned(memoryId: number): Promise<void> {
    const memory = await this.getMemoryById(memoryId);
    if (!memory) return;
    const { isPinned, PinnedMemoryError } = await import('../../working-memory-pipeline.js');
    if (
      isPinned({
        is_invariant: memory.is_invariant,
        correction_count: memory.correction_count,
      })
    ) {
      throw new PinnedMemoryError(memoryId);
    }
  }

  async getAllMemoriesForRetention(): Promise<MemoryForRetention[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getAllMemoriesForRetention();
    const sqlite = await this.getSqliteFns();
    return sqlite.getAllMemoriesForRetention();
  }

  // ===========================================================================
  // BM25 Index Management
  // ===========================================================================
}
