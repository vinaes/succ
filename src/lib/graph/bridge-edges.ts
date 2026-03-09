/**
 * Bridge Edges — connects code entities with knowledge graph memories.
 *
 * Enables queries like "which decisions affect this function?" by creating
 * typed edges between memories and the code they reference.
 *
 * Bridge edge types:
 * - `documents` — decision/learning explains a code file/function
 * - `bug_in` — error memory references a code location
 * - `test_covers` — test file/symbol covers a function
 * - `motivates` — pattern/decision motivates a code module
 */

import {
  createMemoryLink,
  hybridSearchMemories,
  getRecentMemories,
  getMemoryLinks,
} from '../storage/index.js';
import { getEmbedding } from '../embeddings.js';
import type { BridgeEdgeMetadata } from '../storage/types.js';
import { logInfo, logWarn } from '../fault-logger.js';

// ============================================================================
// Types
// ============================================================================

/** Bridge relation types (subset of LinkRelation for code ↔ knowledge) */
export const BRIDGE_RELATIONS = ['documents', 'bug_in', 'test_covers', 'motivates'] as const;
export type BridgeRelation = (typeof BRIDGE_RELATIONS)[number];

export interface BridgeEdgeResult {
  created: number;
  skipped: number;
  errors: number;
}

export interface CodeReference {
  path: string;
  symbol?: string;
  lineRange?: [number, number];
}

export interface MemoryCodeLinks {
  memoryId: number;
  codePaths: CodeReference[];
}

// ============================================================================
// File Path Detection
// ============================================================================

/**
 * Common source code file extensions for path detection.
 */
const CODE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|cs|cpp|c|h|hpp|vue|svelte|php|swift|scala|sh|bash|zsh|yaml|yml|json|toml|sql|graphql|proto|md)$/;

/**
 * Regex to detect file paths in memory content.
 * Matches patterns like:
 * - src/lib/auth.ts
 * - ./components/Button.tsx
 * - lib/storage/index.ts:42
 * - `path/to/file.py`
 */
const FILE_PATH_PATTERN =
  /(?:^|[\s`"'(,])((\.{0,2}\/)?(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)(?::(\d+))?/gm;

/**
 * Scan memory content for code file path references.
 */
export function extractCodePaths(content: string): CodeReference[] {
  const refs: CodeReference[] = [];
  const seen = new Set<string>();

  // Reset regex state
  FILE_PATH_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_PATTERN.exec(content)) !== null) {
    const path = match[1];
    // Must look like a code file
    if (!CODE_EXTENSIONS.test(path)) continue;
    // Skip duplicates
    if (seen.has(path)) continue;
    seen.add(path);

    const line = match[3] ? parseInt(match[3], 10) : undefined;
    refs.push({
      path,
      lineRange: line ? [line, line] : undefined,
    });
  }

  return refs;
}

/**
 * Detect if memory content is about a bug/error (for `bug_in` edges).
 */
function isBugRelated(content: string, tags: string[]): boolean {
  const bugKeywords =
    /\b(bug|error|fix|crash|exception|traceback|stack\s*trace|regression|broken|failed|failure)\b/i;
  return (
    bugKeywords.test(content) ||
    tags.some((t) => ['error', 'bug', 'fix', 'debug', 'dead_end'].includes(t))
  );
}

/**
 * Detect if memory content is about testing (for `test_covers` edges).
 */
function isTestRelated(content: string, tags: string[]): boolean {
  const testKeywords =
    /\b(tests?|specs?|coverage|assertions?|mocks?|stubs?|fixtures?|jest|vitest|pytest|mocha)\b/i;
  return testKeywords.test(content) || tags.some((t) => ['test', 'testing', 'spec'].includes(t));
}

/**
 * Infer the best bridge relation type based on memory content and tags.
 */
export function inferBridgeRelation(content: string, tags: string[]): BridgeRelation {
  if (isBugRelated(content, tags)) return 'bug_in';
  if (isTestRelated(content, tags)) return 'test_covers';
  // Check for motivational patterns (architecture decisions, design patterns)
  const motivatesKeywords =
    /\b(pattern|architecture|design|approach|strategy|convention|principle)\b/i;
  if (
    motivatesKeywords.test(content) ||
    tags.some((t) => ['pattern', 'architecture', 'decision'].includes(t))
  ) {
    return 'motivates';
  }
  return 'documents';
}

// ============================================================================
// Bridge Edge Creation
// ============================================================================

/**
 * Scan a memory for code path references and create bridge edges to
 * other memories that also reference the same code paths.
 *
 * @param memoryId - The memory to scan
 * @param content - Memory content text
 * @param tags - Memory tags
 */
export async function createBridgeEdgesForMemory(
  memoryId: number,
  content: string,
  tags: string[]
): Promise<BridgeEdgeResult> {
  const codePaths = extractCodePaths(content);
  if (codePaths.length === 0) {
    return { created: 0, skipped: 0, errors: 0 };
  }

  const relation = inferBridgeRelation(content, tags);
  let created = 0;
  let skipped = 0;
  let errors = 0;

  // For each code path found, search for other memories that reference it
  for (const ref of codePaths) {
    try {
      // Search for memories mentioning this file path
      const queryEmbed = await getEmbedding(ref.path);
      const related = await hybridSearchMemories(ref.path, queryEmbed, 10);

      for (const target of related) {
        if (target.id === memoryId) continue;

        // Check if target also mentions this code path
        if (!target.content.includes(ref.path)) continue;

        const metadata: BridgeEdgeMetadata = {
          code_path: ref.path,
          symbol_name: ref.symbol,
          line_range: ref.lineRange,
          detection: 'auto',
        };

        const result = await createMemoryLink(memoryId, target.id, relation, 0.7, {
          metadata: metadata as unknown as Record<string, unknown>,
        });

        if (result.created) {
          created++;
        } else {
          skipped++;
        }
      }
    } catch (error) {
      logWarn('bridge-edges', `Failed to create bridge edge for ${ref.path}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      errors++;
    }
  }

  if (created > 0) {
    logInfo(
      'bridge-edges',
      `Created ${created} bridge edges for memory #${memoryId} (${relation}, ${codePaths.length} code paths)`
    );
  }

  return { created, skipped, errors };
}

/**
 * Create a manual bridge edge between a memory and a code path.
 * Creates the link with explicit metadata about the code reference.
 */
export async function createManualBridgeEdge(
  sourceMemoryId: number,
  targetMemoryId: number,
  codePath: string,
  relation: BridgeRelation = 'documents',
  options?: {
    symbolName?: string;
    lineRange?: [number, number];
    weight?: number;
  }
): Promise<{ id: number; created: boolean }> {
  const metadata: BridgeEdgeMetadata = {
    code_path: codePath,
    symbol_name: options?.symbolName,
    line_range: options?.lineRange,
    detection: 'manual',
  };

  return createMemoryLink(sourceMemoryId, targetMemoryId, relation, options?.weight ?? 0.8, {
    metadata: metadata as unknown as Record<string, unknown>,
  });
}

/**
 * Find all memories connected to a given code path via bridge edges.
 * Searches both memory content and link metadata.
 */
export async function findMemoriesForCode(
  codePath: string,
  options?: { relation?: BridgeRelation; limit?: number }
): Promise<
  Array<{
    memoryId: number;
    content: string;
    relation: string;
    score: number;
  }>
> {
  const limit = options?.limit ?? 20;

  // Search memories that mention this code path
  const queryEmbed = await getEmbedding(codePath);
  const memories = await hybridSearchMemories(codePath, queryEmbed, limit);

  const results: Array<{
    memoryId: number;
    content: string;
    relation: string;
    score: number;
  }> = [];

  for (const mem of memories) {
    if (!mem.content.includes(codePath)) continue;

    // Check if this memory has bridge edges
    const links = await getMemoryLinks(mem.id);
    const bridgeLinks = [...links.outgoing, ...links.incoming].filter((l) => {
      if (options?.relation && l.relation !== options.relation) return false;
      return BRIDGE_RELATIONS.includes(l.relation as BridgeRelation);
    });

    // Determine the relation — from bridge links or inferred
    const relation =
      bridgeLinks.length > 0 ? bridgeLinks[0].relation : inferBridgeRelation(mem.content, mem.tags);

    results.push({
      memoryId: mem.id,
      content: mem.content,
      relation,
      score: mem.similarity ?? 0,
    });
  }

  return results.slice(0, limit);
}

/**
 * Scan all recent memories and create bridge edges for any that
 * reference code files. Used during batch processing / maintenance.
 *
 * @param limit - Max memories to scan (default: 100)
 */
export async function autoBridgeRecentMemories(limit: number = 100): Promise<BridgeEdgeResult> {
  const memories = await getRecentMemories(limit);

  const totals: BridgeEdgeResult = { created: 0, skipped: 0, errors: 0 };

  for (const mem of memories) {
    const codePaths = extractCodePaths(mem.content);
    if (codePaths.length === 0) continue;

    const result = await createBridgeEdgesForMemory(mem.id, mem.content, mem.tags);
    totals.created += result.created;
    totals.skipped += result.skipped;
    totals.errors += result.errors;
  }

  logInfo('bridge-edges', `Auto-bridge scan: ${totals.created} created, ${totals.skipped} skipped`);
  return totals;
}
