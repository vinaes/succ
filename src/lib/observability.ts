/**
 * Observability — query latency metrics, index freshness, memory health.
 *
 * Tracks:
 * - Query latency per search type
 * - Index freshness (stale ratio)
 * - Memory growth / stale ratio
 * - Recall hit rates
 * - Token savings tracking per feature
 */

import {
  getMemoryHealth,
  getStats,
  getCodeFileCount,
  getTokenStatsSummary,
} from './storage/index.js';
import { logWarn } from './fault-logger.js';

// ============================================================================
// Types
// ============================================================================

export interface LatencyMetric {
  operation: string;
  durationMs: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ObservabilityDashboard {
  /** Average query latency by operation type (last 24h) */
  queryLatency: Array<{ operation: string; avgMs: number; p95Ms: number; count: number }>;
  /** Memory health metrics */
  memoryHealth: {
    total: number;
    staleCount: number;
    staleRatio: number;
    avgAge: number;
    avgAccessCount: number;
    neverAccessed: number;
  };
  /** Index freshness */
  indexFreshness: {
    totalDocuments: number;
    totalCodeChunks: number;
    lastIndexedAt: string | null;
  };
  /** Token savings from RAG */
  tokenSavings: {
    totalSaved: number;
    totalFull: number;
    savingsRatio: number;
  };
}

// ============================================================================
// Latency Tracking
// ============================================================================

// Circular ring buffer for recent latency metrics (no DB dependency)
const MAX_BUFFER_SIZE = 1000;
const latencyRing: Array<LatencyMetric | null> = new Array(MAX_BUFFER_SIZE).fill(null);
let ringWriteIdx = 0;
let ringCount = 0;

/** Get all non-null entries from the ring buffer. */
function getLatencyBuffer(): LatencyMetric[] {
  const result: LatencyMetric[] = [];
  for (let i = 0; i < ringCount; i++) {
    const idx = (ringWriteIdx - ringCount + i + MAX_BUFFER_SIZE) % MAX_BUFFER_SIZE;
    const entry = latencyRing[idx];
    if (entry) result.push(entry);
  }
  return result;
}

/**
 * Record a latency measurement.
 */
export function recordLatency(
  operation: string,
  durationMs: number,
  metadata?: Record<string, unknown>
): void {
  latencyRing[ringWriteIdx] = {
    operation,
    durationMs,
    timestamp: new Date().toISOString(),
    metadata,
  };
  ringWriteIdx = (ringWriteIdx + 1) % MAX_BUFFER_SIZE;
  if (ringCount < MAX_BUFFER_SIZE) ringCount++;
}

/**
 * Helper to measure async operation latency.
 */
export async function withLatency<T>(
  operation: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const durationMs = performance.now() - start;
    recordLatency(operation, durationMs, metadata);
  }
}

/**
 * Get latency statistics for recent operations.
 */
export function getLatencyStats(
  operation?: string,
  windowMs: number = 86400000 // 24h
): Array<{ operation: string; avgMs: number; p95Ms: number; count: number }> {
  const cutoffTime = Date.now() - windowMs;
  const filtered = getLatencyBuffer().filter(
    (m) =>
      new Date(m.timestamp).getTime() >= cutoffTime && (!operation || m.operation === operation)
  );

  // Group by operation
  const groups = new Map<string, number[]>();
  for (const m of filtered) {
    const durations = groups.get(m.operation) ?? [];
    durations.push(m.durationMs);
    groups.set(m.operation, durations);
  }

  const stats: Array<{ operation: string; avgMs: number; p95Ms: number; count: number }> = [];

  for (const [op, durations] of groups) {
    durations.sort((a, b) => a - b);
    const avg = durations.reduce((s, d) => s + d, 0) / durations.length;
    const p95Index = Math.floor(durations.length * 0.95);
    const p95 = durations[Math.min(p95Index, durations.length - 1)];

    stats.push({
      operation: op,
      avgMs: Math.round(avg * 100) / 100,
      p95Ms: Math.round(p95 * 100) / 100,
      count: durations.length,
    });
  }

  return stats.sort((a, b) => b.count - a.count);
}

// ============================================================================
// Dashboard
// ============================================================================

/**
 * Generate a full observability dashboard.
 * Uses storage abstraction — works with both SQLite and PostgreSQL backends.
 */
export async function getDashboard(): Promise<ObservabilityDashboard> {
  const queryLatency = getLatencyStats();

  let memoryHealth = {
    total: 0,
    staleCount: 0,
    staleRatio: 0,
    avgAge: 0,
    avgAccessCount: 0,
    neverAccessed: 0,
  };

  try {
    const memRow = await getMemoryHealth();
    memoryHealth = {
      total: memRow.total,
      staleCount: memRow.stale,
      staleRatio: memRow.total > 0 ? memRow.stale / memRow.total : 0,
      avgAge: Math.round(memRow.avg_age_days),
      avgAccessCount: Math.round(memRow.avg_access * 10) / 10,
      neverAccessed: memRow.never_accessed,
    };
  } catch (e) {
    logWarn('observability', `Failed to get memory health: ${e instanceof Error ? e.message : e}`);
  }

  let indexFreshness = {
    totalDocuments: 0,
    totalCodeChunks: 0,
    lastIndexedAt: null as string | null,
  };
  try {
    const [docStats, codeCount] = await Promise.all([getStats(), getCodeFileCount()]);
    indexFreshness = {
      totalDocuments: docStats.total_documents,
      totalCodeChunks: codeCount,
      lastIndexedAt: docStats.last_indexed,
    };
  } catch (e) {
    logWarn(
      'observability',
      `Failed to get index freshness: ${e instanceof Error ? e.message : e}`
    );
  }

  let tokenSavings = { totalSaved: 0, totalFull: 0, savingsRatio: 0 };
  try {
    const summary = await getTokenStatsSummary();
    const totalSaved = summary.total_savings_tokens ?? 0;
    const totalFull = summary.total_full_source_tokens ?? 0;
    tokenSavings = {
      totalSaved,
      totalFull,
      savingsRatio: totalFull > 0 ? totalSaved / totalFull : 0,
    };
  } catch (e) {
    logWarn('observability', `Failed to get token savings: ${e instanceof Error ? e.message : e}`);
  }

  return {
    queryLatency,
    memoryHealth,
    indexFreshness,
    tokenSavings,
  };
}

/**
 * Format dashboard as human-readable text.
 */
export function formatDashboard(dashboard: ObservabilityDashboard): string {
  const lines: string[] = [];

  lines.push('=== Observability Dashboard ===');
  lines.push('');

  // Query latency
  lines.push('Query Latency (24h):');
  if (dashboard.queryLatency.length === 0) {
    lines.push('  No queries recorded');
  } else {
    for (const stat of dashboard.queryLatency) {
      lines.push(
        `  ${stat.operation}: avg=${stat.avgMs}ms, p95=${stat.p95Ms}ms (${stat.count} queries)`
      );
    }
  }

  lines.push('');

  // Memory health
  const mh = dashboard.memoryHealth;
  lines.push('Memory Health:');
  lines.push(`  Total: ${mh.total}`);
  lines.push(`  Never accessed: ${mh.neverAccessed} (${(mh.staleRatio * 100).toFixed(1)}% stale)`);
  lines.push(`  Avg age: ${mh.avgAge} days`);
  lines.push(`  Avg access count: ${mh.avgAccessCount}`);

  lines.push('');

  // Index freshness
  const idx = dashboard.indexFreshness;
  lines.push('Index Freshness:');
  lines.push(`  Documents: ${idx.totalDocuments}`);
  lines.push(`  Code chunks: ${idx.totalCodeChunks}`);
  lines.push(`  Last indexed: ${idx.lastIndexedAt ?? 'never'}`);

  lines.push('');

  // Token savings
  const ts = dashboard.tokenSavings;
  lines.push('Token Savings:');
  lines.push(`  Saved: ${ts.totalSaved.toLocaleString()} tokens`);
  lines.push(`  Savings ratio: ${(ts.savingsRatio * 100).toFixed(1)}%`);

  return lines.join('\n');
}
