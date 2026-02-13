#!/usr/bin/env node
/**
 * succ MCP Server
 *
 * Exposes succ functionality as MCP tools that Claude can call directly:
 * - succ_search: Semantic search in brain vault
 * - succ_search_code: Search indexed source code
 * - succ_remember: Save important information to memory
 * - succ_recall: Recall past memories semantically
 * - succ_forget: Delete memories
 * - succ_index_file / succ_index_code_file / succ_analyze_file: Index files
 * - succ_link / succ_explore: Knowledge graph
 * - succ_status / succ_stats / succ_score: Status and metrics
 * - succ_config / succ_config_set / succ_checkpoint: Configuration
 * - succ_dead_end: Record failed approaches to prevent retrying
 * - succ_prd_generate / succ_prd_list / succ_prd_status / succ_prd_run: PRD pipeline
 * - succ_quick_search / succ_web_search / succ_deep_research: Web search via Perplexity Sonar (OpenRouter)
 * - succ_web_search_history: Browse and filter past web search history
 * - succ_debug: Language-independent structured debugging with hypothesis testing
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeDb, closeGlobalDb, initStorageDispatcher, closeStorageDispatcher } from '../lib/storage/index.js';
import { cleanupEmbeddings } from '../lib/embeddings.js';
import { cleanupQualityScoring } from '../lib/quality.js';
import { getProjectRoot } from '../lib/config.js';
import { logError, logInfo } from '../lib/fault-logger.js';
import { setupGracefulShutdown, setCurrentProject } from './helpers.js';
import { registerResources } from './resources.js';
import { registerSearchTools } from './tools/search.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerGraphTools } from './tools/graph.js';
import { registerIndexingTools } from './tools/indexing.js';
import { registerStatusTools } from './tools/status.js';
import { registerConfigTools } from './tools/config.js';
import { registerDeadEndTools } from './tools/dead-end.js';
import { registerPrdTools } from './tools/prd.js';
import { registerWebSearchTools } from './tools/web-search.js';
import { registerDebugTools } from './tools/debug.js';

// Parse --project arg: succ-mcp --project /path/to/project
const projectArgIdx = process.argv.indexOf('--project');
if (projectArgIdx !== -1 && process.argv[projectArgIdx + 1]) {
  process.env.SUCC_PROJECT_ROOT = process.argv[projectArgIdx + 1];
}

// Create MCP server
const server = new McpServer({
  name: 'succ',
  version: '0.1.0',
});

// Register all resources and tools
registerResources(server);
registerSearchTools(server);
registerMemoryTools(server);
registerGraphTools(server);
registerIndexingTools(server);
registerStatusTools(server);
registerConfigTools(server);
registerDeadEndTools(server);
registerPrdTools(server);
registerWebSearchTools(server);
registerDebugTools(server);

// Handle unhandled promise rejections
process.on('unhandledRejection', (error) => {
  process.stderr.write(`[succ-mcp] UNHANDLED REJECTION: ${error instanceof Error ? error.message : String(error)}\n`);
  logError('mcp', 'Unhandled promise rejection', error instanceof Error ? error : new Error(String(error)));
  cleanupEmbeddings();
  closeDb();
  closeGlobalDb();
  process.exit(1);
});

// Idle timeout: exit if no MCP requests for 60 minutes (zombie prevention)
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    logInfo('mcp', 'Shutting down (idle timeout)');
    process.exit(0);
  }, IDLE_TIMEOUT_MS);
  // Don't keep process alive just for the timer
  if (idleTimer.unref) idleTimer.unref();
}

// stderr logger for MCP startup diagnostics (Claude Code reads stderr)
function mcpLog(msg: string) {
  process.stderr.write(`[succ-mcp] ${msg}\n`);
}

// Start server with stdio transport
async function main() {
  mcpLog('Starting...');
  setupGracefulShutdown();

  // Stdin close detection: when parent process dies, stdin closes
  process.stdin.on('end', () => {
    mcpLog('stdin closed, shutting down');
    logInfo('mcp', 'Shutting down (stdin closed)');
    process.exit(0);
  });
  process.stdin.on('error', (err) => {
    mcpLog(`stdin error: ${err.message}`);
    process.exit(0);
  });

  mcpLog('Initializing storage...');
  await initStorageDispatcher();
  mcpLog('Storage ready');

  setCurrentProject(getProjectRoot());
  mcpLog(`Project: ${getProjectRoot()}`);

  const transport = new StdioServerTransport();
  mcpLog('Connecting transport...');
  await server.connect(transport);
  mcpLog('Transport connected — server ready');

  // Reset idle timer on any stdin data (MCP messages)
  process.stdin.on('data', () => resetIdleTimer());
  resetIdleTimer();

  logInfo('mcp', `Server started (project: ${getProjectRoot()}, cwd: ${process.cwd()})`);
}

main().catch(async (error) => {
  mcpLog(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) mcpLog(error.stack);
  logError('mcp', 'Failed to start MCP server', error instanceof Error ? error : new Error(String(error)));
  await closeStorageDispatcher();
  cleanupEmbeddings();
  cleanupQualityScoring();
  closeDb();
  closeGlobalDb();
  process.exit(1);
});
