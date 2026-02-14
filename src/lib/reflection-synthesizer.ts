/**
 * Reflection Synthesizer
 *
 * Reads community clusters from the memory graph and synthesizes
 * pattern/learning memories from unreflected observations.
 *
 * Plugs into daemon's handleReflection() between community detection
 * and centrality cache update.
 */

import { callLLM } from './llm.js';
import { getEmbedding } from './embeddings.js';
import {
  saveMemory,
  getMemoryById,
  updateMemoryTags,
  findSimilarMemory,
  incrementCorrectionCount,
} from './storage/index.js';
import type { CommunityResult } from './graph/community-detection.js';

const SYNTHESIS_PROMPT = `You are analyzing a cluster of related observations from a developer's coding sessions.

Observations:
{observations}

Based on these observations, extract 1-3 high-level patterns, preferences, or learnings.
Each should be a clear, concise statement that captures recurring behavior or important context.

Rules:
- Only output patterns that emerge from MULTIPLE observations
- Be specific: include tool names, language preferences, workflow patterns
- Do NOT repeat individual observations — synthesize them
- If observations are too diverse to synthesize, output "NO_PATTERNS"

Output as JSON array:
[{"content": "...", "type": "pattern|learning"}]`;

const MIN_CLUSTER_SIZE = 5;
const MAX_OBSERVATIONS_PER_SYNTHESIS = 15;

/** Semantic dedup threshold for synthesized reflections.
 *  Lower than saveMemory's 0.92 to catch LLM paraphrases of the same insight. */
const SYNTHESIS_DEDUP_THRESHOLD = 0.8;

export interface SynthesisResult {
  clustersProcessed: number;
  patternsCreated: number;
  duplicatesSkipped: number;
  reinforced: number;
  observationsMarked: number;
  errors: string[];
}

/**
 * Synthesize patterns from community clusters.
 * Only processes clusters with enough unreflected observations.
 */
export async function synthesizeFromCommunities(
  communityResult: CommunityResult,
  options: { dryRun?: boolean; log?: (msg: string) => void } = {}
): Promise<SynthesisResult> {
  const { dryRun = false, log = () => {} } = options;
  const result: SynthesisResult = {
    clustersProcessed: 0,
    patternsCreated: 0,
    duplicatesSkipped: 0,
    reinforced: 0,
    observationsMarked: 0,
    errors: [],
  };

  // Filter to clusters large enough to synthesize
  const eligibleClusters = communityResult.communities.filter((c) => c.size >= MIN_CLUSTER_SIZE);

  if (eligibleClusters.length === 0) {
    log('[synthesizer] No clusters large enough for synthesis');
    return result;
  }

  for (const cluster of eligibleClusters) {
    try {
      // Load memories for this cluster
      const memories: Array<{ id: number; content: string; tags: string[]; type: string }> = [];
      for (const memId of cluster.members.slice(0, MAX_OBSERVATIONS_PER_SYNTHESIS)) {
        const mem = await getMemoryById(memId);
        if (mem && mem.type === 'observation') {
          const tags = Array.isArray(mem.tags)
            ? mem.tags
            : typeof mem.tags === 'string'
              ? JSON.parse(mem.tags || '[]')
              : [];
          // Skip already-reflected observations
          if (!tags.includes('reflected')) {
            memories.push({ id: mem.id, content: mem.content, tags, type: mem.type });
          }
        }
      }

      if (memories.length < MIN_CLUSTER_SIZE) continue;

      // Build observation text
      const observationText = memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n');

      const prompt = SYNTHESIS_PROMPT.replace('{observations}', observationText);

      const llmResponse = await callLLM(prompt, {
        timeout: 30000,
        useSleepAgent: true,
        maxTokens: 1000,
        temperature: 0.3,
      });

      if (llmResponse.includes('NO_PATTERNS')) {
        log(`[synthesizer] Cluster ${cluster.id}: no patterns found`);
        continue;
      }

      // Parse JSON response
      const jsonMatch = llmResponse.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) {
        result.errors.push(`Cluster ${cluster.id}: failed to parse LLM response`);
        continue;
      }

      const patterns: Array<{ content: string; type: string }> = JSON.parse(jsonMatch[0]);
      result.clustersProcessed++;

      for (const pattern of patterns) {
        if (!pattern.content || pattern.content.length < 20) continue;

        if (!dryRun) {
          const embedding = await getEmbedding(pattern.content);

          // Semantic dedup: check if a similar memory already exists (0.80 threshold
          // catches LLM paraphrases that saveMemory's 0.92 dedup would miss)
          const existing = await findSimilarMemory(embedding, SYNTHESIS_DEDUP_THRESHOLD);
          if (existing) {
            // Reinforce patterns/learnings — increment correction_count so they
            // eventually pin (Tier 1) if the daemon keeps seeing the same insight.
            // Skip observations — they're too noisy to reinforce automatically.
            const existingMem = await getMemoryById(existing.id);
            const existingType = existingMem?.type;
            if (existingType === 'pattern' || existingType === 'learning') {
              await incrementCorrectionCount(existing.id);
              result.reinforced++;
              log(
                `[synthesizer] Reinforced existing ${existingType} #${existing.id} (sim=${existing.similarity.toFixed(2)}): ${existing.content.substring(0, 60)}...`
              );
            } else {
              result.duplicatesSkipped++;
              log(
                `[synthesizer] Skipped duplicate ${existingType ?? 'unknown'} (sim=${existing.similarity.toFixed(2)}): ${pattern.content.substring(0, 60)}...`
              );
            }
            continue;
          }

          const memType = pattern.type === 'learning' ? 'learning' : 'pattern';
          await saveMemory(
            pattern.content,
            embedding,
            ['reflection', 'synthesized'],
            'reflection',
            {
              qualityScore: { score: 0.7, factors: { synthesized: 1 } },
              type: memType,
            }
          );
          result.patternsCreated++;
          log(`[synthesizer] Created ${memType}: ${pattern.content.substring(0, 80)}...`);
        }
      }

      // Mark source observations as 'reflected' so they aren't re-synthesized
      if (!dryRun) {
        for (const mem of memories) {
          try {
            const newTags = [...mem.tags, 'reflected'];
            await updateMemoryTags(mem.id, newTags);
            result.observationsMarked++;
          } catch {
            // Non-critical — worst case we re-process next cycle
          }
        }
      }
    } catch (err) {
      result.errors.push(`Cluster ${cluster.id}: ${err}`);
    }
  }

  return result;
}
