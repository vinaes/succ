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
| `succ_index_file` | Index a single brain file. Embedding modes: local (Transformers.js), openrouter, custom (Ollama/LM Studio) |
| `succ_index_code_file` | Index a single code file. Same embedding modes |
| `succ_search_code` | Search indexed code |
| `succ_analyze_file` | Analyze a file. Modes: claude (CLI/Haiku), local (Ollama/LM Studio), openrouter (cloud) |
| `succ_remember` | Save to memory (supports `global` flag for cross-project) |
| `succ_recall` | Recall memories (searches both local and global) |
| `succ_forget` | Delete memories by id, age, or tag |
| `succ_link` | Create/manage links between memories (knowledge graph) |
| `succ_explore` | Explore knowledge graph from a memory |
| `succ_status` | Get index, memory, and daemon statistics |
| `succ_config` | Show current configuration with all effective values |
| `succ_config_set` | Update config value (key=value). Saves to ~/.succ/config.json |

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

## CLI vs MCP Comparison

MCP tools are designed for **lightweight, single-item operations** that Claude can call during a conversation. CLI commands handle **heavy batch operations** that run independently.

| Feature | CLI | MCP | Why |
|---------|-----|-----|-----|
| **Initialize** | `succ init` | — | One-time setup, interactive prompts |
| **Index brain (full)** | `succ index` | — | Heavy: scans all files, generates embeddings |
| **Index brain (file)** | `succ add <file>` | `succ_index_file` | Light: single file, fast |
| **Index code (full)** | `succ index-code` | — | Heavy: scans entire codebase |
| **Index code (file)** | — | `succ_index_code_file` | Light: single file on demand |
| **Search brain** | `succ search` | `succ_search` | Both light, MCP for in-conversation |
| **Search code** | — | `succ_search_code` | Light: query indexed code |
| **Analyze (full)** | `succ analyze` | — | Heavy: runs multiple agents, generates docs |
| **Analyze (file)** | — | `succ_analyze_file` | Light: single file with LLM |
| **Remember** | `succ remember` | `succ_remember` | Both light, MCP for in-conversation |
| **Recall** | `succ memories` | `succ_recall` | Both light, MCP for in-conversation |
| **Forget** | `succ forget` | `succ_forget` | Both light |
| **Knowledge graph** | `succ graph` | `succ_link`, `succ_explore` | CLI for export/stats, MCP for navigation |
| **Status** | `succ status` | `succ_status` | Both light, MCP adds daemon info |
| **Config** | `succ config` / `succ config --show` | `succ_config` | CLI: wizard or show, MCP: show only |
| **Watch daemon** | `succ watch` | — | Long-running background process |
| **RAG chat** | `succ chat` | — | Interactive terminal session |
| **Soul generator** | `succ soul` | — | Heavy: analyzes project, generates persona |
| **Consolidate** | `succ consolidate` | — | Heavy: merges/deduplicates memories |
| **Session tools** | `succ session-summary`, `succ precompute-context` | — | Heavy: processes transcripts |

### Design Principles

1. **MCP = Fast & Focused**: Tools that complete in seconds, operate on single items
2. **CLI = Heavy & Batch**: Commands that scan directories, run daemons, or need user interaction
3. **No Duplication**: If MCP has single-file version, CLI doesn't need it (and vice versa)
4. **Daemons = CLI Only**: Watch, analyze daemon run in background, not via MCP calls
