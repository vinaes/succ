# succ

**S**emantic **U**nderstanding for **C**laude **C**ode

Local memory system that adds persistent, semantic memory to any Claude Code project.

## Features

- **Local-first** — all data stays on your machine
- **RAG with embeddings** — semantic search via OpenRouter API
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

Indexes files for semantic search:
- Reads markdown files from `brain/` by default
- Can index any directory: `succ index ./docs`
- Creates embeddings via OpenRouter API
- Stores vectors in local SQLite database

### `succ search <query>`

Semantic search across indexed content:
- Returns top-5 most relevant chunks
- Shows file paths and similarity scores
- Can be used by hooks for context injection

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

**No API key required by default!** succ uses local embeddings via [Transformers.js](https://huggingface.co/docs/transformers.js).

Optional `~/.succ/config.json`:

```json
{
  "embedding_mode": "local",                        // "local" (default) or "openrouter"
  "embedding_model": "Xenova/all-MiniLM-L6-v2",    // Local model (384 dimensions)
  "chunk_size": 500,
  "chunk_overlap": 50
}
```

### Using OpenRouter API (optional)

If you prefer cloud embeddings:

```json
{
  "embedding_mode": "openrouter",
  "embedding_model": "openai/text-embedding-3-small",
  "openrouter_api_key": "sk-or-..."
}
```

Or set environment variable:
```bash
export OPENROUTER_API_KEY=sk-or-...
```

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
- **Local** (default): Uses `all-MiniLM-L6-v2` model, runs on CPU, ~384 dimensions
- **OpenRouter**: Uses cloud API, more models available, requires API key

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
- You pay for OpenRouter API calls
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
