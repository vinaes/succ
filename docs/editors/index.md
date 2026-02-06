# Editor Integration

succ works with any editor that supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). The MCP server uses standard STDIO transport — no editor-specific adapters needed.

## Supported Editors

| Editor | Config Path | Status |
|--------|------------|--------|
| [Claude Code](./claude-code.md) | `~/.claude.json` | Full support |
| [Cursor](./cursor.md) | `.cursor/mcp.json` | Full support |
| [Windsurf](./windsurf.md) | `~/.codeium/windsurf/mcp_config.json` | Full support |
| [Continue.dev](./continue-dev.md) | `~/.continue/config.json` | Full support |

## Quick Setup

The fastest way to configure any editor:

```bash
# Auto-detect and configure all installed editors
succ setup --detect

# Or configure a specific editor
succ setup claude
succ setup cursor
succ setup windsurf
succ setup continue
```

## Manual Setup

All editors use the same MCP server binary. The configuration format varies slightly per editor, but the core payload is identical:

```json
{
  "command": "succ-mcp",
  "args": []
}
```

If `succ-mcp` is not in your PATH (e.g., running from source):

```json
{
  "command": "node",
  "args": ["/absolute/path/to/succ/dist/mcp-server.js"]
}
```

See the editor-specific guides for exact config file format and location.

## How It Works

1. Your editor spawns the `succ-mcp` process
2. Communication happens via JSON-RPC 2.0 over stdin/stdout
3. succ provides 20+ tools (search, remember, recall, etc.) and 4 resources
4. The editor calls these tools automatically when relevant

See [MCP Server docs](../mcp.md) for the full list of available tools and resources.
