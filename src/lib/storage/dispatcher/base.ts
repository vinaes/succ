import { logError } from '../../fault-logger.js';
import type { PostgresBackend } from '../backends/postgresql.js';
import type { QdrantVectorStore } from '../vector/qdrant.js';
import type {
  AuditChangedBy,
  AuditEventType,
  MemoryAuditRecord,
  MemoryRecord,
  MemoryStats,
} from '../types.js';

export interface StorageDispatcherInit {
  backend: 'sqlite' | 'postgresql';
  vectorBackend: 'builtin' | 'qdrant';
  postgres: PostgresBackend | null;
  qdrant: QdrantVectorStore | null;
}

// Internal SQL query result types
export interface SqlLearningDelta {
  id: number;
  timestamp: string;
  source: string;
  memories_before: number;
  memories_after: number;
  new_memories: number;
  types_added: string | null;
  avg_quality: number | null;
  created_at: string;
}

export interface SqlMemoryRow {
  id: number;
  content: string;
  tags: string | null;
  source: string | null;
  type: string | null;
  quality_score: number | null;
  quality_factors: string | null;
  access_count: number;
  last_accessed: string | null;
  valid_from: string | null;
  valid_until: string | null;
  invalidated_by: number | null;
  created_at: string;
  embedding?: Buffer | null;
}

export class StorageDispatcherBase {
  /** @internal — Used by dispatcher-export.ts. Do not access directly. */
  readonly backend: 'sqlite' | 'postgresql';
  /** @internal */
  readonly vectorBackend: 'builtin' | 'qdrant';
  /** @internal */
  readonly postgres: PostgresBackend | null;
  /** @internal */
  readonly qdrant: QdrantVectorStore | null;
  /** @internal */
  readonly qdrantStore: QdrantVectorStore | null;
  private _sqliteFns: typeof import('../../db/index.js') | null = null;

  // Cross-module methods are mixed in at runtime via applyMixins.
  // The base stubs provide type shape only and should never be invoked.
  async getMemoryStats(): Promise<MemoryStats> {
    throw new Error('StorageDispatcher mixin method getMemoryStats not initialized');
  }

  async appendLearningDelta(_delta: {
    timestamp: string;
    source: string;
    memoriesBefore: number;
    memoriesAfter: number;
    newMemories: number;
    typesAdded: Record<string, number>;
    avgQualityOfNew?: number | null;
  }): Promise<void> {
    throw new Error('StorageDispatcher mixin method appendLearningDelta not initialized');
  }

  async incrementCorrectionCount(_memoryId: number): Promise<void> {
    throw new Error('StorageDispatcher mixin method incrementCorrectionCount not initialized');
  }

  async setMemoryInvariant(_memoryId: number, _isInvariant: boolean): Promise<void> {
    throw new Error('StorageDispatcher mixin method setMemoryInvariant not initialized');
  }

  async recomputePriorityScore(_memoryId: number): Promise<void> {
    throw new Error('StorageDispatcher mixin method recomputePriorityScore not initialized');
  }

  async getMemoryEmbeddingsByIds(_ids: number[]): Promise<Map<number, number[]>> {
    throw new Error('StorageDispatcher mixin method getMemoryEmbeddingsByIds not initialized');
  }

  async getMemoryById(_id: number): Promise<MemoryRecord | null> {
    throw new Error('StorageDispatcher mixin method getMemoryById not initialized');
  }

  async _guardPinned(_memoryId: number): Promise<void> {
    throw new Error('StorageDispatcher mixin method _guardPinned not initialized');
  }

  async _filterOutPinned(_ids: number[]): Promise<number[]> {
    throw new Error('StorageDispatcher mixin method _filterOutPinned not initialized');
  }

  async recordAuditEvent(
    _memoryId: number,
    _eventType: AuditEventType,
    _oldContent: string | null,
    _newContent: string | null,
    _changedBy: AuditChangedBy
  ): Promise<void> {
    throw new Error('StorageDispatcher mixin method recordAuditEvent not initialized');
  }

  async getAuditHistory(_memoryId: number): Promise<MemoryAuditRecord[]> {
    throw new Error('StorageDispatcher mixin method getAuditHistory not initialized');
  }

  async pruneAuditTrail(_olderThanDays?: number): Promise<number> {
    throw new Error('StorageDispatcher mixin method pruneAuditTrail not initialized');
  }

  // Qdrant circuit breaker — disable after consecutive failures to stop log spam
  private static readonly QDRANT_CIRCUIT_THRESHOLD = 3;
  private _qdrantConsecutiveFailures = 0;
  private _qdrantCircuitOpen = false;

  // Learning delta auto-tracking counters
  protected _sessionCounters = {
    memoriesCreated: 0,
    memoriesDuplicated: 0,
    globalMemoriesCreated: 0,
    recallQueries: 0,
    searchQueries: 0,
    codeSearchQueries: 0,
    webSearchQueries: 0,
    webSearchCostUsd: 0,
    qdrantSyncFailures: 0,
    typesCreated: {} as Record<string, number>,
    startedAt: new Date().toISOString(),
  };

  constructor(init: StorageDispatcherInit) {
    this.backend = init.backend;
    this.vectorBackend = init.vectorBackend;
    this.postgres = init.postgres;
    this.qdrant = init.qdrant;
    this.qdrantStore = init.qdrant;
  }

  /** Reset consecutive failure counter on successful Qdrant operation. */
  protected _resetQdrantFailures(): void {
    this._qdrantConsecutiveFailures = 0;
  }

  /** Log Qdrant failure, increment counter, open circuit breaker after threshold. */
  protected _warnQdrantFailure(operation: string, error: unknown): void {
    this._sessionCounters.qdrantSyncFailures++;
    this._qdrantConsecutiveFailures++;
    const msg = error instanceof Error ? error.message : String(error);
    logError('storage', `Qdrant ${operation}: ${msg}`);

    if (
      !this._qdrantCircuitOpen &&
      this._qdrantConsecutiveFailures >= StorageDispatcherBase.QDRANT_CIRCUIT_THRESHOLD
    ) {
      this._qdrantCircuitOpen = true;
      logError(
        'storage',
        `Qdrant circuit breaker opened after ${this._qdrantConsecutiveFailures} consecutive failures — disabled for this session`
      );
    }
  }

  /** Get current session counters (non-destructive read) */
  getSessionCounters() {
    return { ...this._sessionCounters };
  }

  /** Flush session counters to learning_deltas table and reset */
  async flushSessionCounters(source: string): Promise<void> {
    const c = this._sessionCounters;
    const totalCreated = c.memoriesCreated + c.globalMemoriesCreated;

    if (
      totalCreated === 0 &&
      c.recallQueries === 0 &&
      c.searchQueries === 0 &&
      c.codeSearchQueries === 0 &&
      c.webSearchQueries === 0
    )
      return;

    try {
      const stats = await this.getMemoryStats();
      await this.appendLearningDelta({
        timestamp: new Date().toISOString(),
        source,
        memoriesBefore: (stats.total_memories ?? 0) - totalCreated,
        memoriesAfter: stats.total_memories ?? 0,
        newMemories: totalCreated,
        typesAdded: c.typesCreated,
        avgQualityOfNew: null,
      });
    } catch (error) {
      // Don't let flush errors break shutdown
      logError(
        'storage',
        'Failed to flush session counters',
        error instanceof Error ? error : new Error(String(error))
      );
    }

    this._sessionCounters = {
      memoriesCreated: 0,
      memoriesDuplicated: 0,
      globalMemoriesCreated: 0,
      recallQueries: 0,
      searchQueries: 0,
      codeSearchQueries: 0,
      webSearchQueries: 0,
      webSearchCostUsd: 0,
      qdrantSyncFailures: 0,
      typesCreated: {},
      startedAt: new Date().toISOString(),
    };
  }

  /** @internal — Used by dispatcher-export.ts for backend-specific queries. */
  async getSqliteFns(): Promise<typeof import('../../db/index.js')> {
    if (!this._sqliteFns) {
      this._sqliteFns = await import('../../db/index.js');
    }
    return this._sqliteFns;
  }

  protected toIsoOrNull(value: unknown): string | null {
    if (value == null) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    return null;
  }

  /** Check if Qdrant is configured, available, and circuit breaker is closed */
  protected hasQdrant(): boolean {
    return this.vectorBackend === 'qdrant' && this.qdrant !== null && !this._qdrantCircuitOpen;
  }

  getBackendInfo(): {
    backend: 'sqlite' | 'postgresql';
    vector: 'builtin' | 'qdrant';
    vectorName: string;
  } {
    return {
      backend: this.backend,
      vector: this.vectorBackend,
      vectorName:
        this.vectorBackend === 'qdrant'
          ? 'qdrant'
          : this.backend === 'postgresql'
            ? 'pgvector'
            : 'sqlite-vec',
    };
  }
}
