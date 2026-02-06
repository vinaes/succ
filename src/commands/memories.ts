import {
  getRecentMemories,
  searchMemories,
  saveMemory,
  closeDb,
  getMemoryStats,
  deleteMemory,
  deleteMemoriesOlderThan,
  deleteMemoriesByTag,
  getMemoryById,
  // Global memory functions
  saveGlobalMemory,
  searchGlobalMemories,
  getRecentGlobalMemories,
  deleteGlobalMemory,
  getGlobalMemoryStats,
  closeGlobalDb,
} from '../lib/db/index.js';
import { getEmbedding } from '../lib/embeddings.js';
import { getConfig, getProjectRoot, getIdleReflectionConfig } from '../lib/config.js';
import { scoreMemory, passesQualityThreshold, formatQualityScore } from '../lib/quality.js';
import { scanSensitive, formatMatches } from '../lib/sensitive-filter.js';
import { parseDuration } from '../lib/temporal.js';
import { extractFactsWithLLM, ExtractedFact } from '../lib/session-summary.js';
import path from 'path';

/**
 * Format quality score briefly for list display
 */
function formatQualityBrief(score: number): string {
  const percent = Math.round(score * 100);
  const stars = Math.round(score * 5);
  return `${'★'.repeat(stars)}${'☆'.repeat(5 - stars)} ${percent}%`;
}

interface MemoriesOptions {
  recent?: number;
  search?: string;
  tags?: string;
  limit?: number;
  global?: boolean;
  json?: boolean;
}

/**
 * List and manage memories
 */
export async function memories(options: MemoriesOptions = {}): Promise<void> {
  const { recent, search, tags, limit = 10, global: useGlobal, json: outputJson } = options;

  try {
    // Show recent memories
    if (recent !== undefined || (!search && !tags)) {
      const count = recent || limit;

      if (useGlobal) {
        // Global only
        const globalMemories = getRecentGlobalMemories(count);
        closeGlobalDb();

        if (globalMemories.length === 0) {
          if (outputJson) {
            console.log('[]');
          } else {
            console.log('No global memories stored yet.');
            console.log('\nUse `succ remember --global <content>` to add global memories.');
          }
          return;
        }

        if (outputJson) {
          console.log(JSON.stringify(globalMemories, null, 2));
          return;
        }

        console.log(`Recent global memories (${globalMemories.length}):\n`);

        for (const memory of globalMemories) {
          const date = new Date(memory.created_at).toLocaleDateString();
          const tagStr = memory.tags.length > 0 ? ` [${memory.tags.join(', ')}]` : '';
          const projectStr = memory.project ? ` (project: ${memory.project})` : '';

          console.log(`• [GLOBAL] ${date}${tagStr}${projectStr}`);
          console.log(`  ${memory.content.substring(0, 200)}${memory.content.length > 200 ? '...' : ''}`);
          console.log();
        }
        return;
      }

      // Local memories
      const recentMemories = getRecentMemories(count);
      closeDb();

      if (recentMemories.length === 0) {
        if (outputJson) {
          console.log('[]');
        } else {
          console.log('No memories stored yet.');
          console.log('\nUse succ_remember MCP tool or `succ remember <content>` to add memories.');
        }
        return;
      }

      if (outputJson) {
        console.log(JSON.stringify(recentMemories, null, 2));
        return;
      }

      console.log(`Recent memories (${recentMemories.length}):\n`);

      for (const memory of recentMemories) {
        const date = new Date(memory.created_at).toLocaleDateString();
        const tagStr = memory.tags.length > 0 ? ` [${memory.tags.join(', ')}]` : '';
        const sourceStr = memory.source ? ` (from: ${memory.source})` : '';
        const qualityStr = memory.quality_score !== null
          ? ` ${formatQualityBrief(memory.quality_score)}`
          : '';

        console.log(`• ${date}${tagStr}${sourceStr}${qualityStr}`);
        console.log(`  ${memory.content.substring(0, 200)}${memory.content.length > 200 ? '...' : ''}`);
        console.log();
      }
      return;
    }

    // Search memories
    if (search) {
      const queryEmbedding = await getEmbedding(search);
      const tagList = tags ? tags.split(',').map((t) => t.trim()) : undefined;

      if (useGlobal) {
        // Global only
        const results = searchGlobalMemories(queryEmbedding, limit, 0.3, tagList);
        closeGlobalDb();

        if (results.length === 0) {
          console.log(`No global memories found matching "${search}"`);
          return;
        }

        console.log(`Found ${results.length} global memories matching "${search}":\n`);

        for (const memory of results) {
          const date = new Date(memory.created_at).toLocaleDateString();
          const similarity = (memory.similarity * 100).toFixed(0);
          const tagStr = memory.tags.length > 0 ? ` [${memory.tags.join(', ')}]` : '';
          const projectStr = memory.project ? ` (project: ${memory.project})` : '';

          console.log(`• [GLOBAL] ${date}${tagStr}${projectStr} (${similarity}% match)`);
          console.log(`  ${memory.content.substring(0, 200)}${memory.content.length > 200 ? '...' : ''}`);
          console.log();
        }
        return;
      }

      // Local memories
      const results = searchMemories(queryEmbedding, limit, 0.3, tagList);
      closeDb();

      if (results.length === 0) {
        console.log(`No memories found matching "${search}"`);
        return;
      }

      console.log(`Found ${results.length} memories matching "${search}":\n`);

      for (const memory of results) {
        const date = new Date(memory.created_at).toLocaleDateString();
        const similarity = (memory.similarity * 100).toFixed(0);
        const tagStr = memory.tags.length > 0 ? ` [${memory.tags.join(', ')}]` : '';
        const qualityStr = memory.quality_score !== null
          ? ` ${formatQualityBrief(memory.quality_score)}`
          : '';

        console.log(`• ${date}${tagStr} (${similarity}% match)${qualityStr}`);
        console.log(`  ${memory.content.substring(0, 200)}${memory.content.length > 200 ? '...' : ''}`);
        console.log();
      }
    }
  } catch (error: any) {
    console.error('Error:', error.message);
    closeDb();
    closeGlobalDb();
    process.exit(1);
  }
}

interface RememberOptions {
  tags?: string;
  source?: string;
  global?: boolean;
  skipQuality?: boolean;
  skipSensitiveCheck?: boolean;
  redactSensitive?: boolean;
  // Temporal validity
  validFrom?: string;   // When fact becomes valid (e.g., "2024-01-01" or "7d")
  validUntil?: string;  // When fact expires (e.g., "2024-12-31" or "30d")
  // LLM extraction
  extract?: boolean;    // Force extract structured facts using LLM
  noExtract?: boolean;  // Disable LLM extraction (override config default)
  local?: boolean;      // Use local LLM (Ollama/LM Studio)
  openrouter?: boolean; // Use OpenRouter
  model?: string;       // Model to use for extraction
  apiUrl?: string;      // API URL for local LLM
}

/**
 * Save a new memory from CLI
 */
export async function remember(content: string, options: RememberOptions = {}): Promise<void> {
  const { tags, source, global: useGlobal, skipQuality, skipSensitiveCheck, redactSensitive, validFrom, validUntil, extract, noExtract, local, openrouter, model, apiUrl } = options;

  try {
    const config = getConfig();
    const tagList = tags ? tags.split(',').map((t) => t.trim()) : [];

    // Determine if LLM extraction should be used: explicit flags override config default
    const configDefault = config.remember_extract_default !== false; // default true
    const useExtract = noExtract ? false : (extract ?? configDefault);

    // LLM extraction mode: extract structured facts from content
    if (useExtract) {
      await rememberWithExtraction(content, { tags, source, global: useGlobal, skipQuality, skipSensitiveCheck, redactSensitive, validFrom, validUntil, local, openrouter, model, apiUrl });
      return;
    }

    // Parse temporal validity periods
    let validFromDate: Date | undefined;
    let validUntilDate: Date | undefined;

    if (validFrom) {
      try {
        validFromDate = parseDuration(validFrom);
      } catch (e: any) {
        console.error(`Invalid --valid-from: ${e.message}`);
        process.exit(1);
      }
    }

    if (validUntil) {
      try {
        validUntilDate = parseDuration(validUntil);
      } catch (e: any) {
        console.error(`Invalid --valid-until: ${e.message}`);
        process.exit(1);
      }
    }

    // Check for sensitive information
    const sensitiveCheckEnabled = config.sensitive_filter_enabled !== false && !skipSensitiveCheck;
    if (sensitiveCheckEnabled) {
      const scanResult = scanSensitive(content);
      if (scanResult.hasSensitive) {
        console.log(`\n⚠ Sensitive information detected:`);
        console.log(formatMatches(scanResult.matches));
        console.log();

        if (redactSensitive || config.sensitive_auto_redact) {
          // Auto-redact and continue
          content = scanResult.redactedText;
          console.log(`✓ Sensitive data redacted automatically.`);
          console.log(`  Redacted content: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
          console.log();
        } else {
          // Block by default
          console.log(`Memory not saved. Options:`);
          console.log(`  --redact-sensitive  Save with sensitive data redacted`);
          console.log(`  --skip-sensitive    Save anyway (not recommended)`);
          console.log(`\nOr set in config: "sensitive_auto_redact": true`);
          closeDb();
          closeGlobalDb();
          return;
        }
      }
    }

    const embedding = await getEmbedding(content);

    // Score the memory quality (unless disabled)
    let qualityScore = null;
    if (!skipQuality && config.quality_scoring_enabled !== false) {
      qualityScore = await scoreMemory(content);

      // Check if it passes the threshold
      if (!passesQualityThreshold(qualityScore)) {
        console.log(`⚠ Memory quality too low: ${formatQualityScore(qualityScore)}`);
        console.log(`  Threshold: ${((config.quality_scoring_threshold ?? 0) * 100).toFixed(0)}%`);
        console.log(`  Use --skip-quality to bypass or lower the threshold in config.`);
        closeDb();
        closeGlobalDb();
        return;
      }
    }

    if (useGlobal) {
      // Save to global memory with project name
      const projectName = path.basename(getProjectRoot());
      const result = saveGlobalMemory(content, embedding, tagList, source, projectName);
      closeGlobalDb();

      const tagStr = tagList.length > 0 ? ` [${tagList.join(', ')}]` : '';
      const qualityStr = qualityScore ? ` ${formatQualityScore(qualityScore)}` : '';
      if (result.isDuplicate) {
        console.log(`⚠ Similar global memory exists (id: ${result.id}, ${((result.similarity || 0) * 100).toFixed(0)}% similar)`);
        console.log(`  Skipped duplicate.`);
      } else {
        console.log(`✓ Remembered globally (id: ${result.id})${tagStr}${qualityStr}`);
        console.log(`  Project: ${projectName}`);
        console.log(`  "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
      }
    } else {
      // Save to local memory with quality score and validity period
      const result = saveMemory(content, embedding, tagList, source, {
        qualityScore: qualityScore ? { score: qualityScore.score, factors: qualityScore.factors } : undefined,
        validFrom: validFromDate,
        validUntil: validUntilDate,
      });
      closeDb();

      const tagStr = tagList.length > 0 ? ` [${tagList.join(', ')}]` : '';
      const qualityStr = qualityScore ? ` ${formatQualityScore(qualityScore)}` : '';
      const validityStr = (validFromDate || validUntilDate)
        ? ` (valid: ${validFromDate ? validFromDate.toLocaleDateString() : '∞'} → ${validUntilDate ? validUntilDate.toLocaleDateString() : '∞'})`
        : '';
      if (result.isDuplicate) {
        console.log(`⚠ Similar memory exists (id: ${result.id}, ${((result.similarity || 0) * 100).toFixed(0)}% similar)`);
        console.log(`  Skipped duplicate.`);
      } else {
        console.log(`✓ Remembered (id: ${result.id})${tagStr}${qualityStr}${validityStr}`);
        console.log(`  "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
      }
    }
  } catch (error: any) {
    console.error('Error saving memory:', error.message);
    console.error(error.stack);
    closeDb();
    closeGlobalDb();
    process.exit(1);
  }
}

/**
 * Save memory with LLM extraction - extracts structured facts from content
 */
async function rememberWithExtraction(
  content: string,
  options: Omit<RememberOptions, 'extract'>
): Promise<void> {
  const { tags, source, global: useGlobal, skipQuality, skipSensitiveCheck, redactSensitive, validFrom, validUntil, local, openrouter, model, apiUrl } = options;
  const config = getConfig();
  const idleConfig = getIdleReflectionConfig();

  console.log('Extracting facts using LLM...\n');

  // Determine LLM options
  let llmOptions: {
    mode: 'claude' | 'local' | 'openrouter';
    model?: string;
    apiUrl?: string;
    apiKey?: string;
  };

  if (local) {
    llmOptions = {
      mode: 'local',
      model: model || idleConfig.sleep_agent?.model || 'qwen2.5-coder:14b',
      apiUrl: apiUrl || idleConfig.sleep_agent?.api_url || 'http://localhost:11434/v1',
    };
  } else if (openrouter) {
    llmOptions = {
      mode: 'openrouter',
      model: model || idleConfig.sleep_agent?.model || 'anthropic/claude-3-haiku',
      apiKey: idleConfig.sleep_agent?.api_key || config.openrouter_api_key,
    };
  } else {
    // Default to Claude CLI
    llmOptions = {
      mode: 'claude',
      model: model || idleConfig.agent_model || 'haiku',
    };
  }

  console.log(`Using ${llmOptions.mode} mode (model: ${llmOptions.model || 'default'})`);

  // Extract facts from content
  const facts = await extractFactsWithLLM(content, llmOptions);

  if (facts.length === 0) {
    console.log('No meaningful facts extracted. Saving original content as-is.');
    // Fall back to saving the original content
    await saveSingleFact(content, { tags, source, global: useGlobal, skipQuality, skipSensitiveCheck, redactSensitive, validFrom, validUntil });
    return;
  }

  console.log(`\nExtracted ${facts.length} facts:\n`);

  // Parse temporal validity periods once
  let validFromDate: Date | undefined;
  let validUntilDate: Date | undefined;
  if (validFrom) {
    validFromDate = parseDuration(validFrom);
  }
  if (validUntil) {
    validUntilDate = parseDuration(validUntil);
  }

  // Parse tags
  const baseTags = tags ? tags.split(',').map((t) => t.trim()) : [];

  let saved = 0;
  let skipped = 0;

  for (const fact of facts) {
    let factContent = fact.content;

    // Check for sensitive information
    const sensitiveCheckEnabled = config.sensitive_filter_enabled !== false && !skipSensitiveCheck;
    if (sensitiveCheckEnabled) {
      const scanResult = scanSensitive(factContent);
      if (scanResult.hasSensitive) {
        if (redactSensitive || config.sensitive_auto_redact) {
          factContent = scanResult.redactedText;
        } else {
          console.log(`  ⚠ [${fact.type}] Skipped (sensitive info): "${fact.content.substring(0, 50)}..."`);
          skipped++;
          continue;
        }
      }
    }

    try {
      const embedding = await getEmbedding(factContent);

      // Merge fact tags with base tags
      const factTags = [...baseTags, ...fact.tags, fact.type, 'extracted'];

      // Score quality
      let qualityScore = null;
      if (!skipQuality && config.quality_scoring_enabled !== false) {
        qualityScore = await scoreMemory(factContent);
        if (!passesQualityThreshold(qualityScore)) {
          console.log(`  ⚠ [${fact.type}] Skipped (low quality): "${fact.content.substring(0, 50)}..."`);
          skipped++;
          continue;
        }
      }

      if (useGlobal) {
        const projectName = path.basename(getProjectRoot());
        const result = saveGlobalMemory(factContent, embedding, factTags, source || 'extraction');
        if (result.isDuplicate) {
          console.log(`  ⚠ [${fact.type}] Duplicate: "${fact.content.substring(0, 50)}..."`);
          skipped++;
        } else {
          console.log(`  ✓ [${fact.type}] id:${result.id} "${fact.content.substring(0, 60)}..."`);
          saved++;
        }
      } else {
        const result = saveMemory(factContent, embedding, factTags, source || 'extraction', {
          qualityScore: qualityScore ? { score: qualityScore.score, factors: qualityScore.factors } : undefined,
          validFrom: validFromDate,
          validUntil: validUntilDate,
        });
        if (result.isDuplicate) {
          console.log(`  ⚠ [${fact.type}] Duplicate: "${fact.content.substring(0, 50)}..."`);
          skipped++;
        } else {
          console.log(`  ✓ [${fact.type}] id:${result.id} "${fact.content.substring(0, 60)}..."`);
          saved++;
        }
      }
    } catch (error: any) {
      console.error(`  ✗ [${fact.type}] Error: ${error.message}`);
      skipped++;
    }
  }

  closeDb();
  closeGlobalDb();

  console.log(`\nSummary: ${saved} saved, ${skipped} skipped`);
}

/**
 * Helper to save a single fact (used as fallback when extraction yields nothing)
 */
async function saveSingleFact(
  content: string,
  options: Omit<RememberOptions, 'extract' | 'local' | 'openrouter' | 'model' | 'apiUrl'>
): Promise<void> {
  const { tags, source, global: useGlobal, skipQuality, skipSensitiveCheck, redactSensitive, validFrom, validUntil } = options;
  const config = getConfig();
  const tagList = tags ? tags.split(',').map((t) => t.trim()) : [];

  // Parse temporal validity periods
  let validFromDate: Date | undefined;
  let validUntilDate: Date | undefined;
  if (validFrom) {
    validFromDate = parseDuration(validFrom);
  }
  if (validUntil) {
    validUntilDate = parseDuration(validUntil);
  }

  // Check for sensitive information
  const sensitiveCheckEnabled = config.sensitive_filter_enabled !== false && !skipSensitiveCheck;
  if (sensitiveCheckEnabled) {
    const scanResult = scanSensitive(content);
    if (scanResult.hasSensitive) {
      if (redactSensitive || config.sensitive_auto_redact) {
        content = scanResult.redactedText;
      } else {
        console.log(`⚠ Sensitive information detected. Use --redact-sensitive or --skip-sensitive.`);
        closeDb();
        closeGlobalDb();
        return;
      }
    }
  }

  const embedding = await getEmbedding(content);

  let qualityScore = null;
  if (!skipQuality && config.quality_scoring_enabled !== false) {
    qualityScore = await scoreMemory(content);
    if (!passesQualityThreshold(qualityScore)) {
      console.log(`⚠ Memory quality too low: ${formatQualityScore(qualityScore)}`);
      closeDb();
      closeGlobalDb();
      return;
    }
  }

  if (useGlobal) {
    const projectName = path.basename(getProjectRoot());
    const result = saveGlobalMemory(content, embedding, tagList, source);
    closeGlobalDb();
    console.log(`✓ Remembered globally (id: ${result.id})`);
  } else {
    const result = saveMemory(content, embedding, tagList, source, {
      qualityScore: qualityScore ? { score: qualityScore.score, factors: qualityScore.factors } : undefined,
      validFrom: validFromDate,
      validUntil: validUntilDate,
    });
    closeDb();
    console.log(`✓ Remembered (id: ${result.id})`);
  }
}

/**
 * Show memory statistics
 */
export function memoryStats(): void {
  try {
    const stats = getMemoryStats();
    closeDb();

    console.log('Memory Statistics:');
    console.log(`  Total memories: ${stats.total_memories}`);
    if (stats.oldest_memory) {
      console.log(`  Oldest: ${new Date(stats.oldest_memory).toLocaleDateString()}`);
    }
    if (stats.newest_memory) {
      console.log(`  Newest: ${new Date(stats.newest_memory).toLocaleDateString()}`);
    }
  } catch (error: any) {
    console.error('Error getting stats:', error.message);
    closeDb();
    process.exit(1);
  }
}

interface ForgetOptions {
  id?: number;
  olderThan?: string;
  tag?: string;
  all?: boolean;
}

/**
 * Forget (delete) memories
 */
export function forget(options: ForgetOptions): void {
  try {
    const { id, olderThan, tag, all } = options;

    // Delete by ID
    if (id !== undefined) {
      const memory = getMemoryById(id);
      if (!memory) {
        console.log(`Memory with id ${id} not found.`);
        closeDb();
        return;
      }

      const deleted = deleteMemory(id);
      closeDb();

      if (deleted) {
        console.log(`✓ Forgot memory ${id}:`);
        console.log(`  "${memory.content.substring(0, 100)}${memory.content.length > 100 ? '...' : ''}"`);
      } else {
        console.log(`Failed to delete memory ${id}`);
      }
      return;
    }

    // Delete older than date
    if (olderThan) {
      const date = parseRelativeDate(olderThan);
      if (!date) {
        console.error(`Invalid date: ${olderThan}`);
        console.log('Use: "30d" (30 days), "1w" (1 week), "3m" (3 months), or ISO date');
        closeDb();
        process.exit(1);
      }

      const count = deleteMemoriesOlderThan(date);
      closeDb();

      console.log(`✓ Forgot ${count} memories older than ${date.toLocaleDateString()}`);
      return;
    }

    // Delete by tag
    if (tag) {
      const count = deleteMemoriesByTag(tag);
      closeDb();

      console.log(`✓ Forgot ${count} memories with tag "${tag}"`);
      return;
    }

    // Delete all
    if (all) {
      const stats = getMemoryStats();
      const count = stats.total_memories;

      if (count === 0) {
        console.log('No memories to delete.');
        closeDb();
        return;
      }

      // Delete all by using a very old date
      const deleted = deleteMemoriesOlderThan(new Date('2100-01-01'));
      closeDb();

      console.log(`✓ Forgot all ${deleted} memories`);
      return;
    }

    // No option specified
    console.log('Specify what to forget:');
    console.log('  --id <id>         Delete memory by ID');
    console.log('  --older-than <d>  Delete memories older than (e.g., "30d", "1w", "3m")');
    console.log('  --tag <tag>       Delete memories with tag');
    console.log('  --all             Delete ALL memories');
    closeDb();
  } catch (error: any) {
    console.error('Error:', error.message);
    closeDb();
    process.exit(1);
  }
}

/**
 * Parse relative date strings like "30d", "1w", "3m"
 */
function parseRelativeDate(input: string): Date | null {
  const now = new Date();

  // Try relative format: 30d, 1w, 3m, 1y
  const match = input.match(/^(\d+)([dwmy])$/i);
  if (match) {
    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case 'd':
        return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
      case 'w':
        return new Date(now.getTime() - amount * 7 * 24 * 60 * 60 * 1000);
      case 'm':
        return new Date(now.getTime() - amount * 30 * 24 * 60 * 60 * 1000);
      case 'y':
        return new Date(now.getTime() - amount * 365 * 24 * 60 * 60 * 1000);
    }
  }

  // Try ISO date
  const date = new Date(input);
  if (!isNaN(date.getTime())) {
    return date;
  }

  return null;
}
