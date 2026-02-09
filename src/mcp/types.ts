/**
 * Shared type definitions for MCP server modules
 */

export interface SearchResult {
  file_path: string;
  content: string;
}

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
