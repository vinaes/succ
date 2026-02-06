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
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeDb, closeGlobalDb } from '../lib/db/index.js';
import { cleanupEmbeddings } from '../lib/embeddings.js';
import { cleanupQualityScoring } from '../lib/quality.js';
import { setupGracefulShutdown } from './helpers.js';
import { registerResources } from './resources.js';
import { registerSearchTools } from './tools/search.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerGraphTools } from './tools/graph.js';
import { registerIndexingTools } from './tools/indexing.js';
import { registerStatusTools } from './tools/status.js';
import { registerConfigTools } from './tools/config.js';
import { registerDeadEndTools } from './tools/dead-end.js';

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
