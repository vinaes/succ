#!/usr/bin/env node
/**
 * succ MCP Server
 *
 * Exposes succ functionality as MCP tools that Claude can call directly:
 * - succ_search: Semantic search in brain vault
 * - succ_remember: Save important information to memory
 * - succ_recall: Recall past memories semantically
 * - succ_index: Index/reindex files
 * - succ_status: Get index status
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  searchDocuments,
  hybridSearchCode,
  hybridSearchDocs,
  hybridSearchMemories,
  getStats,
  closeDb,
  saveMemory,
  searchMemories,
  getRecentMemories,
  getMemoryStats,
  deleteMemory,
  deleteMemoriesOlderThan,
  deleteMemoriesByTag,
  getMemoryById,
  updateMemoriesBm25Index,
  // Global memory
  saveGlobalMemory,
  searchGlobalMemories,
  getRecentGlobalMemories,
  closeGlobalDb,
  // Knowledge graph
  createMemoryLink,
  deleteMemoryLink,
  getMemoryWithLinks,
  findConnectedMemories,
  autoLinkSimilarMemories,
  getGraphStats,
  LINK_RELATIONS,
  type LinkRelation,
  // Token stats
  getTokenStatsAggregated,
  getTokenStatsSummary,
  // Retention/access tracking
  incrementMemoryAccessBatch,
} from './lib/db.js';
import { getConfig, getProjectRoot, getSuccDir, getDaemonStatuses } from './lib/config.js';
import path from 'path';
import fs from 'fs';
import { getEmbedding, cleanupEmbeddings } from './lib/embeddings.js';
import { index } from './commands/index.js';
import { analyzeFile } from './commands/analyze.js';
import { scoreMemory, passesQualityThreshold, formatQualityScore, cleanupQualityScoring } from './lib/quality.js';
import { scanSensitive, formatMatches } from './lib/sensitive-filter.js';
import { countTokens, countTokensArray, formatTokens, compressionPercent } from './lib/token-counter.js';
import { recordTokenStat, type TokenEventType } from './lib/db.js';
import { getIdleReflectionConfig } from './lib/config.js';
import { parseDuration, applyTemporalScoring, getTemporalConfig } from './lib/temporal.js';

// Graceful shutdown handler
function setupGracefulShutdown() {
  const cleanup = () => {
    cleanupEmbeddings();
    cleanupQualityScoring();
    closeDb();
    closeGlobalDb();
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGHUP', cleanup);
}

// Helper: Track token savings for RAG queries
interface SearchResult {
  file_path: string;
  content: string;
}

function trackTokenSavings(
  eventType: TokenEventType,
  query: string,
  results: SearchResult[]
): void {
  if (results.length === 0) return;

  try {
    // Count tokens in returned chunks
    const returnedTokens = countTokensArray(results.map((r) => r.content));

    // Get unique file paths
    const uniqueFiles = [...new Set(results.map((r) => r.file_path))];

    // For documents/code: read full files and count tokens
    // For memories: full_source = returned (no file to compare)
    let fullSourceTokens = returnedTokens; // default for memories

    if (eventType === 'search' || eventType === 'search_code') {
      const projectRoot = getProjectRoot();
      const succDir = getSuccDir();

      fullSourceTokens = 0;
      for (const filePath of uniqueFiles) {
        try {
          // Handle code: prefix
          const cleanPath = filePath.replace(/^code:/, '');

          // Try multiple locations: project root, brain dir
          const candidates = [
            path.join(projectRoot, cleanPath),
            path.join(succDir, 'brain', cleanPath),
            cleanPath, // absolute path
          ];

          for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
              const content = fs.readFileSync(candidate, 'utf-8');
              fullSourceTokens += countTokens(content);
              break;
            }
          }
        } catch {
          // File not readable, skip
        }
      }

      // If we couldn't read any files, use returned as estimate
      if (fullSourceTokens === 0) {
        fullSourceTokens = returnedTokens;
      }
    }

    const savingsTokens = Math.max(0, fullSourceTokens - returnedTokens);

    recordTokenStat({
      event_type: eventType,
      query,
      returned_tokens: returnedTokens,
      full_source_tokens: fullSourceTokens,
      savings_tokens: savingsTokens,
      files_count: uniqueFiles.length,
      chunks_count: results.length,
    });
  } catch {
    // Don't fail the search if tracking fails
  }
}

/**
 * Track memory access for retention decay.
 * Memories that are frequently accessed will have higher effective scores.
 *
 * @param memoryIds - Array of memory IDs that were returned
 * @param limit - The search limit (top N results)
 * @param totalResults - Total number of results before limit
 */
function trackMemoryAccess(
  memoryIds: number[],
  limit: number,
  totalResults: number
): void {
  if (memoryIds.length === 0) return;

  try {
    const accesses: Array<{ memoryId: number; weight: number }> = [];

    for (let i = 0; i < memoryIds.length; i++) {
      // Top results (within limit) get full weight (1.0 = exact match)
      // Results beyond limit would get 0.5 (similarity hit) but we only track returned results
      // Weight decreases slightly by position: top result = 1.0, 2nd = 0.95, etc.
      const positionPenalty = Math.max(0, 0.05 * i);
      const weight = i < limit ? Math.max(0.5, 1.0 - positionPenalty) : 0.5;

      accesses.push({ memoryId: memoryIds[i], weight });
    }

    incrementMemoryAccessBatch(accesses);
  } catch {
    // Don't fail the search if tracking fails
  }
}

// Create MCP server
const server = new McpServer({
  name: 'succ',
  version: '0.1.0',
});

// Get brain vault path
function getBrainPath(): string {
  return path.join(getSuccDir(), 'brain');
}

// Resource: List brain vault files
server.resource(
  'brain-list',
  'brain://list',
  { description: 'List all files in the brain vault' },
  async () => {
    const brainPath = getBrainPath();
    if (!fs.existsSync(brainPath)) {
      return {
        contents: [{ uri: 'brain://list', text: 'Brain vault not initialized. Run: succ init' }],
      };
    }

    const files: string[] = [];
    function walkDir(dir: string, prefix: string = '') {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walkDir(fullPath, relativePath);
        } else if (entry.name.endsWith('.md')) {
          files.push(relativePath);
        }
      }
    }
    walkDir(brainPath);

    const text =
      files.length > 0
        ? `# Brain Vault Files\n\n${files.map((f) => `- ${f}`).join('\n')}`
        : 'Brain vault is empty.';

    return { contents: [{ uri: 'brain://list', mimeType: 'text/markdown', text }] };
  }
);

// Resource: Read brain vault file (templated)
server.resource(
  'brain-file',
  new ResourceTemplate('brain://file/{path}', { list: undefined }),
  { description: 'Read a file from the brain vault. Use brain://list to see available files.' },
  async (uri, variables) => {
    const brainPath = getBrainPath();
    const filePath = variables.path as string;
    const fullPath = path.join(brainPath, filePath);

    // Security: use path.resolve for proper path traversal protection
    const resolvedPath = path.resolve(fullPath);
    const resolvedBrain = path.resolve(brainPath);

    // Check path is within brain vault (handle both exact match and subdirectory)
    if (resolvedPath !== resolvedBrain && !resolvedPath.startsWith(resolvedBrain + path.sep)) {
      return { contents: [{ uri: uri.href, text: 'Error: Path traversal not allowed' }] };
    }

    if (!fs.existsSync(fullPath)) {
      return { contents: [{ uri: uri.href, text: `File not found: ${filePath}` }] };
    }

    // Check for symlinks (optional security hardening)
    const stats = fs.lstatSync(fullPath);
    if (stats.isSymbolicLink()) {
      return { contents: [{ uri: uri.href, text: 'Error: Symbolic links not allowed' }] };
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: content }] };
  }
);

// Resource: Brain vault index (summary)
server.resource(
  'brain-index',
  'brain://index',
  { description: 'Get the brain vault index or CLAUDE.md' },
  async () => {
    const brainPath = getBrainPath();
    if (!fs.existsSync(brainPath)) {
      return { contents: [{ uri: 'brain://index', text: 'Brain vault not initialized.' }] };
    }

    // Try project MOC first, then CLAUDE.md, then Memories.md
    const projectName = path.basename(getProjectRoot());
    const projectMocPath = path.join(brainPath, '01_Projects', projectName, `${projectName}.md`);
    const claudePath = path.join(brainPath, 'CLAUDE.md');
    const memoriesPath = path.join(brainPath, 'Memories.md');

    if (fs.existsSync(projectMocPath)) {
      const content = fs.readFileSync(projectMocPath, 'utf-8');
      return { contents: [{ uri: 'brain://index', mimeType: 'text/markdown', text: content }] };
    }

    if (fs.existsSync(claudePath)) {
      const content = fs.readFileSync(claudePath, 'utf-8');
      return { contents: [{ uri: 'brain://index', mimeType: 'text/markdown', text: content }] };
    }

    if (fs.existsSync(memoriesPath)) {
      const content = fs.readFileSync(memoriesPath, 'utf-8');
      return { contents: [{ uri: 'brain://index', mimeType: 'text/markdown', text: content }] };
    }

    return { contents: [{ uri: 'brain://index', text: 'No project MOC, CLAUDE.md, or Memories.md found.' }] };
  }
);

// Resource: Soul document (AI persona/personality)
server.resource(
  'soul',
  'soul://persona',
  {
    description:
      'Get the soul document - defines AI personality, values, and communication style. Read this to understand how to interact with the user.',
  },
  async () => {
    const succDir = getSuccDir();

    // Check multiple possible locations for soul document
    const soulPaths = [
      path.join(succDir, 'soul.md'),
      path.join(succDir, 'SOUL.md'),
      path.join(getProjectRoot(), 'soul.md'),
      path.join(getProjectRoot(), 'SOUL.md'),
      path.join(getProjectRoot(), '.soul.md'),
    ];

    for (const soulPath of soulPaths) {
      if (fs.existsSync(soulPath)) {
        const content = fs.readFileSync(soulPath, 'utf-8');
        return {
          contents: [
            {
              uri: 'soul://persona',
              mimeType: 'text/markdown',
              text: content,
            },
          ],
        };
      }
    }

    return {
      contents: [
        {
          uri: 'soul://persona',
          text: 'No soul document found. Create .succ/soul.md to define AI personality.\n\nRun `succ init` to generate a template.',
        },
      ],
    };
  }
);

// Tool: succ_search - Hybrid search in brain vault (BM25 + semantic)
server.tool(
  'succ_search',
  'Search the project knowledge base using hybrid search (BM25 + semantic). Returns relevant chunks from indexed documentation.',
  {
    query: z.string().describe('The search query'),
    limit: z.number().optional().default(5).describe('Maximum number of results (default: 5)'),
    threshold: z.number().optional().default(0.2).describe('Similarity threshold 0-1 (default: 0.2)'),
  },
  async ({ query, limit, threshold }) => {
    try {
      const queryEmbedding = await getEmbedding(query);
      // Use hybrid search for docs
      const results = hybridSearchDocs(query, queryEmbedding, limit, threshold);

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No results found for "${query}" (threshold: ${threshold})`,
            },
          ],
        };
      }

      // Track token savings
      trackTokenSavings('search', query, results);

      const formatted = results
        .map((r, i) => {
          const score = (r.similarity * 100).toFixed(1);
          return `### ${i + 1}. ${r.file_path}:${r.start_line}-${r.end_line} (${score}%)\n\n${r.content}`;
        })
        .join('\n\n---\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${results.length} results for "${query}":\n\n${formatted}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error searching: ${error.message}`,
          },
        ],
        isError: true,
      };
    } finally {
      closeDb();
    }
  }
);

// Tool: succ_remember - Save important information to memory
server.tool(
  'succ_remember',
  'Save important information to long-term memory. Use this to remember decisions, learnings, user preferences, or anything worth recalling later. Use global=true for cross-project memories. Use valid_until for temporary info (sprint goals, workarounds), valid_from for scheduled changes.',
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
      .enum(['observation', 'decision', 'learning', 'error', 'pattern'])
      .optional()
      .default('observation')
      .describe('Memory type: observation (facts), decision (choices), learning (insights), error (failures), pattern (recurring themes)'),
    global: z
      .boolean()
      .optional()
      .default(false)
      .describe('Save to global memory (shared across all projects)'),
    valid_from: z
      .string()
      .optional()
      .describe('When this fact becomes valid. Use ISO date (2025-03-01) or duration from now (7d, 2w, 1m). For scheduled changes.'),
    valid_until: z
      .string()
      .optional()
      .describe('When this fact expires. Use ISO date (2025-12-31) or duration from now (7d, 30d). For sprint goals, temp workarounds.'),
  },
  async ({ content, tags, source, type, global: useGlobal, valid_from, valid_until }) => {
    try {
      const config = getConfig();

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
        const result = saveGlobalMemory(content, embedding, tags, source, projectName, { type });

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

      const result = saveMemory(content, embedding, tags, source, {
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
  'Recall relevant memories from past sessions using hybrid search (BM25 + semantic). Searches both project-local and global (cross-project) memories. Use as_of_date for point-in-time queries (post-mortems, audits, debugging past state).',
  {
    query: z.string().describe('What to recall (semantic search)'),
    limit: z.number().optional().default(5).describe('Maximum number of memories (default: 5)'),
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
  },
  async ({ query, limit, tags, since, as_of_date }) => {
    try {
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

      const queryEmbedding = await getEmbedding(query);

      // Use hybrid search for local memories (BM25 + vector with RRF)
      // Note: tags and since filtering applied after hybrid search
      let localResults = hybridSearchMemories(query, queryEmbedding, limit * 2, 0.3);

      // Apply tag filter if specified
      if (tags && tags.length > 0) {
        localResults = localResults.filter((m) => {
          const memTags = m.tags ? m.tags.split(',').map((t) => t.trim()) : [];
          return tags.some((t) => memTags.includes(t));
        });
      }

      // Apply date filter if specified
      if (sinceDate) {
        localResults = localResults.filter((m) => new Date(m.created_at) >= sinceDate!);
      }

      // Apply point-in-time validity filter (as_of_date)
      // This filters memories to show only those that were valid at the specified point in time
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

        // Filter: memory must have been created before as_of_date AND
        // either have no valid_until or valid_until is after as_of_date AND
        // either have no valid_from or valid_from is before as_of_date
        localResults = localResults.filter((m) => {
          const createdAt = new Date(m.created_at);
          if (createdAt > asOfDateObj!) return false;

          // Check valid_from: if set, must be before or equal to as_of_date
          if (m.valid_from) {
            const validFrom = new Date(m.valid_from);
            if (validFrom > asOfDateObj!) return false;
          }

          // Check valid_until: if set, must be after or equal to as_of_date
          if (m.valid_until) {
            const validUntil = new Date(m.valid_until);
            if (validUntil < asOfDateObj!) return false;
          }

          return true;
        });
      }

      localResults = localResults.slice(0, limit);

      // Global memories still use vector-only search (separate DB)
      const globalResults = searchGlobalMemories(queryEmbedding, limit, 0.3, tags, sinceDate);

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
      const temporalConfig = getTemporalConfig();
      if (temporalConfig.enabled && !as_of_date) {
        // Don't apply temporal scoring for point-in-time queries
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

      if (allResults.length === 0) {
        // Try to show recent memories as fallback
        const recentLocal = getRecentMemories(2);
        const recentGlobal = getRecentGlobalMemories(2);

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

      // Track token savings for recall (memories don't have source files, so we track returned vs total memories)
      trackTokenSavings(
        'recall',
        query,
        allResults.map((m) => ({ file_path: `memory:${m.id || 'unknown'}`, content: m.content }))
      );

      // Track memory access for retention decay (local memories only)
      const localMemoryIds = allResults
        .filter((r) => !r.isGlobal && r.id)
        .map((r) => r.id as number);
      trackMemoryAccess(localMemoryIds, limit, localResults.length + globalResults.length);

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

          return `### ${i + 1}. ${date}${tagStr}${sourceStr}${scope}${projectStr}${validityStr} (${similarity}% match)\n\n${m.content}`;
        })
        .join('\n\n---\n\n');

      const localCount = allResults.filter((r) => !r.isGlobal).length;
      const globalCount = allResults.filter((r) => r.isGlobal).length;
      const asOfStr = as_of_date ? ` (as of ${as_of_date})` : '';
      const summary = `Found ${allResults.length} memories (${localCount} local, ${globalCount} global)${asOfStr}`;

      return {
        content: [
          {
            type: 'text' as const,
            text: `${summary} for "${query}":\n\n${formatted}`,
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


// Tool: succ_index_file - Index a single documentation file
server.tool(
  'succ_index_file',
  'Index a single file for semantic search. Faster than full reindex for small changes. Embedding modes (configured via config.json): local (Transformers.js, default), openrouter (cloud API), custom (Ollama/LM Studio/llama.cpp).',
  {
    file: z.string().describe('Path to the file to index'),
    force: z.boolean().optional().default(false).describe('Force reindex even if unchanged'),
  },
  async ({ file, force }) => {
    try {
      const { indexDocFile } = await import('./commands/index.js');
      const result = await indexDocFile(file, { force });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: result.error || 'Failed to index file',
            },
          ],
          isError: true,
        };
      }

      if (result.skipped) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Skipped: ${result.reason}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Indexed: ${file} (${result.chunks} chunks)`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error indexing file: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: succ_analyze_file - Analyze a single file and generate documentation
server.tool(
  'succ_analyze_file',
  'Analyze a single source file and generate documentation in brain vault. Modes: claude (CLI with Haiku), local (Ollama/LM Studio), openrouter (cloud API). Check succ_status first - if analyze daemon is running, it handles this automatically.',
  {
    file: z.string().describe('Path to the file to analyze'),
    mode: z.enum(['claude', 'local', 'openrouter']).optional().describe('claude = Claude CLI (Haiku), local = Ollama/LM Studio/llama.cpp, openrouter = cloud API (default: from config)'),
  },
  async ({ file, mode }) => {
    try {
      const result = await analyzeFile(file, { mode });

      if (result.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Analyzed: ${file}\nOutput: ${result.outputPath}`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error analyzing file: ${result.error}`,
            },
          ],
          isError: true,
        };
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error analyzing file: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: succ_index_code_file - Index a single code file
server.tool(
  'succ_index_code_file',
  'Index a single source code file for semantic search. Faster than full index-code for small changes. Embedding modes (configured via config.json): local (Transformers.js, default), openrouter (cloud API), custom (Ollama/LM Studio/llama.cpp).',
  {
    file: z.string().describe('Path to the code file to index'),
    force: z.boolean().optional().default(false).describe('Force reindex even if unchanged'),
  },
  async ({ file, force }) => {
    try {
      const { indexCodeFile } = await import('./commands/index-code.js');
      const result = await indexCodeFile(file, { force });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: result.error || 'Failed to index file',
            },
          ],
          isError: true,
        };
      }

      if (result.skipped) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Skipped: ${result.reason}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Indexed: ${file} (${result.chunks} chunks)`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error indexing code file: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: succ_search_code - Search indexed code (hybrid BM25 + vector)
server.tool(
  'succ_search_code',
  'Search indexed source code using hybrid search (BM25 + semantic). Find functions, classes, and code patterns. Works well for both exact identifiers and conceptual queries.',
  {
    query: z.string().describe('What to search for (e.g., "useGlobalHooks", "authentication logic")'),
    limit: z.number().optional().default(5).describe('Maximum number of results (default: 5)'),
    threshold: z.number().optional().default(0.25).describe('Similarity threshold 0-1 (default: 0.25)'),
  },
  async ({ query, limit, threshold }) => {
    try {
      const queryEmbedding = await getEmbedding(query);
      // Hybrid search: BM25 + vector with RRF fusion
      const codeResults = hybridSearchCode(query, queryEmbedding, limit, threshold);

      if (codeResults.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No code found matching "${query}". Run succ_index_code first to index the codebase.`,
            },
          ],
        };
      }

      // Track token savings
      trackTokenSavings('search_code', query, codeResults);

      const formatted = codeResults
        .map((r, i) => {
          const score = (r.similarity * 100).toFixed(1);
          // Remove code: prefix for display
          const filePath = r.file_path.replace(/^code:/, '');
          return `### ${i + 1}. ${filePath}:${r.start_line}-${r.end_line} (${score}%)\n\n\`\`\`\n${r.content}\n\`\`\``;
        })
        .join('\n\n---\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${codeResults.length} code matches for "${query}":\n\n${formatted}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error searching code: ${error.message}`,
          },
        ],
        isError: true,
      };
    } finally {
      closeDb();
    }
  }
);

// Tool: succ_status - Get index status
server.tool(
  'succ_status',
  'Get the current status of succ (indexed files, memories, last update, daemon statuses).',
  {},
  async () => {
    try {
      const stats = getStats();
      const memStats = getMemoryStats();
      const daemons = getDaemonStatuses();

      // Format type breakdown
      const typeBreakdown = Object.entries(memStats.by_type)
        .map(([type, count]) => `    ${type}: ${count}`)
        .join('\n');

      // Format daemon statuses
      const daemonLines = daemons.map(d => {
        const statusIcon = d.running ? '🟢' : '⚫';
        const pidInfo = d.running && d.pid ? ` (PID: ${d.pid})` : '';
        return `  ${statusIcon} ${d.name}: ${d.running ? 'running' : 'stopped'}${pidInfo}`;
      }).join('\n');

      const status = [
        '## Documents',
        `  Files indexed: ${stats.total_files}`,
        `  Total chunks: ${stats.total_documents}`,
        `  Last indexed: ${stats.last_indexed || 'Never'}`,
        '',
        '## Memories',
        `  Total: ${memStats.total_memories}`,
        typeBreakdown ? `  By type:\n${typeBreakdown}` : '',
        memStats.oldest_memory ? `  Oldest: ${new Date(memStats.oldest_memory).toLocaleDateString()}` : '',
        memStats.newest_memory ? `  Newest: ${new Date(memStats.newest_memory).toLocaleDateString()}` : '',
        memStats.stale_count > 0 ? `  ⚠ Stale (>30 days): ${memStats.stale_count} - consider cleanup with succ_forget` : '',
        '',
        '## Daemons',
        daemonLines,
      ]
        .filter(Boolean)
        .join('\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: status,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error getting status: ${error.message}`,
          },
        ],
        isError: true,
      };
    } finally {
      closeDb();
    }
  }
);

// Tool: succ_stats - Get token savings statistics
server.tool(
  'succ_stats',
  'Get token savings statistics. Shows how many tokens were saved by using RAG search instead of loading full files.',
  {},
  async () => {
    try {
      const idleConfig = getIdleReflectionConfig();
      const summaryEnabled = idleConfig.operations?.session_summary ?? true;

      const aggregated = getTokenStatsAggregated();
      const summary = getTokenStatsSummary();

      const lines: string[] = ['## Token Savings\n'];

      // Session Summaries
      const sessionStats = aggregated.find((s) => s.event_type === 'session_summary');
      lines.push('### Session Summaries');
      if (!summaryEnabled) {
        lines.push('  Status: disabled');
      } else if (sessionStats) {
        lines.push(`  Sessions: ${sessionStats.query_count}`);
        lines.push(`  Transcript: ${formatTokens(sessionStats.total_full_source_tokens)} tokens`);
        lines.push(`  Summary: ${formatTokens(sessionStats.total_returned_tokens)} tokens`);
        lines.push(
          `  Compression: ${compressionPercent(sessionStats.total_full_source_tokens, sessionStats.total_returned_tokens)}`
        );
        lines.push(`  Saved: ${formatTokens(sessionStats.total_savings_tokens)} tokens`);
      } else {
        lines.push('  No session summaries recorded yet.');
      }

      // RAG Queries
      lines.push('\n### RAG Queries');

      const ragTypes: TokenEventType[] = ['recall', 'search', 'search_code'];
      let hasRagStats = false;

      for (const type of ragTypes) {
        const stat = aggregated.find((s) => s.event_type === type);
        if (stat) {
          hasRagStats = true;
          lines.push(
            `  ${type.padEnd(12)}: ${stat.query_count} queries, ${formatTokens(stat.total_returned_tokens)} returned, ${formatTokens(stat.total_savings_tokens)} saved`
          );
        }
      }

      if (!hasRagStats) {
        lines.push('  No RAG queries recorded yet.');
      }

      // Total
      lines.push('\n### Total');
      if (summary.total_queries > 0) {
        lines.push(`  Queries: ${summary.total_queries}`);
        lines.push(`  Tokens returned: ${formatTokens(summary.total_returned_tokens)}`);
        lines.push(`  Tokens saved: ${formatTokens(summary.total_savings_tokens)}`);
      } else {
        lines.push('  No stats recorded yet.');
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: lines.join('\n'),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error getting stats: ${error.message}`,
          },
        ],
        isError: true,
      };
    } finally {
      closeDb();
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
  },
  async ({ id, older_than, tag }) => {
    try {
      // Delete by ID
      if (id !== undefined) {
        const memory = getMemoryById(id);
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

        const deleted = deleteMemory(id);

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

        const count = deleteMemoriesOlderThan(date);

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
        const count = deleteMemoriesByTag(tag);

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

// Tool: succ_link - Create/manage memory links (knowledge graph)
server.tool(
  'succ_link',
  'Create or manage links between memories to build a knowledge graph. Links help track relationships between decisions, learnings, and context.',
  {
    action: z.enum(['create', 'delete', 'show', 'graph', 'auto']).describe(
      'Action: create (new link), delete (remove link), show (memory with links), graph (stats), auto (auto-link similar)'
    ),
    source_id: z.number().optional().describe('Source memory ID (for create/delete/show)'),
    target_id: z.number().optional().describe('Target memory ID (for create/delete)'),
    relation: z.enum(LINK_RELATIONS).optional().describe(
      'Relation type: related, caused_by, leads_to, similar_to, contradicts, implements, supersedes, references'
    ),
    threshold: z.number().optional().describe('Similarity threshold for auto-linking (default: 0.75)'),
  },
  async ({ action, source_id, target_id, relation, threshold }) => {
    try {
      switch (action) {
        case 'create': {
          if (!source_id || !target_id) {
            return {
              content: [{
                type: 'text' as const,
                text: 'Both source_id and target_id are required to create a link.',
              }],
            };
          }

          const result = createMemoryLink(source_id, target_id, relation || 'related');

          return {
            content: [{
              type: 'text' as const,
              text: result.created
                ? `Created link: memory #${source_id} --[${relation || 'related'}]--> memory #${target_id}`
                : `Link already exists (id: ${result.id})`,
            }],
          };
        }

        case 'delete': {
          if (!source_id || !target_id) {
            return {
              content: [{
                type: 'text' as const,
                text: 'Both source_id and target_id are required to delete a link.',
              }],
            };
          }

          const deleted = deleteMemoryLink(source_id, target_id, relation);

          return {
            content: [{
              type: 'text' as const,
              text: deleted
                ? `Deleted link between memory #${source_id} and #${target_id}`
                : 'No matching link found.',
            }],
          };
        }

        case 'show': {
          if (!source_id) {
            return {
              content: [{
                type: 'text' as const,
                text: 'source_id is required to show a memory with its links.',
              }],
            };
          }

          const memory = getMemoryWithLinks(source_id);
          if (!memory) {
            return {
              content: [{
                type: 'text' as const,
                text: `Memory #${source_id} not found.`,
              }],
            };
          }

          const outLinks = memory.outgoing_links.length > 0
            ? memory.outgoing_links.map(l => `  → #${l.target_id} (${l.relation})`).join('\n')
            : '  (none)';
          const inLinks = memory.incoming_links.length > 0
            ? memory.incoming_links.map(l => `  ← #${l.source_id} (${l.relation})`).join('\n')
            : '  (none)';

          const text = `Memory #${memory.id}:
${memory.content.substring(0, 200)}${memory.content.length > 200 ? '...' : ''}

Tags: ${memory.tags.length > 0 ? memory.tags.join(', ') : '(none)'}
Created: ${new Date(memory.created_at).toLocaleString()}

Outgoing links:
${outLinks}

Incoming links:
${inLinks}`;

          return {
            content: [{ type: 'text' as const, text }],
          };
        }

        case 'graph': {
          const stats = getGraphStats();

          const relationStats = Object.entries(stats.relations)
            .map(([r, c]) => `  ${r}: ${c}`)
            .join('\n') || '  (no links)';

          const text = `Knowledge Graph Statistics:

Memories: ${stats.total_memories}
Links: ${stats.total_links}
Avg links/memory: ${stats.avg_links_per_memory.toFixed(2)}
Isolated (no links): ${stats.isolated_memories}

Links by relation:
${relationStats}`;

          return {
            content: [{ type: 'text' as const, text }],
          };
        }

        case 'auto': {
          const th = threshold || 0.75;
          const created = autoLinkSimilarMemories(th, 3);

          return {
            content: [{
              type: 'text' as const,
              text: `Auto-linked similar memories (threshold: ${th}). Created ${created} new links.`,
            }],
          };
        }

        default:
          return {
            content: [{
              type: 'text' as const,
              text: 'Unknown action. Use: create, delete, show, graph, or auto.',
            }],
          };
      }
    } catch (error: any) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error: ${error.message}`,
        }],
        isError: true,
      };
    } finally {
      closeDb();
    }
  }
);

// Tool: succ_explore - Explore connected memories
server.tool(
  'succ_explore',
  'Explore the knowledge graph starting from a memory. Find connected memories through links.',
  {
    memory_id: z.number().describe('Starting memory ID'),
    depth: z.number().optional().default(2).describe('Max traversal depth (default: 2)'),
  },
  async ({ memory_id, depth }) => {
    try {
      const connected = findConnectedMemories(memory_id, depth);

      if (connected.length === 0) {
        const memory = getMemoryById(memory_id);
        if (!memory) {
          return {
            content: [{
              type: 'text' as const,
              text: `Memory #${memory_id} not found.`,
            }],
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: `Memory #${memory_id} has no connections within ${depth} hops.\n\nContent: ${memory.content.substring(0, 200)}...`,
          }],
        };
      }

      const formatted = connected.map(({ memory, depth: d, path }) => {
        const pathStr = path.map(id => `#${id}`).join(' → ');
        return `[Depth ${d}] Memory #${memory.id} (${pathStr})
  ${memory.content.substring(0, 150)}${memory.content.length > 150 ? '...' : ''}
  Tags: ${memory.tags.join(', ') || '(none)'}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text' as const,
          text: `Found ${connected.length} connected memories from #${memory_id} (max depth: ${depth}):\n\n${formatted}`,
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error exploring: ${error.message}`,
        }],
        isError: true,
      };
    } finally {
      closeDb();
    }
  }
);

/**
 * Parse relative date strings like "30d", "1w", "3m"
 */
function parseRelativeDate(input: string): Date | null {
  const now = new Date();

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

  const date = new Date(input);
  if (!isNaN(date.getTime())) {
    return date;
  }

  return null;
}

// Tool: succ_config - Show current configuration
server.tool(
  'succ_config',
  'Get the current succ configuration with all settings and their effective values (with defaults applied). Shows embedding mode, analyze mode, quality scoring, graph settings, idle reflection, etc.',
  {},
  async () => {
    try {
      const { getConfigDisplay, formatConfigDisplay } = await import('./lib/config.js');
      const display = getConfigDisplay(true); // mask secrets

      return {
        content: [
          {
            type: 'text' as const,
            text: formatConfigDisplay(display),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error getting config: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: succ_config_set - Update configuration values
server.tool(
  'succ_config_set',
  'Update succ configuration values. Saves to global (~/.succ/config.json) or project (.succ/config.json). Common keys: embedding_mode (local/openrouter/custom), analyze_mode (claude/local/openrouter), openrouter_api_key, embedding_api_url, analyze_api_url, analyze_model, quality_scoring_enabled, sensitive_filter_enabled, graph_auto_link, idle_reflection.enabled, idle_watcher.enabled',
  {
    key: z.string().describe('Config key to set (e.g., "embedding_mode", "analyze_model", "idle_reflection.enabled")'),
    value: z.string().describe('Value to set (strings, numbers, booleans as strings: "true"/"false")'),
    scope: z.enum(['global', 'project']).optional().default('global').describe('Where to save: "global" (~/.succ/config.json) or "project" (.succ/config.json). Default: global'),
  },
  async ({ key, value, scope }) => {
    try {
      const os = await import('os');

      // Determine config path based on scope
      let configDir: string;
      let configPath: string;

      if (scope === 'project') {
        const succDir = getSuccDir();
        if (!fs.existsSync(succDir)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Project not initialized. Run `succ init` first or use scope="global".',
              },
            ],
            isError: true,
          };
        }
        configDir = succDir;
        configPath = path.join(succDir, 'config.json');
      } else {
        configDir = path.join(os.homedir(), '.succ');
        configPath = path.join(configDir, 'config.json');
      }

      // Load existing config
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }

      // Parse value (handle booleans and numbers)
      let parsedValue: unknown = value;
      if (value === 'true') parsedValue = true;
      else if (value === 'false') parsedValue = false;
      else if (!isNaN(Number(value)) && value.trim() !== '') parsedValue = Number(value);

      // Handle nested keys (e.g., "idle_reflection.enabled")
      const keys = key.split('.');
      if (keys.length === 1) {
        config[key] = parsedValue;
      } else {
        // Navigate/create nested object
        let current: Record<string, unknown> = config;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
            current[keys[i]] = {};
          }
          current = current[keys[i]] as Record<string, unknown>;
        }
        current[keys[keys.length - 1]] = parsedValue;
      }

      // Ensure config directory exists
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Save config
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      return {
        content: [
          {
            type: 'text' as const,
            text: `Config updated (${scope}): ${key} = ${JSON.stringify(parsedValue)}\nSaved to: ${configPath}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error setting config: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: succ_checkpoint - Create and manage checkpoints (full backup/restore)
server.tool(
  'succ_checkpoint',
  'Create or list checkpoints (full backup of memories, documents, brain vault). Use "create" to make a backup, "list" to see available checkpoints. Note: Restore requires CLI (succ checkpoint restore <file>).',
  {
    action: z.enum(['create', 'list']).describe('Action: create (new checkpoint) or list (show available)'),
    compress: z.boolean().optional().describe('Compress with gzip (default: false)'),
    include_brain: z.boolean().optional().describe('Include brain vault files (default: true)'),
    include_documents: z.boolean().optional().describe('Include indexed documents (default: true)'),
  },
  async ({ action, compress, include_brain, include_documents }) => {
    try {
      const {
        createCheckpoint,
        listCheckpoints,
        formatSize,
      } = await import('./lib/checkpoint.js');

      if (action === 'create') {
        const { checkpoint: cp, outputPath } = createCheckpoint({
          includeBrain: include_brain ?? true,
          includeDocuments: include_documents ?? true,
          includeConfig: true,
          compress: compress ?? false,
        });

        const fs = await import('fs');
        const stat = fs.statSync(outputPath);

        return {
          content: [{
            type: 'text' as const,
            text: `Checkpoint created successfully!

File: ${outputPath}
Project: ${cp.project_name}
Size: ${formatSize(stat.size)}

Contents:
  Memories: ${cp.stats.memories_count}
  Documents: ${cp.stats.documents_count}
  Memory links: ${cp.stats.links_count}
  Brain files: ${cp.stats.brain_files_count}

To restore: succ checkpoint restore "${outputPath}"`,
          }],
        };
      } else {
        // list
        const checkpoints = listCheckpoints();

        if (checkpoints.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No checkpoints found. Create one with: succ_checkpoint action="create"',
            }],
          };
        }

        const lines = ['Available checkpoints:\n'];
        for (const cp of checkpoints) {
          const compressed = cp.compressed ? ' (compressed)' : '';
          const date = cp.created_at ? new Date(cp.created_at).toLocaleString() : 'unknown';
          lines.push(`  ${cp.name}${compressed}`);
          lines.push(`    Created: ${date}`);
          lines.push(`    Size: ${formatSize(cp.size)}`);
          lines.push('');
        }
        lines.push(`Total: ${checkpoints.length} checkpoint(s)`);

        return {
          content: [{
            type: 'text' as const,
            text: lines.join('\n'),
          }],
        };
      }
    } catch (error: any) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error: ${error.message}`,
        }],
        isError: true,
      };
    } finally {
      closeDb();
    }
  }
);

// Tool: succ_score - Get AI-readiness score
server.tool(
  'succ_score',
  'Get the AI-readiness score for the project. Shows how well-prepared the project is for AI collaboration, with metrics for brain vault, memories, code index, and more.',
  {},
  async () => {
    try {
      const { calculateAIReadinessScore, formatAIReadinessScore } = await import('./lib/ai-readiness.js');
      const result = calculateAIReadinessScore();
      return {
        content: [{
          type: 'text' as const,
          text: formatAIReadinessScore(result),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error calculating score: ${error.message}`,
        }],
        isError: true,
      };
    } finally {
      closeDb();
    }
  }
);

// Handle unhandled promise rejections
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
  cleanupEmbeddings();
  closeDb();
  closeGlobalDb();
  process.exit(1);
});

// Start server with stdio transport
async function main() {
  setupGracefulShutdown();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Use stderr for logging (stdout is for MCP protocol)
  console.error('succ MCP server started');
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  cleanupEmbeddings();
  cleanupQualityScoring();
  closeDb();
  closeGlobalDb();
  process.exit(1);
});
