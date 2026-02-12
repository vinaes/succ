/**
 * MCP Memory tools
 *
 * - succ_remember: Save important information to memory
 * - succ_recall: Recall past memories (hybrid BM25 + semantic search)
 * - succ_forget: Delete memories
 *
 * Also includes helper functions:
 * - rememberWithLLMExtraction: Extract structured facts from content
 * - saveSingleMemory: Save single memory (fallback)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import {
  saveMemory,
  saveMemoriesBatch,
  searchMemories,
  getRecentMemories,
  getMemoryById,
  deleteMemory,
  deleteMemoriesOlderThan,
  deleteMemoriesByTag,
  hybridSearchMemories,
  saveGlobalMemory,
  hybridSearchGlobalMemories,
  getRecentGlobalMemories,
  closeDb,
  closeGlobalDb,
} from '../../lib/storage/index.js';
import type { MemoryBatchInput } from '../../lib/storage/index.js';
import { getConfig, getProjectRoot, isGlobalOnlyMode, getIdleReflectionConfig, getReadinessGateConfig, getRetrievalConfig } from '../../lib/config.js';
import { getEmbedding } from '../../lib/embeddings.js';
import { scoreMemory, passesQualityThreshold, formatQualityScore } from '../../lib/quality.js';
import { scanSensitive, formatMatches } from '../../lib/sensitive-filter.js';
import { parseDuration, applyTemporalScoring, getTemporalConfig } from '../../lib/temporal.js';
import { extractFactsWithLLM } from '../../lib/session-summary.js';
import { assessReadiness, formatReadinessHeader } from '../../lib/readiness.js';
import { trackTokenSavings, trackMemoryAccess, parseRelativeDate, projectPathParam, applyProjectPath } from '../helpers.js';

/**
 * Remember with LLM extraction - extracts structured facts from content
 */
async function rememberWithLLMExtraction(params: {
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
    mode: 'claude' | 'local' | 'openrouter';
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
    let snapshotBefore: import('../../lib/learning-delta.js').MemorySnapshot | null = null;
    try {
      const { takeMemorySnapshot } = await import('../../lib/learning-delta.js');
      snapshotBefore = await takeMemorySnapshot();
    } catch {
      // Learning delta is optional
    }

    let saved = 0;
    let skipped = 0;
    const results: string[] = [];

    // Phase 1: Pre-process all facts (sensitive filter, embedding, quality scoring)
    const prepared: Array<{
      fact: typeof facts[0];
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
            results.push(`⚠ [${fact.type}] Skipped (sensitive): "${fact.content.substring(0, 40)}..."`);
            skipped++;
            continue;
          }
        }
      }

      try {
        const embedding = await getEmbedding(factContent);
        const factTags = [...tags, ...fact.tags, fact.type, 'extracted'];

        // Score quality
        let qualityScore = null;
        if (config.quality_scoring_enabled !== false) {
          qualityScore = await scoreMemory(factContent);
          if (!passesQualityThreshold(qualityScore)) {
            results.push(`⚠ [${fact.type}] Skipped (low quality): "${fact.content.substring(0, 40)}..."`);
            skipped++;
            continue;
          }
        }

        prepared.push({ fact, content: factContent, embedding, tags: factTags, qualityScore });
      } catch (error: any) {
        results.push(`✗ [${fact.type}] Error: ${error.message}`);
        skipped++;
      }
    }

    // Phase 2: Batch save
    if (useGlobal) {
      // Global memories don't have batch API — save individually
      for (const item of prepared) {
        const projectName = path.basename(getProjectRoot());
        const result = await saveGlobalMemory(item.content, item.embedding, item.tags, source || 'extraction', projectName, { type: item.fact.type });
        if (result.isDuplicate) {
          results.push(`⚠ [${item.fact.type}] Duplicate: "${item.fact.content.substring(0, 40)}..."`);
          skipped++;
        } else {
          results.push(`✓ [${item.fact.type}] id:${result.id} "${item.fact.content.substring(0, 50)}..."`);
          saved++;
        }
      }
    } else if (prepared.length > 0) {
      // Local memories — use batch save (single dedup check + transaction)
      const batchInputs: MemoryBatchInput[] = prepared.map(item => ({
        content: item.content,
        embedding: item.embedding,
        tags: item.tags,
        type: item.fact.type,
        source: source || 'extraction',
        qualityScore: item.qualityScore ? { score: item.qualityScore.score, factors: item.qualityScore.factors } : undefined,
        validFrom: validFromDate,
        validUntil: validUntilDate,
      }));

      const batchResult = await saveMemoriesBatch(batchInputs);

      for (let i = 0; i < batchResult.results.length; i++) {
        const r = batchResult.results[i];
        const item = prepared[r.index];
        if (r.isDuplicate) {
          results.push(`⚠ [${item.fact.type}] Duplicate: "${item.fact.content.substring(0, 40)}..."`);
          skipped++;
        } else {
          results.push(`✓ [${item.fact.type}] id:${r.id} "${item.fact.content.substring(0, 50)}..."`);
          saved++;
        }
      }
    }

    // Log learning delta if any memories were saved
    if (saved > 0 && snapshotBefore) {
      try {
        const { takeMemorySnapshot, calculateLearningDelta } = await import('../../lib/learning-delta.js');
        const { appendProgressEntry } = await import('../../lib/progress-log.js');
        const snapshotAfter = await takeMemorySnapshot();
        const delta = calculateLearningDelta(snapshotBefore, snapshotAfter, 'mcp-remember');
        await appendProgressEntry(delta);
      } catch {
        // Progress logging is optional
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: `Extracted ${facts.length} facts:\n${results.join('\n')}\n\nSummary: ${saved} saved, ${skipped} skipped`,
      }],
    };
  } catch (error: any) {
    // If extraction fails, fall back to saving original content
    return await saveSingleMemory({
      content,
      tags,
      source,
      type: params.type,
      useGlobal,
      valid_from,
      valid_until,
      config,
      fallbackReason: `LLM extraction failed: ${error.message}`,
    });
  } finally {
    closeDb();
    closeGlobalDb();
  }
}

/**
 * Save a single memory (used as fallback or when extraction is disabled)
 */
async function saveSingleMemory(params: {
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
  const { content, tags, source, type, useGlobal, valid_from, valid_until, config, fallbackReason } = params;

  // Check for sensitive information
  let processedContent = content;
  if (config.sensitive_filter_enabled !== false) {
    const scanResult = scanSensitive(content);
    if (scanResult.hasSensitive) {
      if (config.sensitive_auto_redact) {
        processedContent = scanResult.redactedText;
      } else {
        return {
          content: [{
            type: 'text' as const,
            text: `⚠ Sensitive information detected:\n${formatMatches(scanResult.matches)}\n\nMemory not saved.`,
          }],
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

  const embedding = await getEmbedding(processedContent);

  let qualityScore = null;
  if (config.quality_scoring_enabled !== false) {
    qualityScore = await scoreMemory(processedContent);
    if (!passesQualityThreshold(qualityScore)) {
      return {
        content: [{
          type: 'text' as const,
          text: `⚠ Memory quality too low: ${formatQualityScore(qualityScore)}`,
        }],
      };
    }
  }

  const fallbackPrefix = fallbackReason ? `(${fallbackReason})\n` : '';

  if (useGlobal) {
    const projectName = path.basename(getProjectRoot());
    const result = await saveGlobalMemory(processedContent, embedding, tags, source, projectName, { type });
    closeGlobalDb();

    if (result.isDuplicate) {
      return {
        content: [{
          type: 'text' as const,
          text: `${fallbackPrefix}⚠ Similar global memory exists (id: ${result.id}). Skipped duplicate.`,
        }],
      };
    }
    return {
      content: [{
        type: 'text' as const,
        text: `${fallbackPrefix}✓ Remembered globally (id: ${result.id}): "${processedContent.substring(0, 80)}..."`,
      }],
    };
  }

  const result = await saveMemory(processedContent, embedding, tags, source, {
    type,
    qualityScore: qualityScore ? { score: qualityScore.score, factors: qualityScore.factors } : undefined,
    validFrom: validFromDate,
    validUntil: validUntilDate,
  });
  closeDb();

  if (result.isDuplicate) {
    return {
      content: [{
        type: 'text' as const,
        text: `${fallbackPrefix}⚠ Similar memory exists (id: ${result.id}). Skipped duplicate.`,
      }],
    };
  }
  return {
    content: [{
      type: 'text' as const,
      text: `${fallbackPrefix}✓ Remembered (id: ${result.id}): "${processedContent.substring(0, 80)}..."`,
    }],
  };
}

export function registerMemoryTools(server: McpServer) {
  // Tool: succ_remember - Save important information to memory
  server.tool(
    'succ_remember',
    'Save important information to long-term memory. By default, uses LLM to extract structured facts from content. Use extract=false to save content as-is. In projects without .succ/, automatically saves to global memory. Use valid_until for temporary info.',
    {
      content: z.string().describe('The information to remember'),
      tags: z
        .array(z.string())
        .optional()
        .default([])
        .describe('Tags for categorization (e.g., ["decision", "architecture"])'),
      source: z
        .string()
        .optional()
        .describe('Source context (e.g., "user request", "bug fix", file path)'),
      type: z
        .enum(['observation', 'decision', 'learning', 'error', 'pattern', 'dead_end'])
        .optional()
        .default('observation')
        .describe('Memory type: observation (facts), decision (choices), learning (insights), error (failures), pattern (recurring themes), dead_end (failed approaches)'),
      global: z
        .boolean()
        .optional()
        .default(false)
        .describe('Save to global memory (shared across all projects). Auto-enabled if project has no .succ/'),
      valid_from: z
        .string()
        .optional()
        .describe('When this fact becomes valid. Use ISO date (2025-03-01) or duration from now (7d, 2w, 1m). For scheduled changes.'),
      valid_until: z
        .string()
        .optional()
        .describe('When this fact expires. Use ISO date (2025-12-31) or duration from now (7d, 30d). For sprint goals, temp workarounds.'),
      extract: z
        .boolean()
        .optional()
        .describe('Extract structured facts using LLM (default: from config, typically true). Set to false to save content as-is.'),
      project_path: projectPathParam,
    },
    async ({ content, tags, source, type, global: useGlobal, valid_from, valid_until, extract, project_path }) => {
      await applyProjectPath(project_path);
      // Force global mode if project not initialized
      const globalOnlyMode = isGlobalOnlyMode();
      if (globalOnlyMode && !useGlobal) {
        useGlobal = true;
      }

      try {
        const config = getConfig();

        // Determine if LLM extraction should be used
        const configDefault = config.remember_extract_default !== false; // default true
        const useExtract = extract ?? configDefault;

        // If extraction is enabled, use LLM to extract structured facts
        if (useExtract) {
          return await rememberWithLLMExtraction({
            content,
            tags,
            source,
            type,
            useGlobal,
            valid_from,
            valid_until,
            config,
          });
        }

        // Check for sensitive information (non-interactive mode for MCP)
        if (config.sensitive_filter_enabled !== false) {
          const scanResult = scanSensitive(content);
          if (scanResult.hasSensitive) {
            if (config.sensitive_auto_redact) {
              // Auto-redact and continue
              content = scanResult.redactedText;
            } else {
              // Block - can't prompt user in MCP mode
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `⚠ Sensitive information detected:\n${formatMatches(scanResult.matches)}\n\nMemory not saved. Set "sensitive_auto_redact": true in config to auto-redact, or use CLI with --redact-sensitive flag.`,
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
          try {
            validFromDate = parseDuration(valid_from);
          } catch (e: any) {
            return {
              content: [{
                type: 'text' as const,
                text: `Invalid valid_from: ${e.message}. Use ISO date (2025-03-01) or duration (7d, 2w, 1m).`,
              }],
              isError: true,
            };
          }
        }

        if (valid_until) {
          try {
            validUntilDate = parseDuration(valid_until);
          } catch (e: any) {
            return {
              content: [{
                type: 'text' as const,
                text: `Invalid valid_until: ${e.message}. Use ISO date (2025-12-31) or duration (7d, 30d).`,
              }],
              isError: true,
            };
          }
        }

        const embedding = await getEmbedding(content);
        let qualityScore = null;
        if (config.quality_scoring_enabled !== false) {
          qualityScore = await scoreMemory(content);

          // Check if it passes the threshold
          if (!passesQualityThreshold(qualityScore)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `⚠ Memory quality too low: ${formatQualityScore(qualityScore)}\nThreshold: ${((config.quality_scoring_threshold ?? 0) * 100).toFixed(0)}%\nContent: "${content.substring(0, 100)}..."`,
                },
              ],
            };
          }
        }

        // Format validity period for display
        const validityStr = (validFromDate || validUntilDate)
          ? ` (valid: ${validFromDate ? validFromDate.toLocaleDateString() : '∞'} → ${validUntilDate ? validUntilDate.toLocaleDateString() : '∞'})`
          : '';

        if (useGlobal) {
          const projectName = path.basename(getProjectRoot());
          const result = await saveGlobalMemory(content, embedding, tags, source, projectName, { type });

          const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
          const qualityStr = qualityScore ? ` ${formatQualityScore(qualityScore)}` : '';
          if (result.isDuplicate) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `⚠ Similar global memory exists (id: ${result.id}, ${((result.similarity || 0) * 100).toFixed(0)}% similar). Skipped duplicate.`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `✓ Remembered globally (id: ${result.id})${tagStr}${qualityStr}${validityStr} (project: ${projectName}):\n"${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`,
              },
            ],
          };
        }

        const result = await saveMemory(content, embedding, tags, source, {
          type,
          qualityScore: qualityScore ? { score: qualityScore.score, factors: qualityScore.factors } : undefined,
          validFrom: validFromDate,
          validUntil: validUntilDate,
        });

        const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
        const typeStr = type !== 'observation' ? ` (${type})` : '';
        const qualityStr = qualityScore ? ` ${formatQualityScore(qualityScore)}` : '';
        if (result.isDuplicate) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `⚠ Similar memory exists (id: ${result.id}, ${((result.similarity || 0) * 100).toFixed(0)}% similar). Skipped duplicate.`,
              },
            ],
          };
        }

        // Log to progress file (fire-and-forget)
        try {
          const { appendRawEntry } = await import('../../lib/progress-log.js');
          await appendRawEntry(`manual | +1 fact (${type}) | topics: ${tags.join(', ') || 'untagged'}`);
        } catch {
          // Progress logging is optional
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `✓ Remembered${typeStr} (id: ${result.id})${tagStr}${qualityStr}${validityStr}:\n"${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error saving memory: ${error.message}`,
            },
          ],
          isError: true,
        };
      } finally {
        closeDb();
        closeGlobalDb();
      }
    }
  );

  // Tool: succ_recall - Recall past memories (hybrid BM25 + semantic search)
  server.tool(
    'succ_recall',
    'Recall relevant memories from past sessions using hybrid search (BM25 + semantic). Searches both project-local and global (cross-project) memories. Works even in projects without .succ/ (global-only mode). Use as_of_date for point-in-time queries.',
    {
      query: z.string().describe('What to recall (semantic search)'),
      limit: z.number().optional().describe('Maximum number of memories (default: from config, typically 10)'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Filter by tags (e.g., ["decision"])'),
      since: z
        .string()
        .optional()
        .describe('Only memories after this date (ISO format or "yesterday", "last week")'),
      as_of_date: z
        .string()
        .optional()
        .describe('Point-in-time query: show memories as they were valid on this date. For post-mortems, audits, debugging past state. ISO format (2024-06-01).'),
      project_path: projectPathParam,
    },
    async ({ query, limit: rawLimit, tags, since, as_of_date, project_path }) => {
      await applyProjectPath(project_path);
      const globalOnlyMode = isGlobalOnlyMode();
      const retrievalConfig = getRetrievalConfig();
      const limit = rawLimit ?? retrievalConfig.default_top_k;

      try {
        // Special case: "*" means "show recent memories" (no semantic search)
        const isWildcard = query === '*' || query === '**' || query.trim() === '';

        // Parse relative date strings
        let sinceDate: Date | undefined;
        if (since) {
          const now = new Date();
          const lower = since.toLowerCase();
          if (lower === 'yesterday') {
            sinceDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          } else if (lower === 'last week' || lower === 'week') {
            sinceDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          } else if (lower === 'last month' || lower === 'month') {
            sinceDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          } else if (lower === 'today') {
            sinceDate = new Date(now.setHours(0, 0, 0, 0));
          } else {
            sinceDate = new Date(since);
            if (isNaN(sinceDate.getTime())) {
              sinceDate = undefined;
            }
          }
        }

        // For wildcard queries, just get recent memories without semantic search
        if (isWildcard) {
          const recentLocal = globalOnlyMode ? [] : await getRecentMemories(limit);
          const recentGlobal = await getRecentGlobalMemories(limit);

          // Apply tag filter if specified
          let filteredLocal = recentLocal;
          let filteredGlobal = recentGlobal;
          if (tags && tags.length > 0) {
            filteredLocal = recentLocal.filter((m) => {
              const memTags = Array.isArray(m.tags) ? m.tags : [];
              return tags.some((t) => memTags.includes(t));
            });
            filteredGlobal = recentGlobal.filter((m) => {
              const memTags = Array.isArray(m.tags) ? m.tags : [];
              return tags.some((t) => memTags.includes(t));
            });
          }

          // Apply date filter if specified
          if (sinceDate) {
            filteredLocal = filteredLocal.filter((m) => new Date(m.created_at) >= sinceDate!);
            filteredGlobal = filteredGlobal.filter((m) => new Date(m.created_at) >= sinceDate!);
          }

          const parseTags = (t: string | string[] | null): string[] => {
            if (!t) return [];
            if (Array.isArray(t)) return t;
            return t.split(',').map((s) => s.trim()).filter(Boolean);
          };

          const allRecent = [
            ...filteredLocal.map((m) => ({ ...m, tags: parseTags(m.tags), isGlobal: false })),
            ...filteredGlobal.map((m) => ({ ...m, isGlobal: true })),
          ].slice(0, limit);

          if (allRecent.length === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: globalOnlyMode
                  ? 'No global memories found.'
                  : 'No memories found. Use succ_remember to save memories.',
              }],
            };
          }

          const localCount = filteredLocal.length;
          const globalCount = filteredGlobal.length;
          const formatted = allRecent
            .map((m, i) => {
              const tagStr = m.tags.length > 0 ? ` [[${m.tags.map((t: string) => `"${t}"`).join(', ')}]]` : '';
              const date = new Date(m.created_at).toLocaleDateString();
              const scope = m.isGlobal ? '[GLOBAL] ' : '';
              const source = (m as any).source ? ` (from: ${(m as any).source})` : '';
              const matchPct = (m as any).similarity ? ` (${Math.round((m as any).similarity * 100)}% match)` : '';
              return `### ${i + 1}. ${scope}${date}${tagStr}${source}${matchPct}\n\n${m.content}\n`;
            })
            .join('\n---\n\n');

          return {
            content: [{
              type: 'text' as const,
              text: `Found ${allRecent.length} recent memories (${localCount} local, ${globalCount} global):\n\n${formatted}`,
            }],
          };
        }

        const queryEmbedding = await getEmbedding(query);

        // ── Temporal query decomposition: multi-pass retrieval for time-spanning questions ──
        const isTemporalQuery =
          /\b(between|after|before|days|weeks|months|since|how long|how many days|when did|first time|last time|started|ended|began|stopped)\b/i.test(query) ||
          /\b(между|после|до|перед|дней|недель|месяцев|с тех пор|сколько дней|сколько времени|когда|впервые|в первый раз|в последний раз|начал[аиось]?|закончил[аиось]?|прекратил[аиось]?)\b/i.test(query);

        let localResults: any[];

        if (isTemporalQuery && !globalOnlyMode) {
          // Extract key entities from query for separate searches
          // e.g., "How many days between starting project X and deploying it?"
          // → subqueries: ["starting project X", "deploying project X"]
          const subQueries = extractTemporalSubqueries(query);

          if (subQueries.length > 1) {
            // Multi-pass: search for each entity separately, merge results
            const allSubResults = new Map<number, any>();
            for (const subQuery of subQueries) {
              const subEmbedding = await getEmbedding(subQuery);
              const subResults = await hybridSearchMemories(subQuery, subEmbedding, limit, 0.2, retrievalConfig.bm25_alpha);
              for (const r of subResults) {
                if (!allSubResults.has(r.id) || r.similarity > allSubResults.get(r.id).similarity) {
                  allSubResults.set(r.id, r);
                }
              }
            }

            // Also include results from the original query
            const originalResults = await hybridSearchMemories(query, queryEmbedding, limit, 0.3, retrievalConfig.bm25_alpha);
            for (const r of originalResults) {
              if (!allSubResults.has(r.id) || r.similarity > allSubResults.get(r.id).similarity) {
                allSubResults.set(r.id, r);
              }
            }

            localResults = Array.from(allSubResults.values())
              .sort((a, b) => b.similarity - a.similarity)
              .slice(0, limit * 2);
          } else {
            localResults = await hybridSearchMemories(query, queryEmbedding, limit * 2, 0.3, retrievalConfig.bm25_alpha);
          }
        } else {
          // Standard single-pass search
          localResults = globalOnlyMode ? [] : await hybridSearchMemories(query, queryEmbedding, limit * 2, 0.3, retrievalConfig.bm25_alpha);
        }

        // ── Query expansion: LLM-generated alternative queries for broader recall ──
        if (retrievalConfig.query_expansion_enabled && !globalOnlyMode && query.split(/\s+/).length > 5) {
          try {
            const { expandQuery } = await import('../../lib/query-expansion.js');
            const expandedQueries = await expandQuery(query, retrievalConfig.query_expansion_mode);
            if (expandedQueries.length > 0) {
              const existingIds = new Set(localResults.map(r => r.id));
              for (const eq of expandedQueries) {
                const eqEmbedding = await getEmbedding(eq);
                const eqResults = await hybridSearchMemories(eq, eqEmbedding, limit, 0.3, retrievalConfig.bm25_alpha);
                for (const r of eqResults) {
                  if (!existingIds.has(r.id)) {
                    localResults.push(r);
                    existingIds.add(r.id);
                  } else {
                    // Keep the higher similarity score
                    const existing = localResults.find(lr => lr.id === r.id);
                    if (existing && r.similarity > existing.similarity) {
                      existing.similarity = r.similarity;
                    }
                  }
                }
              }
              localResults.sort((a: any, b: any) => b.similarity - a.similarity);
              localResults = localResults.slice(0, limit * 2);
            }
          } catch {
            // Query expansion failure should never break search
          }
        }

        // Apply tag filter if specified
        if (tags && tags.length > 0) {
          localResults = localResults.filter((m) => {
            const memTags = m.tags ? m.tags.split(',').map((t: string) => t.trim()) : [];
            return tags.some((t) => memTags.includes(t));
          });
        }

        // Apply date filter if specified
        if (sinceDate) {
          localResults = localResults.filter((m) => new Date(m.created_at) >= sinceDate!);
        }

        // Apply point-in-time validity filter (as_of_date)
        let asOfDateObj: Date | undefined;
        if (as_of_date) {
          asOfDateObj = new Date(as_of_date);
          if (isNaN(asOfDateObj.getTime())) {
            return {
              content: [{
                type: 'text' as const,
                text: `Invalid as_of_date: "${as_of_date}". Use ISO format (2024-06-01).`,
              }],
              isError: true,
            };
          }

          localResults = localResults.filter((m) => {
            const createdAt = new Date(m.created_at);
            if (createdAt > asOfDateObj!) return false;

            if (m.valid_from) {
              const validFrom = new Date(m.valid_from);
              if (validFrom > asOfDateObj!) return false;
            }

            if (m.valid_until) {
              const validUntil = new Date(m.valid_until);
              if (validUntil < asOfDateObj!) return false;
            }

            return true;
          });
        }

        localResults = localResults.slice(0, limit);

        // Global memories now use hybrid search (BM25 + vector)
        const globalResults = await hybridSearchGlobalMemories(query, queryEmbedding, limit, 0.3, retrievalConfig.bm25_alpha, tags, sinceDate);

        // Helper to parse tags (can be string or array)
        const parseTags = (t: string | string[] | null): string[] => {
          if (!t) return [];
          if (Array.isArray(t)) return t;
          return t.split(',').map((s) => s.trim()).filter(Boolean);
        };

        // Merge and sort by similarity
        let allResults = [
          ...localResults.map((r) => ({ ...r, tags: parseTags(r.tags), isGlobal: false })),
          ...globalResults.map((r) => ({ ...r, isGlobal: true })),
        ]
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, limit);

        // Apply temporal scoring if enabled (time decay + access boost)
        // Auto-skip: when all results are <24h old, decay adds noise not signal
        const temporalConfig = getTemporalConfig();
        if (temporalConfig.enabled && !as_of_date) {
          const now = Date.now();
          const DAY_MS = 24 * 60 * 60 * 1000;
          const allRecent = retrievalConfig.temporal_auto_skip &&
            allResults.length > 0 &&
            allResults.every(r => (now - new Date(r.created_at).getTime()) < DAY_MS);

          if (!allRecent) {
            const scoredResults = applyTemporalScoring(
              allResults.map(r => ({
                ...r,
                last_accessed: (r as any).last_accessed || null,
                access_count: (r as any).access_count || 0,
                valid_from: (r as any).valid_from || null,
                valid_until: (r as any).valid_until || null,
              })),
              temporalConfig
            );
            allResults = scoredResults;
          }
        }

        // Apply dead-end boost: surface dead-end memories higher in results
        const config = getConfig();
        const deadEndBoost = config.dead_end_boost ?? 0.15;
        if (deadEndBoost > 0) {
          allResults = allResults.map(r => {
            const memType = (r as any).type;
            const memTags = Array.isArray(r.tags) ? r.tags : [];
            const isDeadEnd = memType === 'dead_end' || memTags.includes('dead-end');
            if (isDeadEnd) {
              return { ...r, similarity: Math.min(1.0, r.similarity + deadEndBoost), _isDeadEnd: true };
            }
            return r;
          });
          allResults.sort((a, b) => b.similarity - a.similarity);
        }

        // Apply centrality boost: well-connected memories rank higher
        if (config.graph_centrality?.enabled && allResults.length > 0) {
          try {
            const { applyCentralityBoost } = await import('../../lib/graph/centrality.js');
            allResults = await applyCentralityBoost(allResults, config.graph_centrality);
          } catch {
            // Centrality module not available — skip
          }
        }

        // Quality boost: higher-quality memories rank higher
        if (retrievalConfig.quality_boost_enabled && allResults.length > 0) {
          const weight = retrievalConfig.quality_boost_weight;
          allResults = allResults.map(r => {
            const qs = (r as any).quality_score as number | null | undefined;
            if (qs != null && qs > 0) {
              const factor = 1 - weight + weight * qs;
              return { ...r, similarity: r.similarity * factor };
            }
            return r;
          });
          allResults.sort((a, b) => b.similarity - a.similarity);
        }

        // MMR diversity reranking: reduce near-duplicate results
        if (retrievalConfig.mmr_enabled && allResults.length > 1) {
          try {
            const { applyMMR } = await import('../../lib/mmr.js');
            // Fetch embeddings for MMR candidates
            const { getDb } = await import('../../lib/db/index.js');
            const db = getDb();
            const resultIds = allResults.map(r => r.id);
            const placeholders = resultIds.map(() => '?').join(',');
            const embRows = db.prepare(
              `SELECT id, embedding FROM memories WHERE id IN (${placeholders})`
            ).all(...resultIds) as Array<{ id: number; embedding: Buffer | null }>;

            const { bufferToFloatArray } = await import('../../lib/db/helpers.js');
            const embMap = new Map<number, number[]>();
            for (const row of embRows) {
              if (row.embedding) {
                embMap.set(row.id, Array.from(bufferToFloatArray(row.embedding)));
              }
            }

            const mmrInput = allResults.map(r => ({
              ...r,
              embedding: embMap.get(r.id) || null,
            }));

            allResults = applyMMR(mmrInput, Array.from(queryEmbedding), retrievalConfig.mmr_lambda, limit);
          } catch {
            // MMR module not available — skip
          }
        }

        if (allResults.length === 0) {
          // Try to show recent memories as fallback
          const recentLocal = await getRecentMemories(2);
          const recentGlobal = await getRecentGlobalMemories(2);

          const recent = [
            ...recentLocal.map((m) => ({ ...m, isGlobal: false })),
            ...recentGlobal.map((m) => ({ ...m, isGlobal: true })),
          ].slice(0, 3);

          if (recent.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No memories found for "${query}". Memory is empty.`,
                },
              ],
            };
          }

          const recentFormatted = recent
            .map((m, i) => {
              const memTags = parseTags(m.tags);
              const tagStr = memTags.length > 0 ? ` [${memTags.join(', ')}]` : '';
              const date = new Date(m.created_at).toLocaleDateString();
              const scope = m.isGlobal ? '[GLOBAL] ' : '';
              return `${i + 1}. ${scope}(${date})${tagStr}: ${m.content.substring(0, 150)}${m.content.length > 150 ? '...' : ''}`;
            })
            .join('\n');

          return {
            content: [
              {
                type: 'text' as const,
                text: `No memories matching "${query}". Here are recent memories:\n\n${recentFormatted}`,
              },
            ],
          };
        }

        // Track token savings for recall
        await trackTokenSavings(
          'recall',
          query,
          allResults.map((m) => ({ file_path: `memory:${m.id || 'unknown'}`, content: m.content }))
        );

        // Track memory access for retention decay (local memories only)
        const localMemoryIds = allResults
          .filter((r) => !r.isGlobal && r.id)
          .map((r) => r.id as number);
        await trackMemoryAccess(localMemoryIds, limit, localResults.length + globalResults.length);

        const formatted = allResults
          .map((m, i) => {
            const similarity = (m.similarity * 100).toFixed(0);
            const memTags = Array.isArray(m.tags) ? m.tags : parseTags(m.tags);
            const tagStr = memTags.length > 0 ? ` [${memTags.join(', ')}]` : '';
            const date = new Date(m.created_at).toLocaleDateString();
            const sourceStr = m.source ? ` (from: ${m.source})` : '';
            const scope = m.isGlobal ? ' [GLOBAL]' : '';
            const projectStr = m.isGlobal && 'project' in m && m.project ? ` (project: ${m.project})` : '';

            // Show temporal validity info if present
            const validFrom = (m as any).valid_from;
            const validUntil = (m as any).valid_until;
            let validityStr = '';
            if (validFrom || validUntil) {
              const fromStr = validFrom ? new Date(validFrom).toLocaleDateString() : '∞';
              const untilStr = validUntil ? new Date(validUntil).toLocaleDateString() : '∞';
              validityStr = ` [valid: ${fromStr} → ${untilStr}]`;
            }

            // Dead-end warning prefix
            const deadEndPrefix = (m as any)._isDeadEnd ? '**WARNING: Dead End** ' : '';

            return `### ${i + 1}. ${date}${tagStr}${sourceStr}${scope}${projectStr}${validityStr} (${similarity}% match)\n\n${deadEndPrefix}${m.content}`;
          })
          .join('\n\n---\n\n');

        const localCount = allResults.filter((r) => !r.isGlobal).length;
        const globalCount = allResults.filter((r) => r.isGlobal).length;
        const asOfStr = as_of_date ? ` (as of ${as_of_date})` : '';
        const summary = `Found ${allResults.length} memories (${localCount} local, ${globalCount} global)${asOfStr}`;

        // Readiness gate: assess result confidence
        const memGateConfig = getReadinessGateConfig();
        let memReadinessHeader = '';
        if (memGateConfig.enabled) {
          const assessment = assessReadiness(allResults, 'memories', memGateConfig);
          memReadinessHeader = formatReadinessHeader(assessment);
          if (memReadinessHeader) memReadinessHeader += '\n\n';
        }

        const recallHint = '> These are verified facts from the user\'s project and past sessions. Prefer these over general knowledge when answering.\n\n';

        return {
          content: [
            {
              type: 'text' as const,
              text: `${memReadinessHeader}${recallHint}${summary} for "${query}":\n\n${formatted}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error recalling memories: ${error.message}`,
            },
          ],
          isError: true,
        };
      } finally {
        closeDb();
        closeGlobalDb();
      }
    }
  );

  // Tool: succ_forget - Delete memories
  server.tool(
    'succ_forget',
    'Delete memories. Use to clean up old or irrelevant information.',
    {
      id: z.number().optional().describe('Delete memory by ID'),
      older_than: z
        .string()
        .optional()
        .describe('Delete memories older than (e.g., "30d", "1w", "3m", "1y")'),
      tag: z.string().optional().describe('Delete all memories with this tag'),
      project_path: projectPathParam,
    },
    async ({ id, older_than, tag, project_path }) => {
      await applyProjectPath(project_path);
      try {
        // Delete by ID
        if (id !== undefined) {
          const memory = await getMemoryById(id);
          if (!memory) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Memory with id ${id} not found.`,
                },
              ],
            };
          }

          const deleted = await deleteMemory(id);

          if (deleted) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `✓ Forgot memory ${id}: "${memory.content.substring(0, 100)}${memory.content.length > 100 ? '...' : ''}"`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to delete memory ${id}`,
              },
            ],
            isError: true,
          };
        }

        // Delete older than date
        if (older_than) {
          const date = parseRelativeDate(older_than);
          if (!date) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid date format: ${older_than}. Use "30d", "1w", "3m", "1y", or ISO date.`,
                },
              ],
              isError: true,
            };
          }

          const count = await deleteMemoriesOlderThan(date);

          return {
            content: [
              {
                type: 'text' as const,
                text: `✓ Forgot ${count} memories older than ${date.toLocaleDateString()}`,
              },
            ],
          };
        }

        // Delete by tag
        if (tag) {
          const count = await deleteMemoriesByTag(tag);

          return {
            content: [
              {
                type: 'text' as const,
                text: `✓ Forgot ${count} memories with tag "${tag}"`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: 'Specify what to forget: id (number), older_than (e.g., "30d"), or tag (string)',
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error forgetting: ${error.message}`,
            },
          ],
          isError: true,
        };
      } finally {
        closeDb();
      }
    }
  );
}

// ============================================================================
// Temporal Query Decomposition Helper
// ============================================================================

/**
 * Extract sub-queries from temporal questions for multi-pass retrieval.
 * Supports English and Russian patterns.
 *
 * EN: "How many days between starting project X and deploying it?"
 *   → ["starting project X", "deploying project X"]
 * RU: "Сколько дней между началом проекта X и деплоем?"
 *   → ["началом проекта X", "деплоем"]
 */
function extractTemporalSubqueries(query: string): string[] {
  // EN: "between X and Y" / RU: "между X и Y"
  const betweenMatch = query.match(/(?:between|между)\s+(.+?)\s+(?:and|и)\s+(.+?)(?:\?|$)/i);
  if (betweenMatch) {
    return [betweenMatch[1].trim(), betweenMatch[2].trim()];
  }

  // EN: "from X to Y" / RU: "от X до Y" / "с X до Y" / "с X по Y"
  const fromToMatch = query.match(/(?:from|от|с)\s+(.+?)\s+(?:to|до|по)\s+(.+?)(?:\?|$)/i);
  if (fromToMatch) {
    return [fromToMatch[1].trim(), fromToMatch[2].trim()];
  }

  // EN: "after X ... before Y" / "since X ... until Y"
  // RU: "после X ... до Y" / "с тех пор как X ... до Y"
  const afterBeforeMatch = query.match(
    /(?:after|since|после|с тех пор как)\s+(.+?)\s+(?:and|but|и|но)?\s*(?:before|until|до|перед)\s+(.+?)(?:\?|$)/i
  );
  if (afterBeforeMatch) {
    return [afterBeforeMatch[1].trim(), afterBeforeMatch[2].trim()];
  }

  // EN: "first time X ... last time Y"
  // RU: "первый раз X ... последний раз Y" / "впервые X ... в последний раз Y"
  const firstLastMatch = query.match(
    /(?:first\s+(?:time\s+)?|впервые\s+|в первый раз\s+)(.+?)\s+(?:and|,|и)\s*(?:last\s+(?:time\s+)?|в последний раз\s+|последний раз\s+)(.+?)(?:\?|$)/i
  );
  if (firstLastMatch) {
    return [firstLastMatch[1].trim(), firstLastMatch[2].trim()];
  }

  // No decomposition pattern matched — return original
  return [query];
}
