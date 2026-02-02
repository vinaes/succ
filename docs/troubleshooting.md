# Troubleshooting

## "succ: command not found"

Make sure succ is installed globally:
```bash
npm install -g succ
# or link from source
npm link
```

## "No .claude directory found"

Run `succ init` in your project root first.

## Session hooks not working

1. Check hooks are registered in `.claude/settings.json`
2. Restart Claude Code after adding hooks
3. On Windows, ensure paths use forward slashes in settings.json

## "spawnSync ENOENT" errors on Windows

The session-end hook needs proper path handling. Update with `succ init --force` to get the fixed version.

## MCP server not connecting

1. Check `~/.claude/mcp_servers.json` has succ entry
2. Restart Claude Code
3. Run `succ-mcp` manually to check for errors

## Embeddings slow on first run

Local embeddings download the model (~80MB) on first use. Subsequent runs are fast (~5ms).

## Search returns no results

1. Check index exists: `succ status`
2. Reindex if needed: `succ index -f` or `succ index-code -f`
3. Lower threshold: `succ search "query" -t 0.1`

## Embedding model changed / dimension mismatch

If you change the embedding model (e.g., from local to Ollama, or between different models), you'll get a "Vectors must have same length" error because existing embeddings have different dimensions.

**Fix:** Clear the index and reindex:

```bash
# Clear document index
succ clear --index-only -f

# Clear code index
succ clear --code-only -f

# Reindex
succ index
succ index-code
```

**Common dimension sizes:**

| Model | Dimensions |
|-------|------------|
| `Xenova/all-MiniLM-L6-v2` (local default) | 384 |
| `nomic-embed-text` (Ollama) | 768 |
| `bge-m3` (llama.cpp) | 1024 |
| `text-embedding-3-small` (OpenAI/OpenRouter) | 1536 |

succ will warn you when the model changes: `⚠️ Embedding model changed: old → new`

## Database locked errors

Close other succ processes or Claude Code sessions accessing the same project.

## Reset everything

```bash
# Clear all data (keeps brain markdown files)
succ clear -f

# Or delete database manually
rm .succ/succ.db
rm ~/.succ/global.db
```
