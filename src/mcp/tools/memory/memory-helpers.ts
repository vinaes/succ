import path from 'path';
import {
  saveMemory,
  saveMemoriesBatch,
  saveGlobalMemory,
  closeDb,
  closeGlobalDb,
} from '../../../lib/storage/index.js';
import type { MemoryBatchInput } from '../../../lib/storage/index.js';
import { getConfig, getProjectRoot, getIdleReflectionConfig } from '../../../lib/config.js';
import { getEmbedding } from '../../../lib/embeddings.js';
import { scoreMemory, passesQualityThreshold, formatQualityScore } from '../../../lib/quality.js';
import { scanSensitive, formatMatches } from '../../../lib/sensitive-filter.js';
import { parseDuration } from '../../../lib/temporal.js';
import { extractFactsWithLLM } from '../../../lib/session-summary.js';
import { logWarn } from '../../../lib/fault-logger.js';

export interface MemoryToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export async function rememberWithLLMExtraction(params: {
  content: string;
  tags: string[];
  source?: string;
  type: 'observation' | 'decision' | 'learning' | 'error' | 'pattern' | 'dead_end';
  useGlobal: boolean;
  valid_from?: string;
  valid_until?: string;
  config: ReturnType<typeof getConfig>;
}): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { content, tags, source, useGlobal, valid_from, valid_until, config } = params;
  const idleConfig = getIdleReflectionConfig();

  // Determine LLM options (default to Claude CLI)
  const llmOptions: {
    mode: 'claude' | 'api';
    model?: string;
    apiUrl?: string;
    apiKey?: string;
  } = {
    mode: 'claude',
    model: idleConfig.agent_model || 'haiku',
  };

  try {
    // Extract facts from content
    const facts = await extractFactsWithLLM(content, llmOptions);

    if (facts.length === 0) {
      // No facts extracted, fall back to saving original content
      return await saveSingleMemory({
        content,
        tags,
        source,
        type: params.type,
        useGlobal,
        valid_from,
        valid_until,
        config,
      });
    }

    // Parse temporal validity periods once
    let validFromDate: Date | undefined;
    let validUntilDate: Date | undefined;
    if (valid_from) {
      validFromDate = parseDuration(valid_from);
    }
    if (valid_until) {
      validUntilDate = parseDuration(valid_until);
    }

    // Snapshot before for learning delta
    let snapshotBefore: import('../../../lib/learning-delta.js').MemorySnapshot | null = null;
    try {
      const { takeMemorySnapshot } = await import('../../../lib/learning-delta.js');
      snapshotBefore = await takeMemorySnapshot();
    } catch (error) {
      logWarn('mcp-memory', 'Unable to take memory snapshot before extraction save', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let saved = 0;
    let skipped = 0;
    const results: string[] = [];

    // Phase 1: Pre-process all facts (sensitive filter, embedding, quality scoring)
    const prepared: Array<{
      fact: (typeof facts)[0];
      content: string;
      embedding: number[];
      tags: string[];
      qualityScore: { score: number; factors: Record<string, any> } | null;
    }> = [];

    for (const fact of facts) {
      let factContent = fact.content;

      // Check for sensitive information
      if (config.sensitive_filter_enabled !== false) {
        const scanResult = scanSensitive(factContent);
        if (scanResult.hasSensitive) {
          if (config.sensitive_auto_redact) {
            factContent = scanResult.redactedText;
          } else {
            results.push(
              `⚠ [${fact.type}] Skipped (sensitive): "${fact.content.substring(0, 40)}..."`
            );
            skipped++;
            continue;
          }
        }
      }

      try {
        const embedding = await getEmbedding(factContent);
        // Merge file:{basename} tags from LLM-extracted file references
        const fileTags = fact.files?.length
          ? fact.files.map((f: string) => `file:${path.basename(f)}`)
          : [];
        const factTags = [...new Set([...tags, ...fact.tags, ...fileTags, fact.type, 'extracted'])];

        // Score quality
        let qualityScore = null;
        if (config.quality_scoring_enabled !== false) {
          qualityScore = await scoreMemory(factContent);
          if (!passesQualityThreshold(qualityScore)) {
            results.push(
              `⚠ [${fact.type}] Skipped (low quality): "${fact.content.substring(0, 40)}..."`
            );
            skipped++;
            continue;
          }
        }

        prepared.push({ fact, content: factContent, embedding, tags: factTags, qualityScore });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logWarn('mcp-memory', `Error preparing fact for save: ${fact.type}`, { error: errorMsg });
        results.push(`✗ [${fact.type}] Error: ${errorMsg}`);
        skipped++;
      }
    }

    // Phase 2: Batch save
    if (useGlobal) {
      // Global memories don't have batch API — save individually
      for (const item of prepared) {
        const projectName = path.basename(getProjectRoot());
        const result = await saveGlobalMemory(
          item.content,
          item.embedding,
          item.tags,
          source || 'extraction',
          projectName,
          { type: item.fact.type }
        );
        if (result.isDuplicate) {
          results.push(
            `⚠ [${item.fact.type}] Duplicate: "${item.fact.content.substring(0, 40)}..."`
          );
          skipped++;
        } else {
          results.push(
            `✓ [${item.fact.type}] id:${result.id} "${item.fact.content.substring(0, 50)}..."`
          );
          saved++;
        }
      }
    } else if (prepared.length > 0) {
      // Local memories — use batch save (single dedup check + transaction)
      const batchInputs: MemoryBatchInput[] = prepared.map((item) => ({
        content: item.content,
        embedding: item.embedding,
        tags: item.tags,
        type: item.fact.type,
        source: source || 'extraction',
        qualityScore: item.qualityScore
          ? { score: item.qualityScore.score, factors: item.qualityScore.factors }
          : undefined,
        validFrom: validFromDate,
        validUntil: validUntilDate,
      }));

      const batchResult = await saveMemoriesBatch(batchInputs);

      for (let i = 0; i < batchResult.results.length; i++) {
        const r = batchResult.results[i];
        const item = prepared[r.index];
        if (r.isDuplicate) {
          results.push(
            `⚠ [${item.fact.type}] Duplicate: "${item.fact.content.substring(0, 40)}..."`
          );
          skipped++;
        } else {
          results.push(
            `✓ [${item.fact.type}] id:${r.id} "${item.fact.content.substring(0, 50)}..."`
          );
          saved++;
        }
      }
    }

    // Log learning delta if any memories were saved
    if (saved > 0 && snapshotBefore) {
      try {
        const { takeMemorySnapshot, calculateLearningDelta } =
          await import('../../../lib/learning-delta.js');
        const { appendProgressEntry } = await import('../../../lib/progress-log.js');
        const snapshotAfter = await takeMemorySnapshot();
        const delta = calculateLearningDelta(snapshotBefore, snapshotAfter, 'mcp-remember');
        await appendProgressEntry(delta);
      } catch (error) {
        logWarn('mcp-memory', 'Unable to append progress entry after extraction save', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `Extracted ${facts.length} facts:\n${results.join('\n')}\n\nSummary: ${saved} saved, ${skipped} skipped`,
        },
      ],
    };
  } catch (error) {
    // If extraction fails, fall back to saving original content
    const errorMsg = error instanceof Error ? error.message : String(error);
    return await saveSingleMemory({
      content,
      tags,
      source,
      type: params.type,
      useGlobal,
      valid_from,
      valid_until,
      config,
      fallbackReason: `LLM extraction failed: ${errorMsg}`,
    });
  } finally {
    closeDb();
    closeGlobalDb();
  }
}

/**
 * Save a single memory (used as fallback or when extraction is disabled)
 */
export async function saveSingleMemory(params: {
  content: string;
  tags: string[];
  source?: string;
  type: 'observation' | 'decision' | 'learning' | 'error' | 'pattern' | 'dead_end';
  useGlobal: boolean;
  valid_from?: string;
  valid_until?: string;
  config: ReturnType<typeof getConfig>;
  fallbackReason?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const {
    content,
    tags,
    source,
    type,
    useGlobal,
    valid_from,
    valid_until,
    config,
    fallbackReason,
  } = params;

  // Check for sensitive information
  let processedContent = content;
  if (config.sensitive_filter_enabled !== false) {
    const scanResult = scanSensitive(content);
    if (scanResult.hasSensitive) {
      if (config.sensitive_auto_redact) {
        processedContent = scanResult.redactedText;
      } else {
        return {
          content: [
            {
              type: 'text' as const,
              text: `⚠ Sensitive information detected:\n${formatMatches(scanResult.matches)}\n\nMemory not saved.`,
            },
          ],
        };
      }
    }
  }

  // Parse temporal validity periods
  let validFromDate: Date | undefined;
  let validUntilDate: Date | undefined;
  if (valid_from) {
    validFromDate = parseDuration(valid_from);
  }
  if (valid_until) {
    validUntilDate = parseDuration(valid_until);
  }

  try {
    const embedding = await getEmbedding(processedContent);

    let qualityScore = null;
    if (config.quality_scoring_enabled !== false) {
      qualityScore = await scoreMemory(processedContent);
      if (!passesQualityThreshold(qualityScore)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `⚠ Memory quality too low: ${formatQualityScore(qualityScore)}`,
            },
          ],
        };
      }
    }

    const fallbackPrefix = fallbackReason ? `(${fallbackReason})\n` : '';

    if (useGlobal) {
      const projectName = path.basename(getProjectRoot());
      const result = await saveGlobalMemory(
        processedContent,
        embedding,
        tags,
        source,
        projectName,
        {
          type,
        }
      );

      if (result.isDuplicate) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `${fallbackPrefix}⚠ Similar global memory exists (id: ${result.id}). Skipped duplicate.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `${fallbackPrefix}✓ Remembered globally (id: ${result.id}): "${processedContent.substring(0, 80)}..."`,
          },
        ],
      };
    }

    const result = await saveMemory(processedContent, embedding, tags, source, {
      type,
      qualityScore: qualityScore
        ? { score: qualityScore.score, factors: qualityScore.factors }
        : undefined,
      validFrom: validFromDate,
      validUntil: validUntilDate,
    });

    if (result.isDuplicate) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `${fallbackPrefix}⚠ Similar memory exists (id: ${result.id}). Skipped duplicate.`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: `${fallbackPrefix}✓ Remembered (id: ${result.id}): "${processedContent.substring(0, 80)}..."`,
        },
      ],
    };
  } finally {
    closeDb();
    closeGlobalDb();
  }
}
