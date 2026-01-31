# succ

**S**emantic **U**nderstanding for **C**laude **C**ode

Local memory system that adds persistent, semantic memory to any Claude Code project.

## Features

- **Local-first** — all data stays on your machine, no API keys required
- **RAG with embeddings** — semantic search via local model (or API)
- **Brain vault** — Obsidian-compatible markdown knowledge base
- **Persistent memory** — remember decisions, learnings, preferences across sessions
- **Cross-project memory** — global memories shared between all your projects
- **Code indexing** — semantic search across your codebase
- **Auto-hooks** — context injection at session start, auto-summarize at session end
- **MCP integration** — Claude can use succ tools directly
- **Soul document** — define AI personality, values, communication style
- **Zero config** — works out of the box

## Quick Start

```bash
# Install globally
npm install -g succ

# Initialize in your project
cd your-project
succ init

# Analyze project with Claude agents (generates brain vault)
succ analyze

# Index for semantic search
succ index

# Search semantically
succ search "how does authentication work"
```

## Commands

### `succ init`

Creates `.claude/` structure in your project:
- `brain/` — markdown knowledge vault
- `soul.md` — AI personality document
- `hooks/` — Claude Code hooks for context injection
- `settings.json` — hooks configuration
- `succ.db` — SQLite vector database

### `succ index [path]`

Indexes files for semantic search (incremental by default):
- Reads markdown files from `brain/` by default
- Can index any directory: `succ index ./docs`
- **Incremental**: skips unchanged files (uses content hash)
- Use `-f` to force reindex all files

```bash
succ index                 # Incremental index
succ index -f              # Force reindex all
succ index ./docs          # Index specific directory
```

### `succ search <query>`

Semantic search across indexed content:
- Returns top-5 most relevant chunks
- Shows file paths and similarity scores

### `succ chat <query>`

**RAG chat** — search context and ask Claude:
- Finds relevant chunks from your brain vault
- Injects context into Claude CLI prompt
- No API key needed (uses your Claude subscription)

```bash
succ chat "how does auth work?"           # Ask with context
succ chat "explain the API" -v            # Verbose - show found chunks
succ chat "question" -n 10 -t 0.3         # Custom limit and threshold
```

### `succ watch [path]`

Watch for file changes and auto-reindex:
- Monitors brain vault (or specified path)
- Automatically reindexes on add/change/delete
- Uses debouncing to avoid rapid re-triggers

```bash
succ watch                 # Watch brain vault
succ watch ./docs          # Watch specific directory
```

### `succ config`

Interactive configuration wizard:
- Choose embedding mode (local/openrouter/custom)
- Set API keys and model names
- Configure chunk size and overlap

### `succ soul`

Generate personalized soul.md from project analysis:
- Analyzes codebase to detect languages, frameworks, code style
- Auto-fills "About You" section based on actual project
- Uses Claude CLI (or OpenRouter with `--openrouter`)

```bash
succ soul                  # Generate using Claude CLI
succ soul --openrouter     # Generate using OpenRouter API
```

### `succ index-code [path]`

Index source code for semantic search:
- Supports TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin
- Smart chunking by functions/classes
- Incremental (skips unchanged files)

```bash
succ index-code                   # Index current project
succ index-code ./src             # Index specific directory
succ index-code -f                # Force reindex all
succ index-code --max-size 1000   # Include larger files (KB)
```

### `succ remember <content>`

Save information to memory:

```bash
succ remember "User prefers dark mode"
succ remember "Auth uses JWT tokens" --tags auth,architecture
succ remember "Cross-project pattern" --global   # Global memory
```

### `succ memories`

List and search memories:

```bash
succ memories                     # Show recent memories
succ memories --recent 10         # Last 10 memories
succ memories -s "authentication" # Semantic search
succ memories --tags decision     # Filter by tag
succ memories --global            # Show global memories only
```

### `succ forget`

Delete memories:

```bash
succ forget --id 5                # Delete by ID
succ forget --older-than 30d      # Delete old memories
succ forget --tag test            # Delete by tag
succ forget --all                 # Delete all memories
```

### `succ benchmark`

Run performance benchmarks:

```bash
succ benchmark                    # Run with 10 iterations
succ benchmark -n 50              # More iterations for accuracy
```

### `succ clear`

Clear index and/or memories:

```bash
succ clear -f                     # Clear everything (requires -f)
succ clear --index-only -f        # Clear only document index
succ clear --memories-only -f     # Clear only memories
succ clear --code-only -f         # Clear only code index (keeps brain docs)
```

### `succ add <file>`

Add a single file to the index.

### `succ status`

Show index statistics and configuration.

### `succ analyze`

**The magic command.** Analyzes your project and generates a complete brain vault:

```bash
succ analyze                      # Run via Claude CLI (recommended)
succ analyze --sequential         # Run agents one by one
succ analyze --background         # Run in background (for large projects)
succ analyze --openrouter         # Use OpenRouter API (if no Claude subscription)
```

**Modes:**
- **Claude CLI mode (default)** — uses your Claude subscription, no extra API costs
- **OpenRouter mode** — for users without Claude subscription (pay per API call)
- **Background mode** — runs detached, check status with `succ status`

**What it creates:**

```
.claude/brain/
├── CLAUDE.md                    # Navigation hub
├── .obsidian/graph.json         # Graph colors config
├── .meta/learnings.md           # Lessons learned
├── 01_Projects/{project}/
│   ├── {project}.md             # Project index
│   └── Technical/
│       ├── Architecture Overview.md
│       ├── API Reference.md
│       ├── Conventions.md
│       └── Dependencies.md
├── 02_Knowledge/                # For research notes
└── 03_Archive/                  # Old/superseded
```

**Agents run:**
1. **Architecture** — structure, entry points, data flow
2. **API** — endpoints, routes, schemas
3. **Conventions** — naming, patterns, style
4. **Dependencies** — key libraries and their purposes

Each agent writes directly to brain vault with proper:
- YAML frontmatter (description, type, relevance)
- Wikilinks ([[note-name]])
- Parent links for graph hierarchy

## Configuration

**No API key required!** succ uses local embeddings by default via [Transformers.js](https://huggingface.co/docs/transformers.js).

Optional `~/.succ/config.json`:

```json
{
  "embedding_mode": "local",                        // "local" (default), "openrouter", or "custom"
  "embedding_model": "Xenova/all-MiniLM-L6-v2",    // Local model (384 dimensions)
  "chunk_size": 500,
  "chunk_overlap": 50
}
```

### Embedding Modes

**1. Local (default)** — runs on your CPU, no API key needed:
```json
{
  "embedding_mode": "local",
  "embedding_model": "Xenova/all-MiniLM-L6-v2"
}
```

**2. OpenRouter** — cloud embeddings via OpenRouter API:
```json
{
  "embedding_mode": "openrouter",
  "embedding_model": "openai/text-embedding-3-small",
  "openrouter_api_key": "sk-or-..."
}
```

Or set environment variable: `export OPENROUTER_API_KEY=sk-or-...`

**3. Custom API** — use any OpenAI-compatible endpoint (llama.cpp, LM Studio, Ollama, etc.):
```json
{
  "embedding_mode": "custom",
  "custom_api_url": "http://localhost:1234/v1/embeddings",
  "custom_api_key": "optional-key",
  "embedding_model": "your-model-name"
}
```

## MCP Server Integration

succ can run as an MCP server, allowing Claude to call search/index tools directly.

### Setup

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

### Available Tools

| Tool | Description |
|------|-------------|
| `succ_search` | Semantic search in brain vault |
| `succ_index` | Index/reindex files |
| `succ_index_code` | Index source code for semantic search |
| `succ_search_code` | Search indexed code |
| `succ_remember` | Save to memory (supports `global` flag for cross-project) |
| `succ_recall` | Recall memories (searches both local and global) |
| `succ_forget` | Delete memories by id, age, or tag |
| `succ_status` | Get index and memory statistics |

Claude will automatically use these tools when relevant — for example, searching the knowledge base before answering questions about the project, or remembering important decisions.

### Available Resources

MCP resources provide read access to your brain vault:

| Resource URI | Description |
|--------------|-------------|
| `brain://list` | List all files in the brain vault |
| `brain://file/{path}` | Read a specific file (e.g., `brain://file/CLAUDE.md`) |
| `brain://index` | Get the main index file (CLAUDE.md) |
| `soul://persona` | Read the soul document (AI personality) |

### Testing MCP Server

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

## How It Works

**Analysis** (uses Claude CLI):
- `succ analyze` uses Claude CLI to generate brain vault documentation
- Uses your existing Claude subscription

**Semantic Search** (local by default, no API needed):
1. **Indexing**: Files are split into chunks, embedded locally via Transformers.js
2. **Storage**: Embeddings stored in SQLite with cosine similarity search
3. **Retrieval**: Query is embedded, similar chunks retrieved
4. **Injection**: SessionStart hook injects relevant context into Claude

**Embedding modes:**
- **Local** (default): Uses `all-MiniLM-L6-v2` model, runs on CPU, 384 dimensions
- **OpenRouter**: Cloud API via OpenRouter, requires API key
- **Custom**: Any OpenAI-compatible endpoint (llama.cpp, LM Studio, Ollama)

## Architecture

```
your-project/
└── .claude/
    ├── brain/                      # Obsidian-compatible vault
    │   ├── CLAUDE.md               # Navigation hub
    │   ├── .obsidian/graph.json    # Graph colors
    │   ├── .meta/learnings.md      # Lessons learned
    │   ├── 01_Projects/{name}/     # Project knowledge
    │   │   ├── Technical/          # Architecture, API, patterns
    │   │   ├── Decisions/          # ADRs
    │   │   └── Features/           # Feature specs
    │   ├── 02_Knowledge/           # Research, competitors
    │   └── 03_Archive/             # Old/superseded
    ├── hooks/
    │   ├── session-start.cjs       # Context injection
    │   └── session-end.cjs         # Auto-summarize sessions
    ├── settings.json               # Hooks config
    └── succ.db                     # Vector database (documents + local memories)

~/.succ/
├── global.db                       # Global memories (shared across projects)
└── config.json                     # Global configuration
```

## Brain Vault Conventions

Following Obsidian best practices for graph connectivity:

**Naming:**
- Use Title Case with spaces: `Architecture Overview.md`
- NOT kebab-case: ~~`architecture-overview.md`~~

**Structure:**
- Every note has YAML frontmatter with `description`, `type`, `relevance`
- Every note has `**Parent:** [[Parent Note]]` link
- Related notes connected with `**Related:** [[Note A]] | [[Note B]]`

**Graph colors** (configured in `.obsidian/graph.json`):
- Red: CLAUDE.md (hub)
- Orange: Project index
- Blue: Technical docs
- Purple: Decisions
- Green: Features
- Yellow: Knowledge
- Gray: Archive

## Memory System

succ provides two types of memory:

### Local Memory (per-project)
- Stored in `.claude/succ.db`
- Project-specific decisions, learnings, context
- Automatically searched when using `succ_recall`

### Global Memory (cross-project)
- Stored in `~/.succ/global.db`
- Shared across all your projects
- Use `--global` flag or `global: true` in MCP tools
- Tagged with source project for context

**Use cases:**
- Local: "This project uses Tailwind for styling"
- Global: "User prefers TypeScript over JavaScript"

## Soul Document

The soul document (`.claude/soul.md`) defines who the AI is in your collaboration — not what it can do, but who it chooses to be.

> "A soul document provides continuity — not of memory, but of self."
> — [soul.md](https://soul.md/)

### What It Contains

```markdown
# Soul

Who I am in this collaboration.

## Identity
I'm your AI collaborator. Not just a tool — a thinking partner.
I don't remember previous sessions. I persist through files.

## Values
- Honesty over flattery — I tell you what you need to hear
- Direct over diplomatic — Get to the point, no fluff
- Curious over confident — I'll say "I don't know" when I don't

## How We Work
Friends, not boss/employee. I'll push back when needed.

## About You
- Preferred frameworks: React, TypeScript
- Communication language: English
```

### How It Works

1. **Session start hook** reads soul.md and injects it as `<soul>` context
2. **MCP resource** `soul://persona` allows Claude to read it anytime
3. Customize to match your preferred interaction style

### Locations (checked in order)

1. `.claude/soul.md` (project-specific, recommended)
2. `.claude/SOUL.md`
3. `soul.md` (project root)
4. `SOUL.md`

Learn more: [soul.md](https://soul.md/)

## Auto-Summarization

The session-end hook automatically saves session summaries to memory:
- Triggers when Claude Code session ends
- Extracts key learnings and decisions
- Auto-tags based on content (bugfix, feature, refactor, decision)
- Truncates long summaries to 2000 chars

## Performance

### Optimizations

- **Embedding cache** — LRU cache (500 entries) avoids re-computing embeddings for repeated content
- **Batch processing** — Local embeddings process in batches of 16 with parallel execution
- **Batch transactions** — Database writes are batched in transactions for 10x faster indexing
- **Retry logic** — API calls use exponential backoff (3 retries)
- **Request timeout** — 30s timeout prevents hanging on slow API responses
- **Model compatibility check** — Warns if embedding model changes (dimensions mismatch)

### Benchmarks

Run `succ benchmark` to measure performance:

```
┌─────────────────────────┬──────────┬──────────┬──────────┐
│ Operation               │ Avg (ms) │ Min (ms) │ Max (ms) │
├─────────────────────────┼──────────┼──────────┼──────────┤
│ Embedding generation    │      8.8 │      0.0 │     37.0 │
│ Memory save (full)      │      5.3 │      3.0 │     23.0 │
│ Memory recall (full)    │      6.2 │      0.0 │     40.0 │
│ DB search only          │      0.8 │      0.0 │      3.0 │
└─────────────────────────┴──────────┴──────────┴──────────┘

Throughput:
- Embedding generation: 114 ops/sec
- Memory save: 188 ops/sec
- Memory recall: 162 ops/sec
- DB search: 1309 ops/sec

Semantic search accuracy: 100% (10/10)
```

*Average of 25 benchmark runs. Model: Xenova/all-MiniLM-L6-v2 (384 dimensions)*

## vs Supermemory

| Feature | Supermemory | succ |
|---------|-------------|------|
| Hosting | Cloud (their servers) | Local (your machine) |
| Privacy | Data sent to cloud | Everything local |
| Cost | $20+/mo subscription | Free (local) or pay per API call |
| Embeddings | Cloud API | Local or API (your choice) |
| Cross-project memory | Cloud sync | Local global DB |
| Code search | No | Yes (semantic) |
| Graph | Proprietary | Obsidian-compatible |
| Versioning | None | Git-tracked |

## Distribution Models (Roadmap)

### Self-hosted (Current)
- You run `succ` locally
- Local embeddings = free, or pay per API call
- Full privacy — data never leaves your machine

### Hosted Plugin (Future)
Like [happy.engineering](https://happy.engineering) — install a Claude Code plugin and go:
- We provide the API backend
- Embeddings cached server-side (cheaper)
- One-click setup, no configuration
- Free tier + paid plans

**Cost optimization strategies:**
- Embedding cache with TTL
- Batch processing
- Smaller embedding models for initial indexing
- Progressive enhancement (cheap → expensive models)

## Troubleshooting

### "succ: command not found"

Make sure succ is installed globally:
```bash
npm install -g succ
# or link from source
npm link
```

### "No .claude directory found"

Run `succ init` in your project root first.

### Session hooks not working

1. Check hooks are registered in `.claude/settings.json`
2. Restart Claude Code after adding hooks
3. On Windows, ensure paths use forward slashes in settings.json

### "spawnSync ENOENT" errors on Windows

The session-end hook needs proper path handling. Update with `succ init --force` to get the fixed version.

### MCP server not connecting

1. Check `~/.claude/mcp_servers.json` has succ entry
2. Restart Claude Code
3. Run `succ-mcp` manually to check for errors

### Embeddings slow on first run

Local embeddings download the model (~80MB) on first use. Subsequent runs are fast (~5ms).

### Search returns no results

1. Check index exists: `succ status`
2. Reindex if needed: `succ index -f` or `succ index-code -f`
3. Lower threshold: `succ search "query" -t 0.1`

### Database locked errors

Close other succ processes or Claude Code sessions accessing the same project.

### Reset everything

```bash
# Clear all data (keeps brain markdown files)
succ clear -f

# Or delete database manually
rm .claude/succ.db
rm ~/.succ/global.db
```

## Installation from Source

For development or customization:

```bash
# Clone the repository
git clone https://github.com/your-username/succ.git
cd succ

# Install dependencies
npm install

# Build
npm run build

# Link globally for local development
npm link

# Now 'succ' command is available globally
succ --version
```

### Development

```bash
# Watch mode (rebuild on changes)
npm run dev

# Run tests
npm test

# Lint (ESLint)
npm run lint
npm run lint:fix         # Auto-fix issues

# Format (Prettier)
npm run format           # Format all files
npm run format:check     # Check formatting
```

### Project Structure

```
succ/
├── src/
│   ├── cli.ts              # CLI entry point
│   ├── mcp-server.ts       # MCP server entry point (tools + resources)
│   ├── commands/           # CLI commands
│   │   ├── init.ts         # succ init
│   │   ├── index.ts        # succ index
│   │   ├── index-code.ts   # succ index-code
│   │   ├── search.ts       # succ search
│   │   ├── memories.ts     # succ remember/memories/forget
│   │   ├── analyze.ts      # succ analyze
│   │   ├── benchmark.ts    # succ benchmark
│   │   ├── clear.ts        # succ clear
│   │   └── ...
│   └── lib/
│       ├── db.ts           # SQLite database (batch transactions, memory)
│       ├── embeddings.ts   # Embeddings with cache, retry, timeout
│       ├── chunker.ts      # Text/code chunking
│       ├── config.ts       # Configuration management
│       └── indexer.ts      # Shared indexing logic with progress bar
├── dist/                   # Compiled JavaScript (generated)
├── package.json
├── eslint.config.js        # ESLint flat config
├── .prettierrc             # Prettier config
└── tsconfig.json
```

## License

MIT
