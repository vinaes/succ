# Cursor Integration

## Setup

### Option 1: Via `succ setup`

```bash
succ setup cursor
```

### Option 2: Manual Configuration

Create or edit `.cursor/mcp.json` in your project root:

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

From source:

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

For global configuration (all projects), create `~/.cursor/mcp.json` with the same content.

## Verify

1. Open Cursor Settings > MCP
2. You should see "succ" listed as a connected server
3. The tools (succ_search, succ_remember, etc.) will appear in the agent's tool list

## Notes

- Cursor uses project-level `.cursor/mcp.json` by default
- For global config, use `~/.cursor/mcp.json`
- Restart Cursor after configuration changes
- succ session hooks (SessionStart/End) are Claude Code specific and won't run in Cursor — use `succ watch` daemon for automatic indexing instead
