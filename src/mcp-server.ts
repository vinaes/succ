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
} from './lib/db.js';
import { getConfig, getProjectRoot, getSuccDir } from './lib/config.js';
import path from 'path';
import fs from 'fs';
import { getEmbedding, cleanupEmbeddings } from './lib/embeddings.js';
import { index } from './commands/index.js';
import { indexCode } from './commands/index-code.js';
import { scoreMemory, passesQualityThreshold, formatQualityScore, cleanupQualityScoring } from './lib/quality.js';
import { scanSensitive, formatMatches } from './lib/sensitive-filter.js';

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

    // Try index.md first, then CLAUDE.md
    const indexPath = path.join(brainPath, 'index.md');
    const claudePath = path.join(brainPath, 'CLAUDE.md');

    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, 'utf-8');
      return { contents: [{ uri: 'brain://index', mimeType: 'text/markdown', text: content }] };
    }

    if (fs.existsSync(claudePath)) {
      const content = fs.readFileSync(claudePath, 'utf-8');
      return { contents: [{ uri: 'brain://index', mimeType: 'text/markdown', text: content }] };
    }

    return { contents: [{ uri: 'brain://index', text: 'No index.md or CLAUDE.md found.' }] };
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

// Tool: succ_search - Semantic search in brain vault
server.tool(
  'succ_search',
  'Search the project knowledge base semantically. Returns relevant chunks from indexed documentation.',
  {
    query: z.string().describe('The search query'),
    limit: z.number().optional().default(5).describe('Maximum number of results (default: 5)'),
    threshold: z.number().optional().default(0.2).describe('Similarity threshold 0-1 (default: 0.2)'),
  },
  async ({ query, limit, threshold }) => {
    try {
      const queryEmbedding = await getEmbedding(query);
      const results = searchDocuments(queryEmbedding, limit, threshold);

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

      const formatted = results
        .map((r, i) => {
          const similarity = (r.similarity * 100).toFixed(1);
          return `### ${i + 1}. ${r.file_path}:${r.start_line}-${r.end_line} (${similarity}%)\n\n${r.content}`;
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
  'Save important information to long-term memory. Use this to remember decisions, learnings, user preferences, or anything worth recalling later. Use global=true for cross-project memories.',
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
  },
  async ({ content, tags, source, type, global: useGlobal }) => {
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
              text: `✓ Remembered globally (id: ${result.id})${tagStr}${qualityStr} (project: ${projectName}):\n"${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`,
            },
          ],
        };
      }

      const result = saveMemory(content, embedding, tags, source, {
        type,
        qualityScore: qualityScore ? { score: qualityScore.score, factors: qualityScore.factors } : undefined,
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
            text: `✓ Remembered${typeStr} (id: ${result.id})${tagStr}${qualityStr}:\n"${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`,
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

// Tool: succ_recall - Recall past memories (searches both local and global)
server.tool(
  'succ_recall',
  'Recall relevant memories from past sessions. Searches both project-local and global (cross-project) memories.',
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
  },
  async ({ query, limit, tags, since }) => {
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

      // Search both local and global memories
      const localResults = searchMemories(queryEmbedding, limit, 0.3, tags, sinceDate);
      const globalResults = searchGlobalMemories(queryEmbedding, limit, 0.3, tags, sinceDate);

      // Merge and sort by similarity
      const allResults = [
        ...localResults.map((r) => ({ ...r, isGlobal: false })),
        ...globalResults.map((r) => ({ ...r, isGlobal: true })),
      ]
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

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
            const tagStr = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
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

      const formatted = allResults
        .map((m, i) => {
          const similarity = (m.similarity * 100).toFixed(0);
          const tagStr = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
          const date = new Date(m.created_at).toLocaleDateString();
          const sourceStr = m.source ? ` (from: ${m.source})` : '';
          const scope = m.isGlobal ? ' [GLOBAL]' : '';
          const projectStr = m.isGlobal && 'project' in m && m.project ? ` (project: ${m.project})` : '';
          return `### ${i + 1}. ${date}${tagStr}${sourceStr}${scope}${projectStr} (${similarity}% match)\n\n${m.content}`;
        })
        .join('\n\n---\n\n');

      const localCount = allResults.filter((r) => !r.isGlobal).length;
      const globalCount = allResults.filter((r) => r.isGlobal).length;
      const summary = `Found ${allResults.length} memories (${localCount} local, ${globalCount} global)`;

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

// Tool: succ_index - Index or reindex files
server.tool(
  'succ_index',
  'Index files for semantic search. Run after adding or modifying documentation.',
  {
    path: z.string().optional().describe('Path to index (default: .succ/brain)'),
    force: z.boolean().optional().default(false).describe('Force reindex all files'),
  },
  async ({ path, force }) => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await index(path, { force });

      return {
        content: [
          {
            type: 'text' as const,
            text: logs.join('\n'),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error indexing: ${error.message}`,
          },
        ],
        isError: true,
      };
    } finally {
      console.log = originalLog;
    }
  }
);

// Tool: succ_index_code - Index source code
server.tool(
  'succ_index_code',
  'Index source code files for semantic search. Use this to make codebase searchable.',
  {
    path: z.string().optional().describe('Path to index (default: project root)'),
    force: z.boolean().optional().default(false).describe('Force reindex all files'),
  },
  async ({ path, force }) => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await indexCode(path, { force });

      return {
        content: [
          {
            type: 'text' as const,
            text: logs.join('\n'),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error indexing code: ${error.message}`,
          },
        ],
        isError: true,
      };
    } finally {
      console.log = originalLog;
    }
  }
);

// Tool: succ_search_code - Search indexed code
server.tool(
  'succ_search_code',
  'Search indexed source code semantically. Find functions, classes, and code patterns.',
  {
    query: z.string().describe('What to search for (e.g., "authentication logic", "database connection")'),
    limit: z.number().optional().default(5).describe('Maximum number of results (default: 5)'),
    threshold: z.number().optional().default(0.25).describe('Similarity threshold 0-1 (default: 0.25)'),
  },
  async ({ query, limit, threshold }) => {
    try {
      const queryEmbedding = await getEmbedding(query);
      // Search only code: prefixed files
      const allResults = searchDocuments(queryEmbedding, limit * 3, threshold);
      const codeResults = allResults
        .filter((r) => r.file_path.startsWith('code:'))
        .slice(0, limit);

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

      const formatted = codeResults
        .map((r, i) => {
          const similarity = (r.similarity * 100).toFixed(1);
          // Remove code: prefix for display
          const filePath = r.file_path.replace(/^code:/, '');
          return `### ${i + 1}. ${filePath}:${r.start_line}-${r.end_line} (${similarity}%)\n\n\`\`\`\n${r.content}\n\`\`\``;
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
  'Get the current status of succ (indexed files, memories, last update).',
  {},
  async () => {
    try {
      const stats = getStats();
      const memStats = getMemoryStats();

      // Format type breakdown
      const typeBreakdown = Object.entries(memStats.by_type)
        .map(([type, count]) => `    ${type}: ${count}`)
        .join('\n');

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
