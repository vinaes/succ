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
import { logWarn } from './fault-logger.js';
import { countTokens } from './token-counter.js';
import { estimateSavings, getCurrentModel } from './pricing.js';
import { callLLM, type LLMBackend } from './llm.js';
import { FACT_EXTRACTION_PROMPT } from '../prompts/index.js';
import { getLLMTaskConfig } from './config.js';

/**
 * Extracted fact from session
 */
export interface ExtractedFact {
  content: string;
  type: 'decision' | 'learning' | 'observation' | 'error' | 'pattern';
  confidence: number;
  tags: string[];
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
      { timeout: 30000, maxTokens: 2000, useSleepAgent: true },
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

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      return [];
    }

    // Validate and normalize facts
    return parsed
      .filter(
        (f: any) =>
          f.content &&
          typeof f.content === 'string' &&
          f.content.length >= 50 &&
          ['decision', 'learning', 'observation', 'error', 'pattern'].includes(f.type)
      )
      .map((f: any) => ({
        content: f.content.trim(),
        type: f.type,
        confidence: Math.max(0, Math.min(1, f.confidence || 0.7)),
        tags: Array.isArray(f.tags) ? f.tags.filter((t: any) => typeof t === 'string') : [],
      }));
  } catch {
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
    } catch {
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
    console.log(
      `Using ${llmOptions.mode} mode for extraction (model: ${llmOptions.model || 'default'})`
    );
  }

  // Extract facts from transcript
  onProgress?.(1, 3, 'extracting facts');

  if (verbose) {
    console.log('Extracting facts from transcript...');
  }

  const facts = await extractFactsWithLLM(transcript, llmOptions);
  result.factsExtracted = facts.length;

  // Calculate summary tokens (all fact contents combined)
  result.summaryTokens = facts.reduce((sum, f) => sum + countTokens(f.content), 0);

  if (verbose) {
    console.log(`Found ${facts.length} potential facts`);
  }

  if (facts.length === 0) {
    return result;
  }

  // Save facts as memories
  onProgress?.(2, 3, 'saving memories');

  if (dryRun) {
    if (verbose) {
      console.log('\nDry run - facts that would be saved:');
      for (const fact of facts) {
        console.log(`  [${fact.type}] ${fact.content.substring(0, 100)}...`);
        console.log(
          `    Tags: ${fact.tags.join(', ')} | Confidence: ${(fact.confidence * 100).toFixed(0)}%`
        );
      }
    }
    result.factsSaved = 0;
    result.factsSkipped = facts.length;
  } else {
    const minQuality = config.thresholds.min_quality_for_summary ?? 0.5;
    const saveResult = await saveFactsAsMemories(
      facts,
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
      console.log('\n');
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
        const entry = JSON.parse(line);
        const getTextContent = (content: any): string => {
          if (typeof content === 'string') return content;
          if (Array.isArray(content)) {
            return content
              .filter((block: any) => block.type === 'text' && block.text)
              .map((block: any) => block.text)
              .join(' ');
          }
          return '';
        };

        if (entry.type === 'assistant' && entry.message?.content) {
          const text = getTextContent(entry.message.content);
          if (text) return `Assistant: ${text.substring(0, 1000)}`;
        }
        if ((entry.type === 'human' || entry.type === 'user') && entry.message?.content) {
          const text = getTextContent(entry.message.content);
          if (text) return `User: ${text.substring(0, 500)}`;
        }
      } catch {
        return null;
      }
      return null;
    })
    .filter(Boolean)
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
  } catch {
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
    } catch {
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
      } catch {
        // Don't fail if stats recording fails
      }
    }
  }
}
