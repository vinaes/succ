# Windsurf Integration

## Setup

### Option 1: Via `succ setup`

```bash
succ setup windsurf
```

### Option 2: Manual Configuration

Create or edit `~/.codeium/windsurf/mcp_config.json`:

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

## Config Path by Platform

| Platform | Path |
|----------|------|
| macOS | `~/.codeium/windsurf/mcp_config.json` |
| Linux | `~/.codeium/windsurf/mcp_config.json` |
| Windows | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` |

## Verify

1. Open Windsurf
2. Check the MCP section in settings — "succ" should be listed
3. Cascade (the AI agent) will use succ tools automatically

## Notes

- Restart Windsurf after configuration changes
- succ session hooks are Claude Code specific — use `succ watch` daemon for automatic indexing
- Windsurf's Cascade agent will discover succ tools automatically via MCP
