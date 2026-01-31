# succ

**S**emantic **U**nderstanding for **C**laude **C**ode

Local memory system that adds persistent, semantic memory to any Claude Code project.

## Features

- **Local-first** — all data stays on your machine, no API keys required
- **RAG with embeddings** — semantic search via local model (or API)
- **Brain vault** — Obsidian-compatible markdown knowledge base
- **Auto-hooks** — context injection at session start
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
| `succ_status` | Get index statistics |

Claude will automatically use these tools when relevant — for example, searching the knowledge base before answering questions about the project.

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
    │   └── session-start.cjs       # Context injection
    ├── settings.json               # Hooks config
    └── succ.db                     # Vector database
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

## vs Supermemory

| Feature | Supermemory | succ |
|---------|-------------|------|
| Hosting | Cloud (their servers) | Local (your machine) |
| Privacy | Data sent to cloud | Everything local |
| Cost | $20+/mo subscription | Free (local) or pay per API call |
| Embeddings | Cloud API | Local or API (your choice) |
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

## License

MIT
