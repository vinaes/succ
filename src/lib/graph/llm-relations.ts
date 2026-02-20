/**
 * LLM Relation Extraction — classify link types using LLM
 *
 * Instead of blind "similar_to" links, uses LLM to determine
 * the actual relationship between memories (caused_by, leads_to, etc.)
 *
 * Inspired by rahulnyk/knowledge_graph's approach of using LLM
 * to extract ontological relationships from text.
 */

import { callLLM } from '../llm.js';
import { LINK_RELATIONS, type LinkRelation } from '../storage/types.js';
import {
  getAllMemoryLinksForExport,
  getMemoryById,
  updateMemoryLink,
  getMemoryLinks,
} from '../storage/index.js';

// ============================================================================
// Relation Classification
// ============================================================================

const CLASSIFY_SYSTEM = `Given memories from a knowledge base, determine their relationship.

Choose ONE relation from: caused_by, leads_to, contradicts, implements, supersedes, references, related, similar_to

Rules:
- caused_by: A was caused by or resulted from B
- leads_to: A leads to or enables B
- contradicts: A and B conflict or disagree
- implements: A is an implementation/action based on B (a decision)
- supersedes: A replaces or updates B
- references: A mentions or cites B
- related: connected but none of the above fit
- similar_to: nearly identical content (keep only if truly duplicate-like)`;

const CLASSIFY_PROMPT_SINGLE = `Memory A (type: {typeA}): {contentA}

Memory B (type: {typeB}): {contentB}

Reply with ONLY valid JSON: {"relation": "...", "confidence": 0.0-1.0}`;

const CLASSIFY_PROMPT_BATCH = `{pairs}

Reply with ONLY a valid JSON array: [{"pair": 1, "relation": "...", "confidence": 0.0-1.0}, ...]`;

interface MemoryInfo {
  id: number;
  content: string;
  type: string;
  tags: string[];
}

interface ClassifyResult {
  relation: LinkRelation;
  confidence: number;
}

/**
 * Classify the relation between two memories using LLM.
 */
export async function classifyRelation(
  memoryA: MemoryInfo,
  memoryB: MemoryInfo
): Promise<ClassifyResult> {
  const prompt = CLASSIFY_PROMPT_SINGLE.replace('{typeA}', memoryA.type)
    .replace('{contentA}', memoryA.content.substring(0, 500))
    .replace('{typeB}', memoryB.type)
    .replace('{contentB}', memoryB.content.substring(0, 500));

  try {
    const response = await callLLM(prompt, {
      maxTokens: 100,
      temperature: 0.1,
      systemPrompt: CLASSIFY_SYSTEM,
    });
    return parseClassifyResponse(response);
  } catch {
    return { relation: 'similar_to', confidence: 0 };
  }
}

/**
 * Classify multiple pairs in a single LLM call (saves tokens).
 */
export async function classifyRelationsBatch(
  pairs: Array<{ a: MemoryInfo; b: MemoryInfo; linkId: number }>
): Promise<Array<{ linkId: number; relation: LinkRelation; confidence: number }>> {
  if (pairs.length === 0) return [];

  // Build pairs text
  const pairsText = pairs
    .map((p, i) => {
      return `Pair ${i + 1}:
  Memory A (type: ${p.a.type}): ${p.a.content.substring(0, 300)}
  Memory B (type: ${p.b.type}): ${p.b.content.substring(0, 300)}`;
    })
    .join('\n\n');

  const prompt = CLASSIFY_PROMPT_BATCH.replace('{pairs}', pairsText);

  try {
    const response = await callLLM(prompt, {
      maxTokens: 50 * pairs.length,
      temperature: 0.1,
      systemPrompt: CLASSIFY_SYSTEM,
    });
    return parseBatchResponse(response, pairs);
  } catch {
    // Fallback: keep all as similar_to
    return pairs.map((p) => ({
      linkId: p.linkId,
      relation: 'similar_to' as LinkRelation,
      confidence: 0,
    }));
  }
}

// ============================================================================
// Enrichment Pipeline
// ============================================================================

/**
 * Enrich all existing similar_to links that haven't been LLM-enriched yet.
 */
export async function enrichExistingLinks(
  options: { force?: boolean; limit?: number; batchSize?: number } = {}
): Promise<{ enriched: number; failed: number; skipped: number }> {
  const { force = false, limit, batchSize = 5 } = options;

  // Get all links via storage
  const allLinks = await getAllMemoryLinksForExport();

  // Filter to similar_to links, optionally unenriched only
  let links = allLinks.filter((l) => l.relation === 'similar_to');
  if (!force) {
    interface LinkWithEnrichment {
      llm_enriched?: boolean;
    }
    links = links.filter((l) => !(l as LinkWithEnrichment).llm_enriched);
  }
  if (limit) {
    links = links.slice(0, limit);
  }

  if (links.length === 0) {
    return { enriched: 0, failed: 0, skipped: 0 };
  }

  // Prefetch all needed memories
  const memoryIds = new Set<number>();
  for (const link of links) {
    memoryIds.add(link.source_id);
    memoryIds.add(link.target_id);
  }

  const memories = new Map<number, MemoryInfo>();
  for (const id of memoryIds) {
    const mem = await getMemoryById(id);
    if (mem) {
      const tags: string[] = Array.isArray(mem.tags)
        ? mem.tags
        : typeof mem.tags === 'string'
          ? (() => {
              try {
                return JSON.parse(mem.tags as string);
              } catch {
                return [];
              }
            })()
          : [];
      memories.set(id, { id: mem.id, content: mem.content, type: mem.type || 'observation', tags });
    }
  }

  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  // Process in batches
  for (let i = 0; i < links.length; i += batchSize) {
    const batch = links.slice(i, i + batchSize);

    const pairs = batch
      .map((link) => {
        const a = memories.get(link.source_id);
        const b = memories.get(link.target_id);
        if (!a || !b) return null;
        return { a, b, linkId: link.id };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    if (pairs.length === 0) {
      skipped += batch.length;
      continue;
    }

    let results: Array<{ linkId: number; relation: LinkRelation; confidence: number }>;

    if (pairs.length === 1) {
      // Single pair: use direct classification
      const result = await classifyRelation(pairs[0].a, pairs[0].b);
      results = [
        { linkId: pairs[0].linkId, relation: result.relation, confidence: result.confidence },
      ];
    } else {
      // Batch classification
      results = await classifyRelationsBatch(pairs);
    }

    // Apply results via storage
    for (const result of results) {
      if (result.confidence > 0) {
        await updateMemoryLink(result.linkId, {
          relation: result.relation,
          weight: result.confidence,
          llmEnriched: true,
        });
        enriched++;
      } else {
        // Mark as enriched but keep similar_to
        await updateMemoryLink(result.linkId, { llmEnriched: true });
        failed++;
      }
    }
  }

  return { enriched, failed, skipped };
}

/**
 * Enrich links for a single memory (called async after auto-link).
 */
export async function enrichMemoryLinks(memoryId: number): Promise<number> {
  const links = await getMemoryLinks(memoryId);
  const unenriched = (links.outgoing || []).filter(
    (l: any) => l.relation === 'similar_to' && !l.llm_enriched
  );

  if (unenriched.length === 0) return 0;

  const result = await enrichExistingLinks({
    limit: unenriched.length,
    batchSize: unenriched.length,
  });

  return result.enriched;
}

// ============================================================================
// Response Parsing
// ============================================================================

function parseClassifyResponse(response: string): ClassifyResult {
  try {
    // Extract JSON from response (may have extra text around it)
    const jsonMatch = response.match(/\{[^}]+\}/);
    if (!jsonMatch) return { relation: 'similar_to', confidence: 0 };

    const parsed = JSON.parse(jsonMatch[0]);
    const relation = validateRelation(parsed.relation);
    const confidence =
      typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;

    return { relation, confidence };
  } catch {
    return { relation: 'similar_to', confidence: 0 };
  }
}

function parseBatchResponse(
  response: string,
  pairs: Array<{ a: MemoryInfo; b: MemoryInfo; linkId: number }>
): Array<{ linkId: number; relation: LinkRelation; confidence: number }> {
  try {
    // Extract JSON array from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return pairs.map((p) => ({
        linkId: p.linkId,
        relation: 'similar_to' as LinkRelation,
        confidence: 0,
      }));
    }

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      pair: number;
      relation: string;
      confidence: number;
    }>;

    return pairs.map((p, i) => {
      const result = parsed.find((r) => r.pair === i + 1) || parsed[i];
      if (!result)
        return { linkId: p.linkId, relation: 'similar_to' as LinkRelation, confidence: 0 };

      return {
        linkId: p.linkId,
        relation: validateRelation(result.relation),
        confidence:
          typeof result.confidence === 'number' ? Math.max(0, Math.min(1, result.confidence)) : 0.5,
      };
    });
  } catch {
    return pairs.map((p) => ({
      linkId: p.linkId,
      relation: 'similar_to' as LinkRelation,
      confidence: 0,
    }));
  }
}

function validateRelation(input: string): LinkRelation {
  const normalized = (input || '').toLowerCase().trim();
  if (LINK_RELATIONS.includes(normalized as LinkRelation)) {
    return normalized as LinkRelation;
  }
  return 'related';
}
