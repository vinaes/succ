# Continue.dev Integration

## Setup

### Option 1: Via `succ setup`

```bash
succ setup continue
```

### Option 2: Manual Configuration

Edit `~/.continue/config.json` and add succ to the `mcpServers` section:

```json
{
  "mcpServers": [
    {
      "name": "succ",
      "command": "succ-mcp",
      "args": []
    }
  ]
}
```

From source:

```json
{
  "mcpServers": [
    {
      "name": "succ",
      "command": "node",
      "args": ["/path/to/succ/dist/mcp-server.js"]
    }
  ]
}
```

**Note:** Continue.dev uses an array format for `mcpServers`, unlike other editors that use an object.

## Config Path by Platform

| Platform | Path |
|----------|------|
| macOS | `~/.continue/config.json` |
| Linux | `~/.continue/config.json` |
| Windows | `%USERPROFILE%\.continue\config.json` |

## Verify

1. Open VS Code with Continue.dev extension
2. Open Continue settings and check MCP connections
3. succ tools should appear in the available tools list

## Notes

- Continue.dev config uses **array format** for MCP servers (not object)
- Restart VS Code after configuration changes
- succ session hooks are Claude Code specific — use `succ watch` daemon for automatic indexing
- Continue.dev works with any LLM provider (OpenAI, Anthropic, local) — succ tools are LLM-agnostic
