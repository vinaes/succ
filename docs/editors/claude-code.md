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

succ integrates deeply with Claude Code via session hooks. After `succ init`, these are configured automatically in `.claude/settings.json`.

### Hook transport

succ auto-detects your Claude Code version at `succ init` time:
- **v2.1.63+** — HTTP hooks (daemon handles requests directly, no process spawn)
- **Older** — Command hooks (`.cjs` scripts in `.succ/hooks/`)

Both transports produce identical behavior. HTTP hooks are faster (no Node.js startup) and more reliable.

### Active hooks

| Hook | Transport | Purpose |
|------|-----------|---------|
| **SessionStart** | Command only | Load context, start daemon, inject session briefing |
| **SessionEnd** | Command only | Unregister session, trigger transcript processing |
| **PreToolUse** | HTTP or Command | Dynamic hook-rules, file-linked memories, command safety guard |
| **PostToolUse** | HTTP or Command | Auto-capture git commits, deps, tests, file creation, MEMORY.md sync |
| **UserPromptSubmit** | HTTP or Command | Compact fallback, activity tracking, skill suggestions |
| **Stop** | HTTP or Command | Record stop activity for idle detection |
| **PermissionRequest** | HTTP only | Auto-approve/deny tool calls based on memory rules |
| **SubagentStop** | HTTP only | Save subagent results to memory |
| **TaskCompleted** | HTTP only | Trigger memory consolidation |

### PreToolUse vs PermissionRequest — two layers of memory-driven rules

succ uses the same hook-rules engine (`succ_remember` with `hook-rule` tag) for two distinct purposes:

**PreToolUse** — fires AFTER permission is granted, BEFORE tool executes:
- Injects context (guides Claude's behavior)
- Blocks dangerous operations (`type="error"` → deny)
- Asks for confirmation (`type="pattern"` → ask)
- Always active (HTTP and command transport)

**PermissionRequest** — fires BEFORE the permission dialog appears:
- Auto-approves safe operations (`type="allow"` → skip dialog)
- Auto-denies dangerous operations (`type="error"` → block)
- HTTP only (requires Claude Code v2.1.63+)

Both use the same `succ_remember` convention:

| Memory type | PreToolUse | PermissionRequest |
|-------------|------------|-------------------|
| `error` | Block tool call | Auto-deny |
| `pattern` | Ask user to confirm | Show permission dialog |
| `allow` | Inject as context | **Auto-approve** (skip dialog) |
| Other | Inject as context | Show permission dialog |

**Examples:**
```bash
# Auto-approve npm test (PermissionRequest skips dialog)
succ_remember content="Allow npm test" tags=["hook-rule","tool:Bash","match:^npm\\s+test"] type="allow"

# Block force-push (both PreToolUse and PermissionRequest deny)
succ_remember content="Never force-push to main" tags=["hook-rule","tool:Bash","match:push.*--force.*main"] type="error"

# Inject reminder when editing tests (PreToolUse injects context)
succ_remember content="Run tests after editing" tags=["hook-rule","tool:Edit","match:\\.test\\."] type="decision"
```

### Environment variables

- `CLAUDE_PROJECT_DIR` — used in command hook paths for portability
- `CLAUDE_ENV_FILE` — SessionStart writes `SUCC_DAEMON_PORT` so Bash commands can access the daemon
- `SUCC_SERVICE_SESSION=1` — marks internal sessions (reflection, curator) to prevent hook loops

## Notes

- `~/.claude/mcp_servers.json` format is deprecated — use `~/.claude.json` instead
- MCP server output goes to stderr (stdout reserved for protocol)
- After code changes, restart Claude Code to reload the MCP server
