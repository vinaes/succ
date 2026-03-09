/**
 * MR Context Pack Generator — builds review context from a git diff.
 *
 * Pipeline:
 * 1. git diff → parse-diff → changed files + hunks
 * 2. succ_search_code → related symbols for each changed function
 * 3. succ_recall → past decisions/pitfalls for touched modules
 * 4. git log → recent changes to same files
 * 5. callLLM → structured review context pack
 */

import { execFileSync } from 'child_process';
import { parseDiffText, extractChangedSymbols, summarizeDiff } from '../diff-parser.js';
import type { ParsedDiff } from '../diff-parser.js';
import { getEmbedding } from '../embeddings.js';
import { logWarn } from '../fault-logger.js';
import { callLLM } from '../llm.js';
import { getProjectRoot } from '../config.js';

// ============================================================================
// Types
// ============================================================================

export interface ReviewContextPack {
  summary: string;
  diffStats: {
    files: number;
    additions: number;
    deletions: number;
  };
  changedFiles: Array<{
    path: string;
    additions: number;
    deletions: number;
    isNew: boolean;
    isDeleted: boolean;
  }>;
  changedSymbols: Array<{ file: string; symbol: string }>;
  relatedSymbols: Array<{
    file: string;
    symbol: string;
    similarity: number;
  }>;
  relevantMemories: Array<{
    id: number;
    content: string;
    tags: string[];
    similarity: number;
  }>;
  recentHistory: Array<{
    file: string;
    commits: string[];
  }>;
  reviewFocus: string[];
  blastRadius: string;
}

// ============================================================================
// Main Pipeline
// ============================================================================

/**
 * Generate a review context pack for a git diff reference.
 *
 * @param diffRef - Git diff reference (e.g., "HEAD~1", "main..feature", a commit SHA)
 * @param options - Configuration options
 */
export async function generateReviewContext(
  diffRef: string = 'HEAD~1',
  options: {
    maxRelatedSymbols?: number;
    maxMemories?: number;
    generateLLMSummary?: boolean;
  } = {}
): Promise<ReviewContextPack> {
  const { maxRelatedSymbols = 10, maxMemories = 10, generateLLMSummary = true } = options;

  const projectRoot = getProjectRoot();

  // Step 1: Get and parse diff
  const diffText = getDiff(diffRef, projectRoot);
  const parsed = parseDiffText(diffText);

  if (parsed.totalFiles === 0) {
    return emptyContextPack('No changes found for the given diff reference.');
  }

  const changedSymbols = extractChangedSymbols(parsed);

  // Step 2-4: Run searches in parallel
  const [relatedSymbols, relevantMemories, recentHistory] = await Promise.all([
    findRelatedSymbols(changedSymbols, parsed, maxRelatedSymbols),
    findRelevantMemories(parsed, changedSymbols, maxMemories),
    getRecentHistory(parsed, projectRoot),
  ]);

  // Step 5: Generate LLM summary
  let summary = summarizeDiff(parsed);
  let reviewFocus: string[] = [];
  let blastRadius = 'Unknown';

  if (generateLLMSummary) {
    try {
      const llmResult = await generateLLMReview(
        parsed,
        changedSymbols,
        relatedSymbols,
        relevantMemories,
        recentHistory
      );
      summary = llmResult.summary;
      reviewFocus = llmResult.reviewFocus;
      blastRadius = llmResult.blastRadius;
    } catch (error) {
      logWarn('review', 'LLM summary generation failed, using diff summary', {
        error: error instanceof Error ? error.message : String(error),
      });
      reviewFocus = ['LLM summary unavailable — manual review recommended'];
    }
  }

  return {
    summary,
    diffStats: {
      files: parsed.totalFiles,
      additions: parsed.totalAdditions,
      deletions: parsed.totalDeletions,
    },
    changedFiles: parsed.files.map((f) => ({
      path: f.to !== '/dev/null' ? f.to : f.from,
      additions: f.additions,
      deletions: f.deletions,
      isNew: f.isNew,
      isDeleted: f.isDeleted,
    })),
    changedSymbols,
    relatedSymbols,
    relevantMemories,
    recentHistory,
    reviewFocus,
    blastRadius,
  };
}

// ============================================================================
// Pipeline Steps
// ============================================================================

function getDiff(diffRef: string, projectRoot: string): string {
  try {
    // Validate diffRef: allow refs, flags like --cached/--staged, ranges
    if (!/^[\w.~^/\-@{}]+$/.test(diffRef) && !/^--(?:cached|staged)$/.test(diffRef)) {
      throw new Error(`Invalid diff reference: ${diffRef}`);
    }
    return execFileSync('git', ['diff', diffRef], {
      cwd: projectRoot,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
      timeout: 30000,
    });
  } catch (error) {
    logWarn('review', 'git diff failed', {
      error: error instanceof Error ? error.message : String(error),
      diffRef,
    });
    return '';
  }
}

async function findRelatedSymbols(
  changedSymbols: Array<{ file: string; symbol: string }>,
  parsed: ParsedDiff,
  maxResults: number
): Promise<Array<{ file: string; symbol: string; similarity: number }>> {
  const results: Array<{ file: string; symbol: string; similarity: number }> = [];

  try {
    // Import dynamically to avoid circular deps
    const { hybridSearchCode } = await import('../storage/index.js');

    // Search for each changed symbol
    const symbolQueries = changedSymbols.slice(0, 5); // Limit queries
    for (const sym of symbolQueries) {
      try {
        const query = `${sym.symbol} ${sym.file}`;
        const embedding = await getEmbedding(query);
        const searchResults = await hybridSearchCode(query, embedding, 5, 0.3);

        for (const r of searchResults) {
          // Skip files that are already in the diff
          const inDiff = parsed.files.some((f) => f.to === r.file_path || f.from === r.file_path);
          if (!inDiff && r.symbol_name) {
            results.push({
              file: r.file_path,
              symbol: r.symbol_name,
              similarity: r.similarity,
            });
          }
        }
      } catch (error) {
        logWarn('review', `Symbol search failed for ${sym.symbol}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    logWarn('review', 'Related symbol search unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Deduplicate and limit
  const seen = new Set<string>();
  return results
    .filter((r) => {
      const key = `${r.file}:${r.symbol}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxResults);
}

async function findRelevantMemories(
  parsed: ParsedDiff,
  changedSymbols: Array<{ file: string; symbol: string }>,
  maxResults: number
): Promise<Array<{ id: number; content: string; tags: string[]; similarity: number }>> {
  const results: Array<{ id: number; content: string; tags: string[]; similarity: number }> = [];

  try {
    const { hybridSearchMemories } = await import('../storage/index.js');

    // Build a query from changed files and symbols
    const fileNames = parsed.files
      .map((f) => (f.to !== '/dev/null' ? f.to : f.from))
      .slice(0, 5)
      .map((f) => f.split('/').pop())
      .join(', ');

    const symbolNames = changedSymbols
      .slice(0, 5)
      .map((s) => s.symbol)
      .join(', ');

    const query = `Changes to ${fileNames}. Functions: ${symbolNames}`;
    const embedding = await getEmbedding(query);

    const memResults = await hybridSearchMemories(query, embedding, maxResults, 0.2);

    for (const m of memResults) {
      results.push({
        id: (m as any).id ?? 0,
        content: (m as any).content ?? '',
        tags: (m as any).tags ?? [],
        similarity: (m as any).similarity ?? 0,
      });
    }
  } catch (error) {
    logWarn('review', 'Memory search unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return results;
}

async function getRecentHistory(
  parsed: ParsedDiff,
  projectRoot: string
): Promise<Array<{ file: string; commits: string[] }>> {
  const results: Array<{ file: string; commits: string[] }> = [];

  const files = parsed.files
    .map((f) => (f.to !== '/dev/null' ? f.to : f.from))
    .filter((f) => f !== '/dev/null')
    .slice(0, 10);

  for (const filePath of files) {
    try {
      const log = execFileSync('git', ['log', '--oneline', '-5', '--', filePath], {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();

      if (log) {
        results.push({
          file: filePath,
          commits: log.split('\n').filter(Boolean),
        });
      }
    } catch (error) {
      logWarn('review', `Failed to get git history for ${filePath}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

async function generateLLMReview(
  parsed: ParsedDiff,
  changedSymbols: Array<{ file: string; symbol: string }>,
  relatedSymbols: Array<{ file: string; symbol: string; similarity: number }>,
  memories: Array<{ id: number; content: string; tags: string[] }>,
  history: Array<{ file: string; commits: string[] }>
): Promise<{ summary: string; reviewFocus: string[]; blastRadius: string }> {
  const diffSummary = summarizeDiff(parsed);

  const symbolsSection =
    changedSymbols.length > 0
      ? `Changed functions/symbols:\n${changedSymbols.map((s) => `- ${s.file}: ${s.symbol}`).join('\n')}`
      : 'No function-level changes detected.';

  const relatedSection =
    relatedSymbols.length > 0
      ? `Related code (not in diff but architecturally connected):\n${relatedSymbols
          .slice(0, 5)
          .map((s) => `- ${s.file}: ${s.symbol} (${(s.similarity * 100).toFixed(0)}% similar)`)
          .join('\n')}`
      : '';

  const memorySection =
    memories.length > 0
      ? `Relevant past decisions/learnings:\n${memories
          .slice(0, 5)
          .map((m) => `- [#${m.id}] ${m.content.substring(0, 150)}`)
          .join('\n')}`
      : '';

  const historySection =
    history.length > 0
      ? `Recent git history for changed files:\n${history
          .slice(0, 5)
          .map((h) => `- ${h.file}: ${h.commits[0]}`)
          .join('\n')}`
      : '';

  const prompt = `You are a senior code reviewer. Analyze this change and produce a structured review context pack.

${diffSummary}

${symbolsSection}

${relatedSection}

${memorySection}

${historySection}

Respond in this exact format:
SUMMARY: [1-2 sentence summary of what changed and why]
FOCUS:
- [review focus area 1]
- [review focus area 2]
- [review focus area 3]
BLAST_RADIUS: [low/medium/high — how much of the codebase is affected]`;

  const response = await callLLM(prompt, { maxTokens: 500 });

  // Parse structured response
  const summaryMatch = response.match(/SUMMARY:\s*(.+?)(?=\nFOCUS:|$)/s);
  const focusMatch = response.match(/FOCUS:\s*([\s\S]+?)(?=\nBLAST_RADIUS:|$)/);
  const blastMatch = response.match(/BLAST_RADIUS:\s*(.+)/);

  const reviewFocus = focusMatch
    ? focusMatch[1]
        .split('\n')
        .map((l) => l.replace(/^-\s*/, '').trim())
        .filter(Boolean)
    : [];

  return {
    summary: summaryMatch ? summaryMatch[1].trim() : summarizeDiff(parsed),
    reviewFocus,
    blastRadius: blastMatch ? blastMatch[1].trim() : 'unknown',
  };
}

function emptyContextPack(summary: string): ReviewContextPack {
  return {
    summary,
    diffStats: { files: 0, additions: 0, deletions: 0 },
    changedFiles: [],
    changedSymbols: [],
    relatedSymbols: [],
    relevantMemories: [],
    recentHistory: [],
    reviewFocus: [],
    blastRadius: 'none',
  };
}
