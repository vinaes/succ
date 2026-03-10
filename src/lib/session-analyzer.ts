/**
 * Session Analyzer — parse Claude Code JSONL transcripts and produce
 * token breakdown stats by content type and tool name.
 *
 * Used by:
 * - CLI: `succ session analyze`
 * - PreCompact hook: snapshot before compaction
 * - SessionStart hook: post-compact delta display
 */

import { readFile } from 'node:fs/promises';
import { logWarn } from './fault-logger.js';

// ── Types ────────────────────────────────────────────────────────────

/** A single content block inside a message's content array. */
export interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  thinking?: string;
  source?: { type?: string };
}

/** A single JSONL transcript entry. */
export interface TranscriptEntry {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  slug?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  tool_name?: string;
  tool_input?: unknown;
  tool_result?: unknown;
}

/** Token/char breakdown by content type. */
export interface ContentBreakdown {
  text: number;
  tool_use: number;
  tool_result: number;
  thinking: number;
  image: number;
  other: number;
  total: number;
}

/** Per-tool usage stats. */
export interface ToolStats {
  name: string;
  calls: number;
  inputTokens: number;
  resultTokens: number;
  totalTokens: number;
}

/** A potential compact cut point (at a user message). */
export interface CutPoint {
  position: number;
  cumulativeTokens: number;
  preview: string;
}

/** Complete session analysis result. */
export interface SessionAnalysis {
  totalLines: number;
  activeChainLength: number;
  charTotals: ContentBreakdown;
  tokenTotals: ContentBreakdown;
  toolBreakdown: ToolStats[];
  cutPoints: CutPoint[];
  strippableTokens: number;
  strippablePercent: number;
}

// ── Token estimation ─────────────────────────────────────────────────

/** Estimate tokens from character count (industry standard: ~4 chars/token). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

// ── JSONL parsing ────────────────────────────────────────────────────

/** Parse a JSONL string into transcript entries, skipping malformed lines. */
export function parseSessionJSONL(content: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as TranscriptEntry);
    } catch (e) {
      logWarn('session-analyzer', `Skipping malformed JSONL line: ${e}`);
    }
  }
  return entries;
}

// ── Content block classification ─────────────────────────────────────

/** Count characters in a content value by category. */
export function classifyContent(
  content: string | ContentBlock[] | null | undefined
): ContentBreakdown {
  const result: ContentBreakdown = {
    text: 0,
    tool_use: 0,
    tool_result: 0,
    thinking: 0,
    image: 0,
    other: 0,
    total: 0,
  };

  if (!content) return result;

  if (typeof content === 'string') {
    result.text = content.length;
    result.total = content.length;
    return result;
  }

  if (!Array.isArray(content)) return result;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const blockType = block.type || 'other';
    let chars = 0;

    switch (blockType) {
      case 'text':
        chars = (block.text || '').length;
        result.text += chars;
        break;

      case 'tool_use':
        chars = block.input ? JSON.stringify(block.input).length : 0;
        // Add the tool name and id overhead
        chars += (block.name || '').length + (block.id || '').length;
        result.tool_use += chars;
        break;

      case 'tool_result': {
        const rc = block.content;
        if (typeof rc === 'string') {
          chars = rc.length;
        } else if (Array.isArray(rc)) {
          chars = JSON.stringify(rc).length;
        }
        result.tool_result += chars;
        break;
      }

      case 'thinking':
        chars = (block.thinking || '').length;
        result.thinking += chars;
        break;

      case 'image':
        // Images can be very large (base64). Estimate from source.
        chars = block.source ? JSON.stringify(block.source).length : 100;
        result.image += chars;
        break;

      default:
        chars = JSON.stringify(block).length;
        result.other += chars;
        break;
    }

    result.total += chars;
  }

  return result;
}

// ── Tool result index ────────────────────────────────────────────────

/** Build mapping from tool_use_id → total result chars across all entries. */
function buildToolResultIndex(entries: TranscriptEntry[]): Map<string, number> {
  const index = new Map<string, number>();

  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const tuid = block.tool_use_id;
      if (!tuid) continue;

      let chars = 0;
      const rc = block.content;
      if (typeof rc === 'string') {
        chars = rc.length;
      } else if (Array.isArray(rc)) {
        chars = JSON.stringify(rc).length;
      }

      index.set(tuid, (index.get(tuid) || 0) + chars);
    }
  }

  return index;
}

// ── Main analysis ────────────────────────────────────────────────────

/** Analyze a list of transcript entries and produce full session stats. */
export function analyzeSession(entries: TranscriptEntry[]): SessionAnalysis {
  const charTotals: ContentBreakdown = {
    text: 0,
    tool_use: 0,
    tool_result: 0,
    thinking: 0,
    image: 0,
    other: 0,
    total: 0,
  };

  // Tool stats accumulator
  const toolMap = new Map<string, { calls: number; inputChars: number; resultChars: number }>();
  const toolResultIndex = buildToolResultIndex(entries);

  // Cut points
  const cutPoints: CutPoint[] = [];
  let cumulativeChars = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const content = entry.message?.content;

    // Classify this entry's content
    const cc = classifyContent(content);

    // Accumulate totals
    charTotals.text += cc.text;
    charTotals.tool_use += cc.tool_use;
    charTotals.tool_result += cc.tool_result;
    charTotals.thinking += cc.thinking;
    charTotals.image += cc.image;
    charTotals.other += cc.other;
    charTotals.total += cc.total;

    cumulativeChars += cc.total;

    // Collect tool_use blocks for per-tool breakdown
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use') continue;
        const name = block.name || 'unknown';
        const inputChars = block.input ? JSON.stringify(block.input).length : 0;

        const existing = toolMap.get(name) || { calls: 0, inputChars: 0, resultChars: 0 };
        existing.calls++;
        existing.inputChars += inputChars;

        // Find matching tool_result chars
        const blockId = block.id;
        if (blockId && toolResultIndex.has(blockId)) {
          existing.resultChars += toolResultIndex.get(blockId)!;
        }

        toolMap.set(name, existing);
      }
    }

    // Cut point at user messages
    if (entry.type === 'user' || entry.message?.role === 'user') {
      const text = extractPreview(content);
      if (text) {
        cutPoints.push({
          position: i,
          cumulativeTokens: estimateTokens(cumulativeChars),
          preview: text,
        });
      }
    }
  }

  // Build token totals
  const tokenTotals: ContentBreakdown = {
    text: estimateTokens(charTotals.text),
    tool_use: estimateTokens(charTotals.tool_use),
    tool_result: estimateTokens(charTotals.tool_result),
    thinking: estimateTokens(charTotals.thinking),
    image: estimateTokens(charTotals.image),
    other: estimateTokens(charTotals.other),
    total: estimateTokens(charTotals.total),
  };

  // Build tool breakdown sorted by total tokens desc
  const toolBreakdown: ToolStats[] = Array.from(toolMap.entries())
    .map(([name, stats]) => ({
      name,
      calls: stats.calls,
      inputTokens: estimateTokens(stats.inputChars),
      resultTokens: estimateTokens(stats.resultChars),
      totalTokens: estimateTokens(stats.inputChars + stats.resultChars),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  // Strippable = tool_use + tool_result + thinking + image
  const strippableTokens =
    tokenTotals.tool_use + tokenTotals.tool_result + tokenTotals.thinking + tokenTotals.image;
  const strippablePercent =
    tokenTotals.total > 0 ? (strippableTokens / tokenTotals.total) * 100 : 0;

  // Compute true active chain length by following parentUuid links.
  // The active chain is the longest path in the parentUuid-linked DAG,
  // which represents the main conversation thread after any branching/retries.
  let activeChainLength = 0;
  if (entries.length > 0) {
    // Build a lookup map: uuid → entry
    const byUuid = new Map<string, TranscriptEntry>();
    for (const e of entries) {
      if (e.uuid) byUuid.set(e.uuid, e);
    }

    // Identify terminal entries: those whose uuid is not referenced as any parentUuid
    const referencedAsParent = new Set<string>();
    for (const e of entries) {
      if (e.parentUuid) referencedAsParent.add(e.parentUuid);
    }
    const terminals = entries.filter((e) => e.uuid && !referencedAsParent.has(e.uuid));

    // For each terminal, walk parentUuid back to the root, counting chain length
    for (const terminal of terminals) {
      let chainLen = 0;
      const visited = new Set<string>();
      let current: TranscriptEntry | undefined = terminal;
      while (current) {
        const id = current.uuid;
        if (!id || visited.has(id)) break; // guard against cycles
        visited.add(id);
        chainLen++;
        current = current.parentUuid ? byUuid.get(current.parentUuid) : undefined;
      }
      if (chainLen > activeChainLength) activeChainLength = chainLen;
    }

    // Fallback: if no uuid-linked chain found, use total entry count
    if (activeChainLength === 0) activeChainLength = entries.length;
  }

  return {
    totalLines: entries.length,
    activeChainLength,
    charTotals,
    tokenTotals,
    toolBreakdown,
    cutPoints,
    strippableTokens,
    strippablePercent,
  };
}

// ── File-based analysis ──────────────────────────────────────────────

/** Analyze a session JSONL file. */
export async function analyzeSessionFile(filePath: string): Promise<SessionAnalysis> {
  const content = await readFile(filePath, 'utf-8');
  const entries = parseSessionJSONL(content);
  return analyzeSession(entries);
}

// ── Report formatting ────────────────────────────────────────────────

/** Format a complete analysis as a human-readable report (like session-stripper). */
export function formatAnalysisReport(analysis: SessionAnalysis, filePath?: string): string {
  const lines: string[] = [];
  const { tokenTotals, toolBreakdown, cutPoints, strippableTokens, strippablePercent } = analysis;

  lines.push('═'.repeat(72));
  lines.push('SESSION ANALYSIS');
  lines.push('═'.repeat(72));
  lines.push('');
  if (filePath) lines.push(`  File:              ${filePath}`);
  lines.push(`  Total lines:       ${analysis.totalLines}`);
  lines.push(`  Active chain:      ${analysis.activeChainLength} messages`);
  lines.push('');

  // Token breakdown by content type
  lines.push('─'.repeat(72));
  lines.push('TOKEN BREAKDOWN BY CONTENT TYPE');
  lines.push('─'.repeat(72));
  lines.push('');
  lines.push(
    `  ${'Type'.padEnd(16)} ${'Chars'.padStart(12)} ${'Est. Tokens'.padStart(12)} ${'%'.padStart(7)}  Note`
  );
  lines.push(
    `  ${'─'.repeat(16)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(7)}  ${'─'.repeat(12)}`
  );

  const grandTotal = tokenTotals.total || 1;
  const strippableTypes = new Set(['tool_use', 'tool_result', 'thinking', 'image']);

  for (const key of ['text', 'tool_use', 'tool_result', 'thinking', 'image', 'other'] as const) {
    const chars = analysis.charTotals[key];
    const tokens = tokenTotals[key];
    const pct = ((tokens / grandTotal) * 100).toFixed(1);
    const note = strippableTypes.has(key) ? 'trimmable' : '';
    lines.push(
      `  ${key.padEnd(16)} ${fmt(chars).padStart(12)} ${fmt(tokens).padStart(12)} ${(pct + '%').padStart(7)}  ${note}`
    );
  }

  lines.push(`  ${'─'.repeat(16)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(7)}`);
  lines.push(
    `  ${'TOTAL'.padEnd(16)} ${fmt(analysis.charTotals.total).padStart(12)} ${fmt(tokenTotals.total).padStart(12)} ${'100.0%'.padStart(7)}`
  );
  lines.push(
    `  ${'TRIMMABLE'.padEnd(16)} ${''.padStart(12)} ${fmt(strippableTokens).padStart(12)} ${(strippablePercent.toFixed(1) + '%').padStart(7)}`
  );
  lines.push('');

  // Tool breakdown
  if (toolBreakdown.length > 0) {
    lines.push('─'.repeat(72));
    lines.push('TOKEN BREAKDOWN BY TOOL NAME');
    lines.push('─'.repeat(72));
    lines.push('');
    lines.push(
      `  ${'Tool'.padEnd(28)} ${'Calls'.padStart(6)} ${'Inputs'.padStart(10)} ${'Results'.padStart(10)} ${'Total'.padStart(10)} ${'%'.padStart(7)}`
    );
    lines.push(
      `  ${'─'.repeat(28)} ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(7)}`
    );

    const toolTotal = toolBreakdown.reduce((sum, t) => sum + t.totalTokens, 0) || 1;
    for (const tool of toolBreakdown) {
      const pct = ((tool.totalTokens / toolTotal) * 100).toFixed(1);
      lines.push(
        `  ${tool.name.padEnd(28)} ${String(tool.calls).padStart(6)} ${fmt(tool.inputTokens).padStart(10)} ${fmt(tool.resultTokens).padStart(10)} ${fmt(tool.totalTokens).padStart(10)} ${(pct + '%').padStart(7)}`
      );
    }
    lines.push('');
  }

  // Cut points
  if (cutPoints.length > 0) {
    lines.push('─'.repeat(72));
    lines.push('CUT POINT CANDIDATES (user messages)');
    lines.push('─'.repeat(72));
    lines.push('');
    lines.push(`  ${'Pos'.padStart(5)} ${'Cum. Tokens'.padStart(12)}  Message preview`);
    lines.push(`  ${'─'.repeat(5)} ${'─'.repeat(12)}  ${'─'.repeat(50)}`);

    for (const cp of cutPoints) {
      lines.push(
        `  ${String(cp.position).padStart(5)} ${fmt(cp.cumulativeTokens).padStart(12)}  ${cp.preview}`
      );
    }
    lines.push('');
  }

  lines.push('═'.repeat(72));

  return lines.join('\n');
}

/** Format a compact stats block for post-compact display. */
export function formatCompactStats(
  before: Pick<SessionAnalysis, 'tokenTotals' | 'toolBreakdown'>,
  afterTokens: number,
  afterBreakdown?: Partial<ContentBreakdown>
): string {
  const bt = before.tokenTotals;
  const freed = bt.total - afterTokens;
  const pct = bt.total > 0 ? ((freed / bt.total) * 100).toFixed(1) : '0.0';

  const lines: string[] = [];
  lines.push(`Compact: ${fmtK(bt.total)} → ${fmtK(afterTokens)} tokens (${pct}% freed)`);
  lines.push('');
  lines.push(
    `  ${'Type'.padEnd(16)} ${'Before'.padStart(8)} ${'After'.padStart(8)} ${'Freed'.padStart(8)}`
  );
  lines.push(`  ${'─'.repeat(16)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);

  for (const key of ['text', 'tool_use', 'tool_result', 'thinking', 'image'] as const) {
    const bVal = bt[key];
    const aVal = afterBreakdown ? (afterBreakdown[key] ?? 0) : key === 'text' ? afterTokens : 0;
    const f = bVal - aVal;
    if (bVal === 0 && f === 0) continue;
    lines.push(
      `  ${key.padEnd(16)} ${fmtK(bVal).padStart(8)} ${fmtK(aVal).padStart(8)} ${fmtK(f).padStart(8)}`
    );
  }

  lines.push(`  ${'─'.repeat(16)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);
  lines.push(
    `  ${'TOTAL'.padEnd(16)} ${fmtK(bt.total).padStart(8)} ${fmtK(afterTokens).padStart(8)} ${fmtK(freed).padStart(8)}`
  );

  // Top tools trimmed
  const topTools = before.toolBreakdown.slice(0, 5).filter((t) => t.totalTokens > 0);
  if (topTools.length > 0) {
    lines.push('');
    lines.push('  Top tools trimmed:');
    lines.push('  ' + topTools.map((t) => `${t.name}: ${fmtK(t.totalTokens)}`).join(' | '));
  }

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Extract a preview string from content (first 100 chars of text). */
function extractPreview(content: string | ContentBlock[] | null | undefined): string {
  if (!content) return '';

  if (typeof content === 'string') {
    return truncate(content.replace(/\n/g, ' ').trim(), 100);
  }

  if (Array.isArray(content)) {
    for (const block of content as Array<ContentBlock | string>) {
      if (typeof block !== 'string' && block?.type === 'text' && block.text) {
        return truncate(block.text.replace(/\n/g, ' ').trim(), 100);
      }
      // String blocks (legacy format)
      if (typeof block === 'string') {
        return truncate(block.replace(/\n/g, ' ').trim(), 100);
      }
    }
  }

  return '';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/** Format number with commas: 12345 → "12,345" */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** Format as K: 12345 → "12.3K", small numbers as-is. */
function fmtK(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
