# Claude Code Integration

## Setup

### Option 1: Via CLI (recommended)

```bash
claude mcp add succ "succ-mcp" --scope user
```

### Option 2: Via `succ setup`

```bash
succ setup claude
```

### Option 3: Manual Configuration

Add to `~/.claude.json`:

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

## Verify

1. Restart Claude Code (or run `/mcp` to check MCP status)
2. Ask Claude: "What tools do you have from succ?"
3. You should see `succ_search`, `succ_remember`, `succ_recall`, etc.

## Session Hooks

succ integrates deeply with Claude Code via session hooks. After `succ init`, these are configured automatically in `.claude/settings.json`:

- **SessionStart** — precomputes context from recent sessions
- **SessionEnd** — processes session transcript, extracts memories
- **UserPromptSubmit** — tracks activity for the daemon
- **PostToolUse** — tracks tool usage patterns

## Notes

- `~/.claude/mcp_servers.json` format is deprecated — use `~/.claude.json` instead
- MCP server output goes to stderr (stdout reserved for protocol)
- After code changes, restart Claude Code to reload the MCP server
