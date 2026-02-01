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

| Command | Description |
|---------|-------------|
| `succ init` | Create `.claude/` structure in your project |
| `succ analyze` | Generate brain vault with Claude agents |
| `succ index [path]` | Index files for semantic search |
| `succ index-code [path]` | Index source code |
| `succ search <query>` | Semantic search |
| `succ chat <query>` | RAG chat with context |
| `succ watch [path]` | Watch for file changes and auto-reindex |
| `succ remember <content>` | Save to memory |
| `succ memories` | List and search memories |
| `succ forget` | Delete memories |
| `succ graph <action>` | Knowledge graph operations |
| `succ config` | Interactive configuration |
| `succ status` | Show index statistics |
| `succ clear` | Clear index and/or memories |
| `succ benchmark` | Run performance benchmarks |

### succ analyze

**The magic command.** Analyzes your project and generates a complete brain vault:

```bash
succ analyze                      # Run via Claude CLI (recommended)
succ analyze --sequential         # Run agents one by one
succ analyze --background         # Run in background
succ analyze --openrouter         # Use OpenRouter API
succ analyze --local              # Use local LLM (Ollama, LM Studio)
succ analyze --daemon             # Continuous background analysis
succ analyze --status             # Check daemon status
succ analyze --stop               # Stop daemon
```

**What it creates:**

```
.claude/brain/
├── CLAUDE.md                    # Navigation hub
├── 01_Projects/{project}/
│   ├── Technical/               # Architecture, API, Conventions, Dependencies
│   ├── Systems/                 # Core systems/modules
│   ├── Strategy/                # Project goals, differentiators
│   └── Features/                # Implemented features
├── 02_Knowledge/                # Research notes
└── 03_Archive/                  # Old/superseded
```

## Configuration

**No API key required!** succ uses local embeddings by default via [Transformers.js](https://huggingface.co/docs/transformers.js).

Optional `~/.succ/config.json`:

```json
{
  "embedding_mode": "local",
  "embedding_model": "Xenova/all-MiniLM-L6-v2",
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

**3. Custom API** — any OpenAI-compatible endpoint:
```json
{
  "embedding_mode": "custom",
  "embedding_api_url": "http://localhost:11434/v1/embeddings",
  "embedding_model": "nomic-embed-text",
  "embedding_dimensions": 768
}
```

### Local LLM for Analysis

Configure in `~/.succ/config.json`:

```json
{
  "analyze_mode": "local",
  "analyze_api_url": "http://localhost:11434/v1",
  "analyze_model": "qwen2.5-coder:14b"
}
```

**Supported backends:** Ollama, LM Studio, llama.cpp, any OpenAI-compatible API.

**Recommended models:**
| Model | Size | Notes |
|-------|------|-------|
| `qwen2.5-coder:14b` | ~9GB | Best balance for 8GB VRAM |
| `qwen2.5-coder:32b` | ~20GB | Best quality, needs 12GB+ VRAM |
| `deepseek-coder-v2:16b` | ~10GB | Fast, MoE architecture |

## Memory System

succ provides two types of memory:

### Local Memory (per-project)
- Stored in `.claude/succ.db`
- Project-specific decisions, learnings, context

### Global Memory (cross-project)
- Stored in `~/.succ/global.db`
- Shared across all your projects
- Use `--global` flag

```bash
succ remember "User prefers TypeScript" --global
succ memories --global
```

## Soul Document

The soul document (`.claude/soul.md`) defines who the AI is in your collaboration:

```markdown
# Soul

## Identity
I'm your AI collaborator. Not just a tool — a thinking partner.

## Values
- Honesty over flattery
- Direct over diplomatic
- Curious over confident

## About You
- Preferred frameworks: React, TypeScript
```

Generate with: `succ soul`

Learn more: [soul.md](https://soul.md/)

## Architecture

```
your-project/
└── .claude/
    ├── brain/           # Obsidian-compatible vault
    ├── hooks/           # Claude Code hooks
    ├── settings.json    # Hooks config
    ├── soul.md          # AI personality
    └── succ.db          # Vector database

~/.succ/
├── global.db            # Global memories
└── config.json          # Global configuration
```

## Documentation

- [Ollama Setup](docs/ollama.md) — Recommended local LLM setup
- [llama.cpp GPU](docs/llama-cpp.md) — GPU-accelerated embeddings
- [MCP Integration](docs/mcp.md) — Claude Code tools and resources
- [Troubleshooting](docs/troubleshooting.md) — Common issues and fixes
- [Development](docs/development.md) — Contributing and testing

## vs Supermemory

| Feature | Supermemory | succ |
|---------|-------------|------|
| Hosting | Cloud | Local only |
| Privacy | Cloud by default | Everything local |
| Cost | Free tier, then $19-399/mo | Free forever |
| MCP integration | Yes | Yes |
| Knowledge graph | Via API | Obsidian-compatible |
| Open source | Partial | Fully open source |

## License

MIT
