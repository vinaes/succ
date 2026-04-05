/**
 * Context Limit Detection for Auto-Compact
 *
 * Determines the context window size for the current Claude model using a
 * multi-source priority chain:
 *   1. Explicit config override
 *   2. ANTHROPIC_MODEL env var (e.g., "[1m]" suffix)
 *   3. Real API usage.input_tokens > 200K in transcript → 1M model
 *   4. Claude self-report "succ-model-info:" line in transcript
 *   5. model family heuristic (opus = 1M, haiku = 200K, sonnet = null)
 *
 * Returns null for ambiguous models (Sonnet without a definitive signal) to
 * prevent the feedback loop where premature compaction prevents input_tokens
 * from ever exceeding 200K.
 */

import fs from 'fs';
import { logWarn } from './fault-logger.js';

// ── Known model context limits ─────────────────────────────────────────

const MODEL_FAMILY_LIMITS: Record<string, number> = {
  opus: 1_000_000,
  haiku: 200_000,
};

/**
 * Map a model ID string to a context limit via family heuristic.
 * Returns null for ambiguous models (e.g., Sonnet).
 */
export function getContextLimit(modelId: string): number | null {
  const lower = modelId.toLowerCase();
  if (lower.includes('[1m]') || lower.includes('-1m')) return 1_000_000;
  if (lower.includes('[200k]') || lower.includes('-200k')) return 200_000;
  for (const [family, limit] of Object.entries(MODEL_FAMILY_LIMITS)) {
    if (lower.includes(family)) return limit;
  }
  return null; // ambiguous — caller must handle
}

/**
 * Read the tail of a transcript file as a UTF-8 string.
 * Line-aware: always starts at a newline boundary.
 * Exported so other modules (e.g. pricing, context-monitor) can share this logic.
 */
export function readTranscriptTail(transcriptPath: string, maxBytes: number): string {
  try {
    if (!fs.existsSync(transcriptPath)) return '';
    const stats = fs.statSync(transcriptPath);
    if (stats.size === 0) return '';
    if (stats.size <= maxBytes) {
      return fs.readFileSync(transcriptPath, 'utf8');
    }
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(maxBytes);
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(fd, buf, 0, maxBytes, stats.size - maxBytes);
    } finally {
      fs.closeSync(fd);
    }
    const content = buf.slice(0, bytesRead).toString('utf8');
    const firstNewline = content.indexOf('\n');
    return firstNewline >= 0 ? content.slice(firstNewline + 1) : content;
  } catch (err) {
    logWarn(
      'context-limits',
      `Failed to read transcript tail: ${err instanceof Error ? err.message : String(err)}`
    );
    return '';
  }
}

/**
 * Detect the context limit for the current session using multiple signals.
 *
 * @param transcriptPath - Path to the session JSONL transcript
 * @param configOverride - Explicit context_limit from user config (highest priority)
 * @returns Context limit in tokens, or null if the model is ambiguous
 */
export function detectContextLimit(transcriptPath: string, configOverride?: number): number | null {
  // 1. Explicit config override — always wins
  if (configOverride && configOverride > 0) return configOverride;

  // 2. ANTHROPIC_MODEL env var
  const envModel = process.env.ANTHROPIC_MODEL || '';
  if (envModel) {
    const envLimit = getContextLimit(envModel);
    if (envLimit !== null) return envLimit;
  }

  // 3. Scan transcript tail for real API signals + model info
  const tail = readTranscriptTail(transcriptPath, 50_000);
  if (!tail) return null;

  // Real API data: check the LAST (most recent) input_tokens value.
  // Using the last match avoids the sticky problem where any historical
  // value > 200K would permanently resolve to 1M even after a model switch.
  const inputTokenMatches = [...tail.matchAll(/"input_tokens"\s*:\s*(\d+)/g)];
  if (inputTokenMatches.length > 0) {
    const lastInputTokens = parseInt(inputTokenMatches[inputTokenMatches.length - 1][1], 10);
    if (lastInputTokens > 200_000) {
      return 1_000_000;
    }
  }

  // 4. Claude self-report: "succ-model-info: {family}, context: {size}"
  const selfReportMatches = [
    ...tail.matchAll(/succ-model-info:\s*([^,\n]+),\s*context:\s*(\w+)/gi),
  ];
  const selfReport =
    selfReportMatches.length > 0 ? selfReportMatches[selfReportMatches.length - 1] : null;
  if (selfReport) {
    const ctxStr = selfReport[2].toLowerCase();
    if (ctxStr === '1m') return 1_000_000;
    if (ctxStr === '200k') return 200_000;
  }

  // 5. Model family from message.model field (use last match — most recent model)
  const modelMatches = [...tail.matchAll(/"model"\s*:\s*"([^"]+)"/g)];
  if (modelMatches.length > 0) {
    const lastModel = modelMatches[modelMatches.length - 1][1];
    const limit = getContextLimit(lastModel);
    if (limit !== null) return limit;
  }

  // Ambiguous (likely Sonnet without a definitive signal)
  return null;
}
