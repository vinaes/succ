/**
 * Contextual Proximity — co-occurrence linking
 *
 * Memories that share the same source (session, file, context) are related.
 * Inspired by rahulnyk/knowledge_graph's contextual proximity approach:
 * self-join by source → co-occurrence matrix → weighted edges.
 */

import { getAllMemoriesForExport, getMemoryLinks, createMemoryLink } from '../storage/index.js';

// ============================================================================
// Source Normalization
// ============================================================================

/**
 * Normalize a source string to group similar sources together.
 * - File paths → parent directory
 * - Session IDs → keep as-is
 * - Generic sources → keep as-is
 */
export function normalizeSource(source: string): string {
  if (!source) return '';

  const trimmed = source.trim();

  // File paths: normalize to directory
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    const parts = trimmed.replace(/\\/g, '/').split('/');
    // Remove filename, keep directory
    if (parts.length > 1 && parts[parts.length - 1].includes('.')) {
      return parts.slice(0, -1).join('/');
    }
    return trimmed.replace(/\\/g, '/');
  }

  return trimmed.toLowerCase();
}

// ============================================================================
// Proximity Calculation
// ============================================================================

/**
 * Calculate co-occurrence matrix from memory sources.
 * Returns pairs of memory IDs that share the same normalized source,
 * with count = number of shared sources.
 */
export function calculateProximity(
  memories: Array<{ id: number; source: string | null }>
): Array<{ node_1: number; node_2: number; count: number; sources: string[] }> {
  // Group memories by normalized source
  const sourceGroups = new Map<string, number[]>();

  for (const mem of memories) {
    if (!mem.source) continue;
    const normalized = normalizeSource(mem.source);
    if (!normalized) continue;

    const group = sourceGroups.get(normalized) ?? [];
    group.push(mem.id);
    sourceGroups.set(normalized, group);
  }

  // Build co-occurrence pairs
  const pairMap = new Map<
    string,
    { node_1: number; node_2: number; count: number; sources: string[] }
  >();

  for (const [source, ids] of sourceGroups) {
    if (ids.length < 2) continue;

    // Generate all pairs within this source group
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = Math.min(ids[i], ids[j]);
        const b = Math.max(ids[i], ids[j]);
        const key = `${a}:${b}`;

        const existing = pairMap.get(key);
        if (existing) {
          existing.count++;
          if (!existing.sources.includes(source)) {
            existing.sources.push(source);
          }
        } else {
          pairMap.set(key, { node_1: a, node_2: b, count: 1, sources: [source] });
        }
      }
    }
  }

  return Array.from(pairMap.values());
}

// ============================================================================
// Link Creation
// ============================================================================

/**
 * Create proximity-based links from co-occurrence data.
 * Skips pairs that already have any link between them.
 */
export async function createProximityLinks(
  options: { minCooccurrence?: number; dryRun?: boolean } = {}
): Promise<{ created: number; skipped: number; total_pairs: number }> {
  const { minCooccurrence = 2, dryRun = false } = options;

  // Get all non-invalidated memories with sources via storage
  const allMemories = await getAllMemoriesForExport();
  const memories = allMemories
    .filter((m) => m.source && !m.invalidated_by)
    .map((m) => ({ id: m.id, source: m.source }));

  const pairs = calculateProximity(memories);

  // Filter by min co-occurrence
  const filtered = pairs.filter((p) => p.count >= minCooccurrence);

  if (dryRun) {
    return { created: 0, skipped: 0, total_pairs: filtered.length };
  }

  // Find max count for weight normalization
  const maxCount = Math.max(1, ...filtered.map((p) => p.count));

  let created = 0;
  let skipped = 0;

  for (const pair of filtered) {
    // Check if any link already exists between these two memories
    const linksA = await getMemoryLinks(pair.node_1);
    const hasLink =
      linksA.outgoing?.some((l: any) => l.target_id === pair.node_2) ||
      linksA.incoming?.some((l: any) => l.source_id === pair.node_2);

    if (hasLink) {
      skipped++;
      continue;
    }

    // Normalized weight: count / maxCount
    const weight = pair.count / maxCount;
    const result = await createMemoryLink(pair.node_1, pair.node_2, 'related', weight);
    if (result.created) {
      created++;
    } else {
      skipped++;
    }
  }

  return { created, skipped, total_pairs: filtered.length };
}
