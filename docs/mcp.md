# MCP Server Integration

succ can run as an MCP server, allowing AI agents to call search/index tools directly.

**Works with:** Claude Code, Cursor, Windsurf, Continue.dev — any editor supporting MCP.
See [Editor Integration](./editors/index.md) for editor-specific setup guides.

## Setup

Add to your Claude Code MCP config (`~/.claude.json`):

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
| `succ_search` | Hybrid search in brain vault (BM25 + semantic). Output modes: `full`, `lean` |
| `succ_search_code` | Search indexed code (hybrid BM25 + semantic). Regex/symbol filters. Output modes: `full`, `lean`, `signatures` |
| `succ_index_file` | Index a single brain file. Embedding modes: local (Transformers.js), openrouter, custom (Ollama/LM Studio) |
| `succ_index_code_file` | Index a single code file. Same embedding modes |
| `succ_reindex` | Detect stale/deleted index entries, re-index modified files, clean up deleted ones |
| `succ_symbols` | Extract AST symbols from a source file via tree-sitter (13 languages) |
| `succ_analyze_file` | Analyze a file. Modes: claude (CLI/Haiku), local (Ollama/LM Studio), openrouter (cloud) |
| `succ_remember` | Save to memory (supports `global` flag for cross-project) |
| `succ_recall` | Recall memories (searches both local and global) |
| `succ_forget` | Delete memories by id, age, or tag |
| `succ_dead_end` | Record failed approach to prevent retrying. Boosted in recall results |
| `succ_link` | Create/manage links between memories (knowledge graph) |
| `succ_explore` | Explore knowledge graph from a memory |
| `succ_status` | Get index, memory, and daemon statistics |
| `succ_stats` | Get token savings statistics |
| `succ_score` | Get AI-readiness score (how ready is project for AI) |
| `succ_config` | Show current configuration with all effective values |
| `succ_config_set` | Update config value (key=value). Saves to ~/.succ/config.json |
| `succ_checkpoint` | Create/list backups of succ data |
| `succ_debug` | Structured debugging sessions — hypotheses, instrumentation, results (14 languages) |
| `succ_prd_generate` | Generate PRD from feature description |
| `succ_prd_list` | List all PRDs |
| `succ_prd_status` | Show PRD details and task status |
| `succ_prd_run` | Execute PRD tasks with quality gates |
| `succ_prd_export` | Export PRD workflow to Obsidian |
| `succ_quick_search` | Quick web search (default: Perplexity Sonar, configurable) |
| `succ_web_search` | Quality web search (default: Perplexity Sonar Pro, configurable) |
| `succ_deep_research` | Deep multi-step research (default: Perplexity Deep Research, configurable) |
| `succ_web_search_history` | View past web searches with filtering — costs, usage stats |
| `succ_fetch` | Fetch any URL and convert to clean Markdown via md.succ.ai (Readability + Playwright). No content summarization or truncation. Prefer over built-in WebFetch |

Claude will automatically use these tools when relevant — for example, searching the knowledge base before answering questions about the project, or remembering important decisions.

### Tool Parameters Reference

**succ_search** — Hybrid search in brain vault (BM25 + semantic)
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | *required* | Search query. Use `*` or empty to list recent documents |
| `limit` | number | 5 | Maximum results |
| `threshold` | number | 0.2 | Similarity threshold (0-1) |
| `output` | `"full"` \| `"lean"` | `"full"` | `lean` returns file+lines only (saves tokens) |

<details>
<summary>succ_search examples</summary>

**Search brain vault for embedding docs:**
```
query: "embedding"
limit: 3
```
Returns matching brain vault chunks with file path, content preview, and similarity score:
```
1. .succ/brain/inbox/2026-02-09 Observation (4525).md:1-6 (82.3%)
   Local embedding mode uses Transformers.js, CPU-bound, achieves 50-100 chunks/sec...
```

**Browse recent documents:**
```
query: "*"
limit: 10
```
Use `*` as a wildcard query to list the most recently indexed brain vault files.

**Lean output for token-efficient navigation:**
```
query: "architecture"
output: "lean"
```
Returns file paths and line ranges only — useful when you need to locate files before reading them:
```
1. .succ/brain/project/technical/Architecture.md:1-42 (78%)
2. .succ/brain/project/systems/Storage.md:10-35 (71%)
```

**Raise threshold for precise matches:**
```
query: "PRD pipeline quality gates"
threshold: 0.5
```
Higher threshold (default 0.2) filters out loosely related results — returns only strong semantic matches.

</details>

**succ_search_code** — Hybrid search in indexed source code (BM25 + semantic)
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | *required* | What to search for |
| `limit` | number | 5 | Maximum results |
| `threshold` | number | 0.25 | Similarity threshold (0-1) |
| `regex` | string | — | Regex filter — only return results matching this pattern |
| `symbol_type` | `"function"` \| `"method"` \| `"class"` \| `"interface"` \| `"type_alias"` | — | Filter by AST symbol type |
| `output` | `"full"` \| `"lean"` \| `"signatures"` | `"full"` | `lean` = file+lines, `signatures` = symbol names+signatures only |

<details>
<summary>succ_search_code examples</summary>

**Find all async functions related to search:**
```
query: "search"
regex: "async"
```
Returns only code chunks containing `async` — useful for filtering by keyword patterns that semantic search alone can't target.

**Find only exported functions named "upsert*":**
```
query: "upsert"
symbol_type: "function"
```
Filters results to `function` symbols only (excludes methods, classes, interfaces). Tree-sitter AST metadata is used for filtering, so results are accurate regardless of naming conventions.

**Get a quick overview of hybrid search interfaces:**
```
query: "hybrid search"
output: "signatures"
```
Returns symbol names and signatures without code bodies — compact output for discovery:
```
1. src/lib/storage/types.ts:181 (63%) — export interface HybridMemoryResult {
2. src/lib/db/hybrid-search.ts:47 (62%) — export interface HybridGlobalMemoryResult {
```

**Lean output for config-related code:**
```
query: "config"
output: "lean"
```
Returns file paths and line ranges only — minimal tokens for navigation:
```
1. src/lib/config.ts:1113-1242 (70.1%)
2. src/lib/config.ts:42-103 (68.9%)
```

**Combine filters:**
```
query: "search"
regex: "export async function"
symbol_type: "function"
limit: 10
```
Regex and symbol_type filters stack — both must match for a result to be included.

</details>

**succ_symbols** — Extract AST symbols from a source file via tree-sitter
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `file` | string | *required* | Path to source file |
| `type` | `"all"` \| `"function"` \| `"method"` \| `"class"` \| `"interface"` \| `"type_alias"` | `"all"` | Filter by symbol type |

Supported languages: TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C, C++, C#, PHP, Ruby, Swift.

**succ_reindex** — Detect and fix stale/deleted index entries. No parameters (uses project_path).

**succ_dead_end** — Record a failed approach to prevent retrying
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `approach` | string | *required* | What was tried |
| `why_failed` | string | *required* | Why it failed |
| `context` | string | — | Additional context (file paths, error messages) |
| `tags` | string[] | `[]` | Tags for categorization |

**succ_checkpoint** — Create/manage backups of succ data
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `action` | `"create"` \| `"list"` | *required* | Operation to perform |
| `compress` | boolean | false | Compress backup file |
| `include_brain` | boolean | true | Include brain vault in backup |
| `include_documents` | boolean | true | Include indexed documents |

> **Note:** `restore` is available via CLI only (`succ checkpoint restore <file>`), not via MCP.

**succ_fetch** — Fetch any URL and convert to clean Markdown
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string (URL) | *required* | URL to fetch and convert to markdown |
| `format` | `"markdown"` \| `"json"` | `"markdown"` | Output format: `markdown` returns clean content, `json` includes metadata (tokens, quality, extraction method) |

**succ_web_search_history** — View past web searches
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tool_name` | `"succ_quick_search"` \| `"succ_web_search"` \| `"succ_deep_research"` | — | Filter by tool |
| `model` | string | — | Filter by model (e.g., `"perplexity/sonar-pro"`) |
| `query_text` | string | — | Filter by query substring |
| `date_from` | string | — | Start date (ISO format) |
| `date_to` | string | — | End date (ISO format) |
| `limit` | number | 20 | Max records to return |

> **Note:** All tools accept an optional `project_path` parameter. Pass the absolute path to the project directory to ensure succ operates in project mode rather than global-only mode.

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
| **Search brain** | `succ search` | `succ_search` | Both light, MCP adds output modes |
| **Search code** | — | `succ_search_code` | Light: hybrid search with regex/symbol filters |
| **Reindex stale** | — | `succ_reindex` | Light: mtime+hash detection |
| **Extract symbols** | — | `succ_symbols` | Light: tree-sitter AST (13 languages) |
| **Analyze (full)** | `succ analyze` | — | Heavy: runs multiple agents, generates docs |
| **Analyze (file)** | — | `succ_analyze_file` | Light: single file with LLM |
| **Remember** | `succ remember` | `succ_remember` | Both light, MCP for in-conversation |
| **Recall** | `succ memories` | `succ_recall` | Both light, MCP for in-conversation |
| **Forget** | `succ forget` | `succ_forget` | Both light |
| **Knowledge graph** | `succ graph` | `succ_link`, `succ_explore` | CLI for export/stats, MCP for navigation |
| **Status** | `succ status` | `succ_status` | Both light, MCP adds daemon info |
| **Token stats** | — | `succ_stats` | Light: token savings statistics |
| **AI-readiness** | — | `succ_score` | Light: project readiness score |
| **Checkpoint** | — | `succ_checkpoint` | Light: create/list/restore backups |
| **Config** | `succ config` / `succ config --show` | `succ_config` | CLI: wizard or show, MCP: show only |
| **Watch daemon** | `succ watch` | — | Long-running background process |
| **RAG chat** | `succ chat` | — | Interactive terminal session |
| **Soul generator** | `succ soul` | — | Heavy: analyzes project, generates persona |
| **Consolidate** | `succ consolidate` | — | Heavy: merges/deduplicates memories |
| **Dead-end tracking** | — | `succ_dead_end` | Light: record failed approaches |
| **Web search history** | — | `succ_web_search_history` | Light: search cost/usage audit |
| **Web fetch** | — | `succ_fetch` | Light: fetch + convert via md.succ.ai |
| **Session tools** | `succ session-summary`, `succ precompute-context` | — | Heavy: processes transcripts |

### Design Principles

1. **MCP = Fast & Focused**: Tools that complete in seconds, operate on single items
2. **CLI = Heavy & Batch**: Commands that scan directories, run daemons, or need user interaction
3. **No Duplication**: If MCP has single-file version, CLI doesn't need it (and vice versa)
4. **Daemons = CLI Only**: Watch, analyze daemon run in background, not via MCP calls
