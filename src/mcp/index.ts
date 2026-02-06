// ============================================================================
// MCP Server Module - Centralized Index
// ============================================================================

// Re-export types
export type { SearchResult, ToolResponse } from './types.js';

// Re-export helpers
export {
  setupGracefulShutdown,
  trackTokenSavings,
  trackMemoryAccess,
  getBrainPath,
  parseRelativeDate,
  createToolResponse,
  createErrorResponse,
} from './helpers.js';

// Re-export resource registration
export { registerResources } from './resources.js';

// Re-export tool registrations
export { registerSearchTools } from './tools/search.js';
export { registerMemoryTools } from './tools/memory.js';
export { registerGraphTools } from './tools/graph.js';
export { registerIndexingTools } from './tools/indexing.js';
export { registerStatusTools } from './tools/status.js';
export { registerConfigTools } from './tools/config.js';
