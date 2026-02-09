import { getDb } from './connection.js';
import { cosineSimilarity } from '../embeddings.js';
import { bufferToFloatArray } from './helpers.js';
import { triggerAutoExport } from '../graph-scheduler.js';
import { Memory, getMemoryById } from './memories.js';

// ============================================================================
// Knowledge Graph Types
// ============================================================================

export const LINK_RELATIONS = [
  'related',      // Generic relation
  'caused_by',    // A was caused by B
  'leads_to',     // A leads to B
  'similar_to',   // A is similar to B
  'contradicts',  // A contradicts B
  'implements',   // A implements B (decision → code)
  'supersedes',   // A supersedes/replaces B
  'references',   // A references B
] as const;

export type LinkRelation = (typeof LINK_RELATIONS)[number];

export interface MemoryLink {
  id: number;
  source_id: number;
  target_id: number;
  relation: LinkRelation;
  weight: number;
  // Temporal validity
  valid_from: string | null;  // When relationship became valid
  valid_until: string | null; // When relationship expired/was invalidated
  created_at: string;
}

export interface MemoryWithLinks extends Memory {
  outgoing_links: Array<{ target_id: number; relation: LinkRelation; weight: number; valid_from: string | null; valid_until: string | null }>;
  incoming_links: Array<{ source_id: number; relation: LinkRelation; weight: number; valid_from: string | null; valid_until: string | null }>;
}

// ============================================================================
// Memory Link Functions
// ============================================================================

/**
 * Create a link between two memories with optional temporal validity
 */
export function createMemoryLink(
  sourceId: number,
  targetId: number,
  relation: LinkRelation = 'related',
  weight: number = 1.0,
  options?: {
    validFrom?: string | Date;
    validUntil?: string | Date;
  }
): { id: number; created: boolean } {
  const database = getDb();

  // Convert Date objects to ISO strings
  const validFromStr = options?.validFrom
    ? (options.validFrom instanceof Date ? options.validFrom.toISOString() : options.validFrom)
    : null;
  const validUntilStr = options?.validUntil
    ? (options.validUntil instanceof Date ? options.validUntil.toISOString() : options.validUntil)
    : null;

  try {
    const result = database
      .prepare(`
        INSERT INTO memory_links (source_id, target_id, relation, weight, valid_from, valid_until)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(sourceId, targetId, relation, weight, validFromStr, validUntilStr);

    // Schedule auto-export if enabled (async, non-blocking)
    triggerAutoExport().catch(err => {
      console.warn('[graph] Auto-export failed:', err);
    });

    return { id: result.lastInsertRowid as number, created: true };
  } catch (error: any) {
    // Link already exists (UNIQUE constraint)
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existing = database
        .prepare('SELECT id FROM memory_links WHERE source_id = ? AND target_id = ? AND relation = ?')
        .get(sourceId, targetId, relation) as { id: number };
      return { id: existing.id, created: false };
    }
    throw error;
  }
}

/**
 * Delete a link between memories
 */
export function deleteMemoryLink(sourceId: number, targetId: number, relation?: LinkRelation): boolean {
  const database = getDb();

  if (relation) {
    const result = database
      .prepare('DELETE FROM memory_links WHERE source_id = ? AND target_id = ? AND relation = ?')
      .run(sourceId, targetId, relation);
    return result.changes > 0;
  } else {
    const result = database
      .prepare('DELETE FROM memory_links WHERE source_id = ? AND target_id = ?')
      .run(sourceId, targetId);
    return result.changes > 0;
  }
}

/**
 * Get all links for a memory (both directions)
 */
export function getMemoryLinks(memoryId: number): {
  outgoing: MemoryLink[];
  incoming: MemoryLink[];
} {
  const database = getDb();

  const outgoing = database
    .prepare('SELECT * FROM memory_links WHERE source_id = ?')
    .all(memoryId) as MemoryLink[];

  const incoming = database
    .prepare('SELECT * FROM memory_links WHERE target_id = ?')
    .all(memoryId) as MemoryLink[];

  return { outgoing, incoming };
}

/**
 * Get memory with its links (optionally filtered by validity at a point in time)
 */
export function getMemoryWithLinks(
  memoryId: number,
  options?: { asOfDate?: Date; includeExpired?: boolean }
): MemoryWithLinks | null {
  const memory = getMemoryById(memoryId);
  if (!memory) return null;

  const links = getMemoryLinks(memoryId);
  const now = options?.asOfDate?.getTime() ?? Date.now();
  const includeExpired = options?.includeExpired ?? false;

  // Filter links by validity period
  const filterLink = (link: MemoryLink) => {
    if (includeExpired) return true;
    if (link.valid_from) {
      const validFrom = new Date(link.valid_from).getTime();
      if (now < validFrom) return false;
    }
    if (link.valid_until) {
      const validUntil = new Date(link.valid_until).getTime();
      if (now > validUntil) return false;
    }
    return true;
  };

  return {
    ...memory,
    outgoing_links: links.outgoing.filter(filterLink).map(l => ({
      target_id: l.target_id,
      relation: l.relation as LinkRelation,
      weight: l.weight,
      valid_from: l.valid_from,
      valid_until: l.valid_until,
    })),
    incoming_links: links.incoming.filter(filterLink).map(l => ({
      source_id: l.source_id,
      relation: l.relation as LinkRelation,
      weight: l.weight,
      valid_from: l.valid_from,
      valid_until: l.valid_until,
    })),
  };
}

/**
 * Find related memories through links (graph traversal)
 * Returns memories connected within N hops
 */
export function findConnectedMemories(
  memoryId: number,
  maxDepth: number = 2
): Array<{ memory: Memory; depth: number; path: number[] }> {
  const database = getDb();
  const visited = new Set<number>([memoryId]);
  const results: Array<{ memory: Memory; depth: number; path: number[] }> = [];

  // BFS traversal
  let currentLevel = [{ id: memoryId, path: [memoryId] }];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextLevel: Array<{ id: number; path: number[] }> = [];

    for (const { id, path } of currentLevel) {
      // Get outgoing links
      const outgoing = database
        .prepare('SELECT target_id FROM memory_links WHERE source_id = ?')
        .all(id) as Array<{ target_id: number }>;

      // Get incoming links
      const incoming = database
        .prepare('SELECT source_id FROM memory_links WHERE target_id = ?')
        .all(id) as Array<{ source_id: number }>;

      const neighbors = [
        ...outgoing.map(r => r.target_id),
        ...incoming.map(r => r.source_id),
      ];

      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          const memory = getMemoryById(neighborId);
          if (memory) {
            const newPath = [...path, neighborId];
            results.push({ memory, depth, path: newPath });
            nextLevel.push({ id: neighborId, path: newPath });
          }
        }
      }
    }

    currentLevel = nextLevel;
  }

  return results;
}

// ============================================================================
// Auto-Linking Functions
// ============================================================================

/**
 * Find related memories for auto-linking based on embedding similarity
 */
export function findRelatedMemoriesForLinking(
  memoryId: number,
  threshold: number = 0.75,
  maxLinks: number = 3
): Array<{ id: number; similarity: number }> {
  const database = getDb();

  const source = database
    .prepare('SELECT id, embedding FROM memories WHERE id = ?')
    .get(memoryId) as { id: number; embedding: Buffer } | undefined;

  if (!source) return [];

  const sourceEmbedding = bufferToFloatArray(source.embedding);

  const memories = database
    .prepare('SELECT id, embedding FROM memories WHERE id != ?')
    .all(memoryId) as Array<{ id: number; embedding: Buffer }>;

  const similarities: Array<{ id: number; similarity: number }> = [];

  for (const target of memories) {
    const targetEmbedding = bufferToFloatArray(target.embedding);
    const similarity = cosineSimilarity(sourceEmbedding, targetEmbedding);

    if (similarity >= threshold) {
      similarities.push({ id: target.id, similarity });
    }
  }

  // Sort by similarity and take top N
  similarities.sort((a, b) => b.similarity - a.similarity);
  return similarities.slice(0, maxLinks);
}

/**
 * Create auto-links for a specific memory
 */
export function createAutoLinks(
  memoryId: number,
  threshold: number = 0.75,
  maxLinks: number = 3
): number {
  const candidates = findRelatedMemoriesForLinking(memoryId, threshold, maxLinks);

  let linksCreated = 0;
  for (const { id: targetId, similarity } of candidates) {
    const result = createMemoryLink(memoryId, targetId, 'similar_to', similarity);
    if (result.created) {
      linksCreated++;
    }
  }

  return linksCreated;
}

/**
 * Auto-link similar memories based on embedding similarity
 * Useful for building initial graph structure
 */
export function autoLinkSimilarMemories(
  threshold: number = 0.75,
  maxLinks: number = 3
): number {
  const database = getDb();

  const memories = database
    .prepare('SELECT id, embedding FROM memories')
    .all() as Array<{ id: number; embedding: Buffer }>;

  let linksCreated = 0;

  for (let i = 0; i < memories.length; i++) {
    const source = memories[i];
    const sourceEmbedding = bufferToFloatArray(source.embedding);

    const similarities: Array<{ id: number; similarity: number }> = [];

    for (let j = 0; j < memories.length; j++) {
      if (i === j) continue;

      const target = memories[j];
      const targetEmbedding = bufferToFloatArray(target.embedding);
      const similarity = cosineSimilarity(sourceEmbedding, targetEmbedding);

      if (similarity >= threshold) {
        similarities.push({ id: target.id, similarity });
      }
    }

    // Sort by similarity and take top N
    similarities.sort((a, b) => b.similarity - a.similarity);
    const topSimilar = similarities.slice(0, maxLinks);

    for (const { id: targetId, similarity } of topSimilar) {
      const result = createMemoryLink(source.id, targetId, 'similar_to', similarity);
      if (result.created) {
        linksCreated++;
      }
    }
  }

  return linksCreated;
}

// ============================================================================
// Graph Statistics
// ============================================================================

/**
 * Get graph statistics
 */
export function getGraphStats(): {
  total_memories: number;
  total_links: number;
  avg_links_per_memory: number;
  isolated_memories: number;
  relations: Record<string, number>;
} {
  const database = getDb();

  const totalMemories = (database
    .prepare('SELECT COUNT(*) as count FROM memories')
    .get() as { count: number }).count;

  const totalLinks = (database
    .prepare('SELECT COUNT(*) as count FROM memory_links')
    .get() as { count: number }).count;

  // Count memories with no links
  const isolatedCount = (database
    .prepare(`
      SELECT COUNT(*) as count FROM memories m
      WHERE NOT EXISTS (SELECT 1 FROM memory_links WHERE source_id = m.id OR target_id = m.id)
    `)
    .get() as { count: number }).count;

  // Count by relation type
  const relationCounts = database
    .prepare('SELECT relation, COUNT(*) as count FROM memory_links GROUP BY relation')
    .all() as Array<{ relation: string; count: number }>;

  const relations: Record<string, number> = {};
  for (const row of relationCounts) {
    relations[row.relation] = row.count;
  }

  return {
    total_memories: totalMemories,
    total_links: totalLinks,
    avg_links_per_memory: totalMemories > 0 ? totalLinks / totalMemories : 0,
    isolated_memories: isolatedCount,
    relations,
  };
}

// ============================================================================
// Temporal Graph Functions
// ============================================================================

/**
 * Invalidate a memory link by setting valid_until to now.
 * This is the "soft delete" approach for temporal graphs - we keep the link
 * for historical queries but it won't appear in current-time queries.
 */
export function invalidateMemoryLink(
  sourceId: number,
  targetId: number,
  relation?: LinkRelation
): boolean {
  const database = getDb();
  const now = new Date().toISOString();

  if (relation) {
    const result = database
      .prepare('UPDATE memory_links SET valid_until = ? WHERE source_id = ? AND target_id = ? AND relation = ? AND valid_until IS NULL')
      .run(now, sourceId, targetId, relation);
    return result.changes > 0;
  } else {
    const result = database
      .prepare('UPDATE memory_links SET valid_until = ? WHERE source_id = ? AND target_id = ? AND valid_until IS NULL')
      .run(now, sourceId, targetId);
    return result.changes > 0;
  }
}

/**
 * Get memory links as of a specific point in time
 */
export function getMemoryLinksAsOf(
  memoryId: number,
  asOfDate: Date
): {
  outgoing: MemoryLink[];
  incoming: MemoryLink[];
} {
  const database = getDb();
  const asOfStr = asOfDate.toISOString();

  const outgoing = database
    .prepare(`
      SELECT * FROM memory_links
      WHERE source_id = ?
        AND created_at <= ?
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (valid_until IS NULL OR valid_until > ?)
    `)
    .all(memoryId, asOfStr, asOfStr, asOfStr) as MemoryLink[];

  const incoming = database
    .prepare(`
      SELECT * FROM memory_links
      WHERE target_id = ?
        AND created_at <= ?
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (valid_until IS NULL OR valid_until > ?)
    `)
    .all(memoryId, asOfStr, asOfStr, asOfStr) as MemoryLink[];

  return { outgoing, incoming };
}

/**
 * Find connected memories as of a specific point in time
 */
export function findConnectedMemoriesAsOf(
  memoryId: number,
  asOfDate: Date,
  maxDepth: number = 2
): Array<{ memory: Memory; depth: number; path: number[] }> {
  const database = getDb();
  const asOfStr = asOfDate.toISOString();
  const visited = new Set<number>([memoryId]);
  const results: Array<{ memory: Memory; depth: number; path: number[] }> = [];

  // BFS traversal
  let currentLevel = [{ id: memoryId, path: [memoryId] }];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextLevel: Array<{ id: number; path: number[] }> = [];

    for (const { id, path } of currentLevel) {
      // Get outgoing links that were valid at that time
      const outgoing = database
        .prepare(`
          SELECT target_id FROM memory_links
          WHERE source_id = ?
            AND created_at <= ?
            AND (valid_from IS NULL OR valid_from <= ?)
            AND (valid_until IS NULL OR valid_until > ?)
        `)
        .all(id, asOfStr, asOfStr, asOfStr) as Array<{ target_id: number }>;

      // Get incoming links that were valid at that time
      const incoming = database
        .prepare(`
          SELECT source_id FROM memory_links
          WHERE target_id = ?
            AND created_at <= ?
            AND (valid_from IS NULL OR valid_from <= ?)
            AND (valid_until IS NULL OR valid_until > ?)
        `)
        .all(id, asOfStr, asOfStr, asOfStr) as Array<{ source_id: number }>;

      const neighbors = [
        ...outgoing.map(r => r.target_id),
        ...incoming.map(r => r.source_id),
      ];

      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          const memory = getMemoryById(neighborId);
          if (memory) {
            const newPath = [...path, neighborId];
            results.push({ memory, depth, path: newPath });
            nextLevel.push({ id: neighborId, path: newPath });
          }
        }
      }
    }

    currentLevel = nextLevel;
  }

  return results;
}

/**
 * Get graph snapshot at a specific point in time.
 * This is the core of temporal knowledge graphs - ability to query historical state.
 *
 * @param asOfDate - The point in time to query
 * @returns Graph stats at that point in time
 */
export function getGraphStatsAsOf(asOfDate: Date): {
  total_memories: number;
  total_links: number;
  avg_links_per_memory: number;
  relations: Record<string, number>;
} {
  const database = getDb();
  const asOfStr = asOfDate.toISOString();

  // Count memories that existed at that time
  const totalMemories = (database
    .prepare('SELECT COUNT(*) as count FROM memories WHERE created_at <= ?')
    .get(asOfStr) as { count: number }).count;

  // Count links that were valid at that time
  const totalLinks = (database
    .prepare(`
      SELECT COUNT(*) as count FROM memory_links
      WHERE created_at <= ?
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (valid_until IS NULL OR valid_until > ?)
    `)
    .get(asOfStr, asOfStr, asOfStr) as { count: number }).count;

  // Count by relation type at that time
  const relationCounts = database
    .prepare(`
      SELECT relation, COUNT(*) as count FROM memory_links
      WHERE created_at <= ?
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (valid_until IS NULL OR valid_until > ?)
      GROUP BY relation
    `)
    .all(asOfStr, asOfStr, asOfStr) as Array<{ relation: string; count: number }>;

  const relations: Record<string, number> = {};
  for (const row of relationCounts) {
    relations[row.relation] = row.count;
  }

  return {
    total_memories: totalMemories,
    total_links: totalLinks,
    avg_links_per_memory: totalMemories > 0 ? totalLinks / totalMemories : 0,
    relations,
  };
}
