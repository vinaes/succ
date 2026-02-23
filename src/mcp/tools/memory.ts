import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerRememberTool } from './memory/remember.js';
import { registerRecallTool } from './memory/recall.js';
import { registerForgetTool } from './memory/forget.js';

export function registerMemoryTools(server: McpServer): void {
  registerRememberTool(server);
  registerRecallTool(server);
  registerForgetTool(server);
}
