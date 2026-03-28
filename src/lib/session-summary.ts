/**
 * Session Summary Extraction Module
 *
 * Extracts key facts and learnings from session transcripts
 * and saves them as memories for future reference.
 *
 * Part of idle-time compute (sleep-time compute) operations.
 */

import { saveMemoriesBatch, closeDb, recordTokenStat } from './storage/index.js';
import type { MemoryBatchInput } from './storage/index.js';
import { getEmbedding } from './embeddings.js';
import { getIdleReflectionConfig, getConfig } from './config.js';
import { scoreMemory } from './quality.js';
import { scanSensitive } from './sensitive-filter.js';
import { logInfo, logWarn } from './fault-logger.js';
import { countTokens } from './token-counter.js';
import { estimateSavings, getCurrentModel } from './pricing.js';
import { callLLM, type LLMBackend } from './llm.js';
import { formatTranscriptLines, type TranscriptMessage } from './transcript-utils.js';
import { FACT_EXTRACTION_SYSTEM, FACT_EXTRACTION_PROMPT } from '../prompts/index.js';
import { getLLMTaskConfig } from './config.js';
import {
  consolidateExtractedFacts,
  executeUpdates,
  executeDeletes,
  isExtractionConsolidationEnabled,
  CONSOLIDATION_SIMILARITY_THRESHOLD,
  CONSOLIDATION_TOP_K,
  CONSOLIDATION_LLM_TIMEOUT,
} from './auto-memory/extraction-consolidation.js';
import type { ExtractedFactInput } from './auto-memory/extraction-consolidation.js';

/**
 * Extracted fact from session
 */
export interface ExtractedFact {
  content: string;
  type: 'decision' | 'learning' | 'observation' | 'error' | 'pattern';
  confidence: number;
  tags: string[];
  files?: string[];
}

type ExtractedFactType = ExtractedFact['type'];

interface ExtractedFactCandidate {
  content?: unknown;
  type?: unknown;
  confidence?: unknown;
  tags?: unknown;
  files?: unknown;
}

function isExtractedFactType(value: unknown): value is ExtractedFactType {
  return (
    typeof value === 'string' &&
    ['decision', 'learning', 'observation', 'error', 'pattern'].includes(value)
  );
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * Result of session summary extraction
 */
export interface SessionSummaryResult {
  factsExtracted: number;
  factsSaved: number;
  factsSkipped: number;
  errors: string[];
  // Token stats for tracking savings
  transcriptTokens?: number;
  summaryTokens?: number;
}

/**
 * Call LLM to extract facts from text content
 * Exported for use by remember command with --extract option
 *
 * Uses the shared LLM module for backend flexibility.
 * Legacy options.mode is mapped to the new backend system.
 */
export async function extractFactsWithLLM(
  transcript: string,
  options: {
    mode: LLMBackend;
    model?: string;
    apiUrl?: string;
    apiKey?: string;
  }
): Promise<ExtractedFact[]> {
  const prompt = FACT_EXTRACTION_PROMPT.replace('{transcript}', transcript);

  try {
    const result = await callLLM(
      prompt,
      {
        timeout: 30000,
        maxTokens: 2000,
        useSleepAgent: true,
        systemPrompt: FACT_EXTRACTION_SYSTEM,
      },
      {
        backend: options.mode,
        model: options.model,
        endpoint: options.apiUrl,
        apiKey: options.apiKey,
      }
    );
    return parseFactsResponse(result);
  } catch (error) {
    logWarn('session-summary', `LLM extraction failed (${options.mode})`, { error: String(error) });
    return [];
  }
}

/**
 * Parse LLM response to ExtractedFact array
 */
function parseFactsResponse(response: string): ExtractedFact[] {
  try {
    // Extract JSON array from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return [];
    }

    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      return [];
    }

    // Validate and normalize facts
    return parsed
      .filter((fact): fact is ExtractedFactCandidate => typeof fact === 'object' && fact !== null)
      .filter(
        (fact): fact is ExtractedFactCandidate & { content: string; type: ExtractedFactType } =>
          typeof fact.content === 'string' &&
          fact.content.length >= 50 &&
          isExtractedFactType(fact.type)
      )
      .map((fact) => {
        const files = toStringArray(fact.files);
        return {
          content: fact.content.trim(),
          type: fact.type,
          confidence:
            typeof fact.confidence === 'number' ? Math.max(0, Math.min(1, fact.confidence)) : 0.7,
          tags: toStringArray(fact.tags),
          files: files.length > 0 ? files : undefined,
        };
      });
  } catch (error) {
    logWarn('session-summary', 'Failed to parse LLM fact extraction JSON response', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Save extracted facts as memories
 */
async function saveFactsAsMemories(
  facts: ExtractedFact[],
  minQuality: number,
  onProgress?: (current: number, total: number) => void
): Promise<{ saved: number; skipped: number; errors: string[] }> {
  let saved = 0;
  let skipped = 0;
  const errors: string[] = [];
  const config = getConfig();

  // Phase 1: Pre-process all facts (sensitive filter, embedding, quality scoring)
  const prepared: MemoryBatchInput[] = [];

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    onProgress?.(i + 1, facts.length);

    try {
      let content = fact.content;
      if (config.sensitive_filter_enabled !== false) {
        const scanResult = scanSensitive(content);
        if (scanResult.hasSensitive) {
          if (config.sensitive_auto_redact) {
            content = scanResult.redactedText;
          } else {
            skipped++;
            continue;
          }
        }
      }

      const embedding = await getEmbedding(content);

      const qualityScore = await scoreMemory(content);
      if (qualityScore.score < minQuality) {
        skipped++;
        continue;
      }

      const tags = [...fact.tags, 'session-summary', fact.type];

      prepared.push({
        content,
        embedding,
        tags,
        type: fact.type,
        source: 'session-summary',
        qualityScore: { score: qualityScore.score, factors: qualityScore.factors },
      });
    } catch (error) {
      logWarn('session-summary', 'Failed to prepare fact for memory batch save', {
        error: error instanceof Error ? error.message : String(error),
      });
      errors.push(`Failed to save fact: ${fact.content.substring(0, 50)}...`);
    }
  }

  // Phase 2: Batch save with dedup threshold 0.9 (session-summary uses higher threshold)
  if (prepared.length > 0) {
    const batchResult = await saveMemoriesBatch(prepared, 0.9);
    saved = batchResult.saved;
    skipped += batchResult.skipped;
  }

  return { saved, skipped, errors };
}

/**
 * Extract and save session summary
 * Main entry point for session summary operation
 */
export async function extractSessionSummary(
  transcript: string,
  options: {
    verbose?: boolean;
    dryRun?: boolean;
    onProgress?: (current: number, total: number, action: string) => void;
    // CLI overrides for LLM selection
    api?: boolean;
    apiUrl?: string;
    model?: string;
  } = {}
): Promise<SessionSummaryResult> {
  const { verbose = false, dryRun = false, onProgress } = options;
  const config = getIdleReflectionConfig();
  getConfig();

  const result: SessionSummaryResult = {
    factsExtracted: 0,
    factsSaved: 0,
    factsSkipped: 0,
    errors: [],
    transcriptTokens: countTokens(transcript),
    summaryTokens: 0,
  };

  // Determine which agent to use
  // CLI --api flag takes priority, then config
  let llmOptions: {
    mode: LLMBackend;
    model?: string;
    apiUrl?: string;
    apiKey?: string;
  };

  if (options.api) {
    const sleepCfg = getLLMTaskConfig('sleep');
    llmOptions = {
      mode: 'api',
      model: options.model || sleepCfg.model,
      apiUrl: options.apiUrl || sleepCfg.api_url,
      apiKey: sleepCfg.api_key,
    };
  } else {
    // Use config-based selection
    const sleepAgent = config.sleep_agent;
    const useSleepAgent = sleepAgent.enabled && sleepAgent.handle_operations?.session_summary;

    if (useSleepAgent) {
      const sleepCfg = getLLMTaskConfig('sleep');
      llmOptions = {
        mode: sleepCfg.mode as LLMBackend,
        model: sleepCfg.model,
        apiUrl: sleepCfg.api_url,
        apiKey: sleepCfg.api_key,
      };
    } else {
      llmOptions = {
        mode: 'claude',
        model: config.agent_model,
      };
    }
  }

  if (verbose) {
    logInfo(
      'session-summary',
      `Using ${llmOptions.mode} mode for extraction (model: ${llmOptions.model || 'default'})`
    );
  }

  // Extract facts from transcript
  onProgress?.(1, 3, 'extracting facts');

  if (verbose) {
    logInfo('session-summary', 'Extracting facts from transcript...');
  }

  const facts = await extractFactsWithLLM(transcript, llmOptions);
  result.factsExtracted = facts.length;

  // Calculate summary tokens (all fact contents combined)
  result.summaryTokens = facts.reduce((sum, f) => sum + countTokens(f.content), 0);

  if (verbose) {
    logInfo('session-summary', `Found ${facts.length} potential facts`);
  }

  if (facts.length === 0) {
    return result;
  }

  // Run extraction consolidation if enabled (mem0-style ADD/UPDATE/DELETE)
  let factsToSave: ExtractedFact[] = facts;
  if (!dryRun && isExtractionConsolidationEnabled()) {
    try {
      if (verbose) {
        logInfo('session-summary', `Running extraction consolidation on ${facts.length} facts`);
      }
      const consolidation = await consolidateExtractedFacts(facts as ExtractedFactInput[], {
        similarityThreshold: CONSOLIDATION_SIMILARITY_THRESHOLD,
        topK: CONSOLIDATION_TOP_K,
        llmTimeout: CONSOLIDATION_LLM_TIMEOUT,
      });

      // Execute UPDATE and DELETE decisions
      if (consolidation.toUpdate.length > 0) {
        const updated = await executeUpdates(consolidation.toUpdate);
        if (verbose) {
          logInfo('session-summary', `Consolidation: ${updated} memories updated`);
        }
      }
      if (consolidation.toDelete.length > 0) {
        const deleted = await executeDeletes(consolidation.toDelete);
        if (verbose) {
          logInfo('session-summary', `Consolidation: ${deleted} memories invalidated`);
        }
      }

      // Merge ADD + fallbackAdd facts for normal save path
      factsToSave = [
        ...consolidation.toAdd.map((f) => ({
          content: f.content,
          type: f.type as ExtractedFact['type'],
          confidence: f.confidence,
          tags: f.tags,
        })),
        ...consolidation.fallbackAdd.map((f) => ({
          content: f.content,
          type: f.type as ExtractedFact['type'],
          confidence: f.confidence,
          tags: f.tags,
        })),
      ];

      if (verbose) {
        logInfo(
          'session-summary',
          `Consolidation: ${consolidation.toAdd.length} ADD, ${consolidation.toUpdate.length} UPDATE, ` +
            `${consolidation.toDelete.length} DELETE, ${consolidation.skippedNone} NONE`
        );
      }
    } catch (err) {
      logWarn('session-summary', `Extraction consolidation failed, proceeding with normal save`, {
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through to normal save with all facts
    }
  }

  // Save facts as memories
  onProgress?.(2, 3, 'saving memories');

  if (dryRun) {
    if (verbose) {
      logInfo('session-summary', 'Dry run - facts that would be saved:');
      for (const fact of facts) {
        logInfo(
          'session-summary',
          `  [${fact.type}] ${fact.content.substring(0, 100)}... Tags: ${fact.tags.join(', ')} | Confidence: ${(fact.confidence * 100).toFixed(0)}%`
        );
      }
    }
    result.factsSaved = 0;
    result.factsSkipped = facts.length;
  } else {
    const minQuality = config.thresholds.min_quality_for_summary ?? 0.5;
    const saveResult = await saveFactsAsMemories(
      factsToSave,
      minQuality,
      verbose
        ? (current, total) => {
            process.stdout.write(`\rSaving fact ${current}/${total}...`);
          }
        : undefined
    );

    result.factsSaved = saveResult.saved;
    result.factsSkipped = saveResult.skipped;
    result.errors = saveResult.errors;

    if (verbose) {
      logInfo('session-summary', 'Fact saving complete');
    }
  }

  onProgress?.(3, 3, 'complete');

  closeDb();

  return result;
}

/**
 * Run session summary as CLI command
 */
export async function sessionSummary(
  transcriptPath: string,
  options: {
    dryRun?: boolean;
    verbose?: boolean;
    api?: boolean;
    apiUrl?: string;
    model?: string;
  } = {}
): Promise<void> {
  const fs = await import('fs');

  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript file not found: ${transcriptPath}`);
  }

  const transcriptContent = fs.readFileSync(transcriptPath, 'utf-8');

  // Parse JSONL transcript
  const lines = transcriptContent.trim().split('\n');
  const transcript = lines
    .map((line) => {
      try {
        const entry = JSON.parse(line) as TranscriptMessage;
        return formatTranscriptLines([entry])[0] ?? null;
      } catch (error) {
        logWarn('session-summary', 'Failed to parse transcript JSONL line for extraction', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })
    .filter((line): line is string => Boolean(line))
    .join('\n\n');

  if (transcript.length < 200) {
    console.log('Transcript too short for meaningful extraction.');
    return;
  }

  console.log('Extracting session summary...\n');

  // Snapshot before extraction for learning delta
  let snapshotBefore: import('./learning-delta.js').MemorySnapshot | null = null;
  try {
    const { takeMemorySnapshot } = await import('./learning-delta.js');
    snapshotBefore = await takeMemorySnapshot();
  } catch (error) {
    logWarn('session-summary', 'Failed to import learning-delta module for memory snapshot', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Learning delta is optional
  }

  const result = await extractSessionSummary(transcript, {
    dryRun: options.dryRun,
    verbose: options.verbose ?? true,
    api: options.api,
    apiUrl: options.apiUrl,
    model: options.model,
  });

  console.log('\nSession Summary Results:');
  console.log(`  Facts extracted: ${result.factsExtracted}`);
  console.log(`  Facts saved: ${result.factsSaved}`);
  console.log(`  Facts skipped: ${result.factsSkipped}`);

  // Compute and log learning delta
  if (snapshotBefore && result.factsSaved > 0) {
    try {
      const { takeMemorySnapshot, calculateLearningDelta } = await import('./learning-delta.js');
      const { appendProgressEntry } = await import('./progress-log.js');
      const snapshotAfter = await takeMemorySnapshot();
      const delta = calculateLearningDelta(snapshotBefore, snapshotAfter, 'session-summary');
      await appendProgressEntry(delta);
      if (options.verbose) {
        console.log(`  Progress logged: +${delta.newMemories} facts`);
      }
    } catch (error) {
      logWarn('session-summary', 'Failed to compute or append learning delta for session summary', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Progress logging is optional
    }
  }

  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    for (const err of result.errors.slice(0, 3)) {
      console.log(`    - ${err}`);
    }
  }

  // Record token stats if we actually saved facts
  if (result.factsSaved > 0 && result.transcriptTokens && result.summaryTokens) {
    const idleConfig = getIdleReflectionConfig();
    const summaryEnabled = idleConfig.operations?.session_summary ?? true;

    if (summaryEnabled) {
      try {
        const transcriptTokens = countTokens(transcriptContent);
        const savingsTokens = Math.max(0, transcriptTokens - (result.summaryTokens || 0));
        const model = getCurrentModel();
        const estimatedCost = estimateSavings(savingsTokens, model);

        recordTokenStat({
          event_type: 'session_summary',
          query: transcriptPath,
          returned_tokens: result.summaryTokens || 0,
          full_source_tokens: transcriptTokens,
          savings_tokens: savingsTokens,
          chunks_count: result.factsSaved,
          model,
          estimated_cost: estimatedCost,
        });
      } catch (error) {
        logWarn('session-summary', 'Failed to record token stats for session summary', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't fail if stats recording fails
      }
    }
  }
}
