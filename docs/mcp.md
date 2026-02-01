# MCP Server Integration

succ can run as an MCP server, allowing Claude to call search/index tools directly.

## Setup

Add to your Claude Code MCP config (`~/.claude/mcp_servers.json`):

```json
{
  "mcpServers": {
    "succ": {
      "command": "succ-mcp",
      "args": []
    }
  }
}
```

Or if running from source:

```json
{
  "mcpServers": {
    "succ": {
      "command": "node",
      "args": ["/path/to/succ/dist/mcp-server.js"]
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `succ_search` | Semantic search in brain vault |
| `succ_index` | Index/reindex files |
| `succ_index_code` | Index source code for semantic search |
| `succ_search_code` | Search indexed code |
| `succ_remember` | Save to memory (supports `global` flag for cross-project) |
| `succ_recall` | Recall memories (searches both local and global) |
| `succ_forget` | Delete memories by id, age, or tag |
| `succ_link` | Create/manage links between memories (knowledge graph) |
| `succ_explore` | Explore knowledge graph from a memory |
| `succ_status` | Get index and memory statistics |

Claude will automatically use these tools when relevant — for example, searching the knowledge base before answering questions about the project, or remembering important decisions.

## Available Resources

MCP resources provide read access to your brain vault:

| Resource URI | Description |
|--------------|-------------|
| `brain://list` | List all files in the brain vault |
| `brain://file/{path}` | Read a specific file (e.g., `brain://file/CLAUDE.md`) |
| `brain://index` | Get the main index file (CLAUDE.md) |
| `soul://persona` | Read the soul document (AI personality) |

## Testing MCP Server

Test the MCP server locally before integrating with Claude:

```bash
# Build first
npm run build

# Test with MCP Inspector (if installed)
npx @modelcontextprotocol/inspector dist/mcp-server.js

# Or run directly and check for errors
node dist/mcp-server.js
```

**Note:** After making changes to the MCP server, restart Claude Code to reload the server.

In Claude Code, test resources using `ReadMcpResourceTool`:
- `server: "succ"`, `uri: "brain://list"` — lists all brain files
- `server: "succ"`, `uri: "brain://index"` — reads CLAUDE.md or index.md
- `server: "succ"`, `uri: "brain://file/CLAUDE.md"` — reads specific file
