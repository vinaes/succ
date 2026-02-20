#!/usr/bin/env node
/**
 * succ MCP Server
 *
 * 14 consolidated MCP tools:
 * - succ_search, succ_search_code: Semantic search
 * - succ_remember, succ_recall, succ_forget: Memory management
 * - succ_dead_end: Record failed approaches
 * - succ_link: Knowledge graph (actions: create/delete/show/graph/auto/enrich/proximity/communities/centrality/export/cleanup/explore)
 * - succ_fetch: Fetch URLs + structured extraction (schema param)
 * - succ_status: Status, token stats, AI-readiness score (actions: overview/stats/score)
 * - succ_config: Config + checkpoints (actions: show/set/checkpoint_create/checkpoint_list)
 * - succ_index: Indexing + analysis + symbols (actions: doc/code/analyze/refresh/symbols)
 * - succ_prd: PRD pipeline (actions: generate/list/status/run/export)
 * - succ_web: Web search (actions: quick/search/deep/history)
 * - succ_debug: Structured debugging (12 actions)
 *
 * Tool profiles: auto (detect by client), core (8), standard (12), full (14)
 * Configure via: succ_config(action="set", key="tool_profile", value="auto|core|standard|full")
 * Auto-profile: Claude clients → full, other clients → standard
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  closeDb,
  closeGlobalDb,
  initStorageDispatcher,
  closeStorageDispatcher,
} from '../lib/storage/index.js';
import { cleanupEmbeddings } from '../lib/embeddings.js';
import { cleanupQualityScoring } from '../lib/quality.js';
import { getProjectRoot, getToolProfile } from '../lib/config.js';
import { logError, logInfo, logWarn } from '../lib/fault-logger.js';
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
import { registerWebFetchTools } from './tools/web-fetch.js';
import { setResolvedProfile } from './profile.js';

// ---------------------------------------------------------------------------
// Tool profile definitions
// ---------------------------------------------------------------------------

/** Core tools — always available, most commonly used (8 tools) */
const CORE_TOOLS = new Set([
  'succ_recall',
  'succ_remember',
  'succ_forget',
  'succ_search',
  'succ_search_code',
  'succ_dead_end',
  'succ_fetch',
  'succ_status',
]);

/** Standard tools — core + indexing, graph, config, web search (12 tools) */
const STANDARD_TOOLS = new Set([
  ...CORE_TOOLS,
  'succ_index',
  'succ_link',
  'succ_config',
  'succ_web',
]);

// RegisteredTool type from MCP SDK (registerTool is the non-deprecated API)
type RegisteredTool = ReturnType<McpServer['registerTool']>;

/**
 * Apply tool profile — replaces non-profile tools with minimal stubs
 * that return a helpful error message with upgrade instructions.
 */
function applyToolProfile(
  tools: Map<string, RegisteredTool>,
  profile: 'core' | 'standard' | 'full'
): void {
  if (profile === 'full') return;

  const allowedTools = profile === 'core' ? CORE_TOOLS : STANDARD_TOOLS;

  for (const [name, tool] of tools) {
    if (allowedTools.has(name)) continue;

    // Determine which profile unlocks this tool
    const requiredProfile = STANDARD_TOOLS.has(name) ? 'standard' : 'full';

    try {
      tool.update({
        description: `[Requires "${requiredProfile}" profile] Use succ_config(action="set", key="tool_profile", value="${requiredProfile}") to enable.`,
        paramsSchema: {},
        callback: async () => ({
          content: [
            {
              type: 'text' as const,
              text:
                `Tool "${name}" is not available in "${profile}" profile.\n\n` +
                `To enable:\n  succ_config(action="set", key="tool_profile", value="${requiredProfile}")\n\n` +
                `Available profiles: core (8 tools), standard (12 tools), full (14 tools)`,
            },
          ],
          isError: true,
        }),
      });
    } catch (err) {
      logWarn('mcp', `Failed to apply profile restriction to tool "${name}": ${err}`);
    }
  }

  logInfo(
    'mcp',
    `Tool profile "${profile}": ${allowedTools.size} active, ${tools.size - allowedTools.size} gated`
  );
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Register all tools — capture RegisteredTool references for profile gating
// ---------------------------------------------------------------------------

const registeredTools = new Map<string, RegisteredTool>();

// Proxy server.registerTool() to capture references by name
const originalRegisterTool = server.registerTool.bind(server) as (...args: any[]) => RegisteredTool;
(server as any).registerTool = (...args: any[]) => {
  const result = originalRegisterTool(...args);
  if (typeof args[0] === 'string') {
    registeredTools.set(args[0], result);
  }
  return result;
};

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
registerWebFetchTools(server);

// Apply tool profile (gate non-profile tools with helpful error stubs)
const profile = getToolProfile();
if (profile !== 'full' && profile !== 'auto') {
  setResolvedProfile(profile);
  applyToolProfile(registeredTools, profile);
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (error) => {
  process.stderr.write(
    `[succ-mcp] UNHANDLED REJECTION: ${error instanceof Error ? error.message : String(error)}\n`
  );
  logError(
    'mcp',
    'Unhandled promise rejection',
    error instanceof Error ? error : new Error(String(error))
  );
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
  if (profile !== 'full') {
    mcpLog(`Tool profile: ${profile}`);
  }

  // Auto-profile: detect client after MCP handshake, apply profile before tools/list.
  // Safe for stdio transport (single-threaded message processing — oninitialized fires
  // before the next inbound message, so tools/list always sees the updated set).
  if (profile === 'auto') {
    server.server.oninitialized = () => {
      const clientInfo = server.server.getClientVersion();
      const clientName = (clientInfo?.name ?? '').toLowerCase();
      const isClaudeClient = clientName.includes('claude');
      const autoProfile = isClaudeClient ? 'full' : 'standard';
      mcpLog(
        `Client: ${clientInfo?.name ?? 'unknown'} v${clientInfo?.version ?? '?'} → profile: ${autoProfile}`
      );
      logInfo('mcp', `Auto-profile: client="${clientInfo?.name}", profile="${autoProfile}"`);
      setResolvedProfile(autoProfile);
      if (autoProfile !== 'full') {
        applyToolProfile(registeredTools, autoProfile);
      }
    };
  }

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
  logError(
    'mcp',
    'Failed to start MCP server',
    error instanceof Error ? error : new Error(String(error))
  );
  await closeStorageDispatcher();
  cleanupEmbeddings();
  cleanupQualityScoring();
  closeDb();
  closeGlobalDb();
  process.exit(1);
});
