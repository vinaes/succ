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

# Index your codebase
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

## Configuration

Create `~/.succ/config.json`:

```json
{
  "openrouter_api_key": "sk-or-...",
  "embedding_model": "openai/text-embedding-3-small",
  "chunk_size": 500,
  "chunk_overlap": 50
}
```

Or set environment variable:
```bash
export OPENROUTER_API_KEY=sk-or-...
```

## How It Works

1. **Indexing**: Files are split into chunks, each chunk is embedded via OpenRouter
2. **Storage**: Embeddings stored in SQLite with cosine similarity search
3. **Retrieval**: Query is embedded, similar chunks retrieved
4. **Injection**: SessionStart hook injects relevant context into Claude

## Architecture

```
your-project/
└── .claude/
    ├── brain/           # Markdown knowledge base
    │   ├── decisions/   # Architecture decisions
    │   ├── learnings/   # Bug fixes, discoveries
    │   └── index.md     # Codebase overview
    ├── hooks/
    │   ├── session-start.cjs  # Context injection
    │   └── session-stop.cjs   # Auto-capture reminder
    ├── settings.json    # Hooks config
    └── succ.db          # Vector database
```

## vs Supermemory

| Feature | Supermemory | succ |
|---------|-------------|------|
| Hosting | Cloud (their servers) | Local (your machine) |
| Privacy | Data sent to cloud | Everything local |
| Cost | $20+/mo subscription | Pay per embedding |
| Graph | Proprietary | Obsidian-compatible |
| Versioning | None | Git-tracked |

## License

MIT
