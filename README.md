# succ

**S**emantic **U**nderstanding for **C**laude **C**ode

Local memory system that adds persistent, semantic memory to any Claude Code project.

## Features

- **Local-first** — all data stays on your machine, no API keys required
- **Hybrid search** — semantic embeddings + BM25 keyword search for best results
- **RAG with embeddings** — semantic search via local model (or API)
- **Brain vault** — Obsidian-compatible markdown knowledge base
- **Persistent memory** — remember decisions, learnings, preferences across sessions
- **Cross-project memory** — global memories shared between all your projects
- **Code indexing** — semantic search across your codebase
- **Knowledge graph** — link memories, auto-detect relationships, export to Obsidian
- **Auto-hooks** — context injection at session start, auto-summarize at session end
- **Idle reflections** — AI generates insights during idle time
- **Session context** — auto-generated briefings for next session
- **Sensitive filter** — detect and redact PII, API keys, secrets
- **Quality scoring** — local ONNX classification to filter noise
- **Token savings tracking** — measure how many tokens saved by RAG vs loading full files
- **Watch mode** — auto-reindex on file changes with debouncing
- **Daemon mode** — continuous background analysis
- **Local LLM support** — Ollama, LM Studio, llama.cpp for analysis
- **Sleep agent** — offload heavy operations to local LLM
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
| `succ init` | Interactive setup wizard |
| `succ analyze` | Generate brain vault with Claude agents |
| `succ index [path]` | Index files for semantic search |
| `succ index-code [path]` | Index source code |
| `succ search <query>` | Semantic search |
| `succ chat <query>` | RAG chat with context |
| `succ watch [path]` | Watch for changes and auto-reindex (docs + code) |
| `succ train-bpe` | Train BPE vocabulary from indexed code |
| `succ remember <content>` | Save to memory |
| `succ memories` | List and search memories |
| `succ forget` | Delete memories |
| `succ graph <action>` | Knowledge graph operations |
| `succ consolidate` | Merge duplicate memories |
| `succ soul` | Generate personalized soul.md |
| `succ config` | Interactive configuration |
| `succ status` | Show index statistics |
| `succ stats` | Show token savings statistics |
| `succ retention` | Memory retention analysis and cleanup |
| `succ clear` | Clear index and/or memories |
| `succ benchmark` | Run performance benchmarks |

### succ init

Interactive setup wizard that creates the `.succ/` structure and configures succ:

```bash
succ init                         # Interactive mode with prompts
succ init --yes                   # Non-interactive (use defaults)
succ init --verbose               # Show detailed output (created files)
succ init --force                 # Reinitialize existing project
```

**What it does:**
1. Creates brain vault structure (`.succ/brain/`)
2. Sets up hooks (session-start, session-end, etc.)
3. Configures MCP server for Claude Code
4. Prompts for embedding mode (Local / Local LLM / OpenRouter)
5. Prompts for analysis mode (Claude CLI / Local LLM / OpenRouter)
6. Optionally starts analyze/watch daemons

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
.succ/brain/
├── CLAUDE.md                    # Navigation hub
├── 01_Projects/{project}/
│   ├── Technical/               # Architecture, API, Conventions, Dependencies
│   ├── Systems/                 # Core systems/modules
│   ├── Strategy/                # Project goals, differentiators
│   └── Features/                # Implemented features
├── 02_Knowledge/                # Research notes
└── 03_Archive/                  # Old/superseded
```

### succ watch

Watches for file changes and auto-reindexes. By default watches both docs and code:

```bash
succ watch                        # Watch docs + code (foreground)
succ watch --daemon               # Run as background daemon
succ watch --ignore-code          # Watch only docs (skip code files)
succ watch --status               # Check daemon status
succ watch --stop                 # Stop daemon
```

Supports 120+ file extensions (based on GitHub Linguist) with comprehensive ignore patterns for build artifacts, dependencies, etc.

## Hybrid Search

succ combines semantic embeddings with BM25 keyword search for best-of-both-worlds retrieval:

### How It Works

1. **Semantic search** — finds conceptually similar content via embeddings
2. **BM25 keyword search** — finds exact matches and rare terms
3. **Reciprocal Rank Fusion** — merges results optimally

### Code-Aware Tokenizer

The code tokenizer understands all naming conventions:

| Convention | Example | Tokens |
|------------|---------|--------|
| camelCase | `getUserName` | get, user, name |
| PascalCase | `UserService` | user, service |
| snake_case | `get_user_name` | get, user, name |
| SCREAMING_SNAKE | `MAX_RETRY_COUNT` | max, retry, count |
| kebab-case | `user-profile` | user, profile |
| flatcase | `getusername` | get, user, name *(via Ronin)* |

### Ronin-Style Word Segmentation

For flatcase identifiers (no separators), succ uses dynamic programming to find optimal splits:

```
getusername → get + user + name
fetchdatafromapi → fetch + data + from + api
```

**How it works:**
- Builds token frequency table from your indexed code
- Uses log-probability scoring with length bonuses
- Falls back to base dictionary (500+ common programming terms)
- Learns your project's vocabulary over time

### BPE Tokenizer (Optional)

Train project-specific vocabulary for even better segmentation:

```bash
succ train-bpe                    # Train from indexed code
succ train-bpe --stats            # Show current vocabulary stats
```

BPE learns common token pairs in your codebase (e.g., `get`+`User` → `getUser`), improving search for project-specific terms.

### Docs vs Code

| Aspect | Documents | Code |
|--------|-----------|------|
| Tokenizer | Markdown-aware + stemming | Naming convention splitter |
| Stemming | Yes (running → run) | No (preserves exact terms) |
| Stop words | Filtered | Kept (important in code) |
| Segmentation | Standard | Ronin + BPE |

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

### Idle Watcher (Smart Reflections)

The idle watcher monitors user activity and triggers reflections only when you stop interacting — true idle detection instead of simple throttling.

**How it works:**
- SessionStart launches a background watcher daemon
- UserPromptSubmit signals "user is active"
- Stop signals "Claude responded"
- If no user activity for N minutes after Claude responds → reflection triggers
- SessionEnd cleanly shuts down the watcher

Configure in `.succ/config.json`:

```json
{
  "idle_watcher": {
    "enabled": true,
    "idle_minutes": 2,
    "check_interval": 30,
    "min_conversation_length": 5
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable idle watcher |
| `idle_minutes` | `2` | Minutes of inactivity before reflection |
| `check_interval` | `30` | Seconds between activity checks |
| `min_conversation_length` | `5` | Minimum transcript entries before reflecting |

**Safety:** Watcher auto-exits after 90 minutes of no activity to prevent zombie processes.

**Idle Reflection Operations:**
- `memory_consolidation` — merge similar memories, remove duplicates
- `graph_refinement` — auto-link related memories
- `session_summary` — extract key points from conversation
- `precompute_context` — generate next-session briefing (`.succ/next-session-context.md`)
- `write_reflection` — save AI insights as markdown with YAML frontmatter

Configure operations in `.succ/config.json`:

```json
{
  "idle_reflection": {
    "operations": {
      "precompute_context": true,
      "write_reflection": true
    }
  }
}
```

### BPE Training Config

The idle watcher can automatically retrain BPE vocabulary when code is indexed:

```json
{
  "bpe": {
    "enabled": true,
    "vocab_size": 5000,
    "min_frequency": 2,
    "retrain_interval": "hourly"
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `false` | Enable BPE tokenizer |
| `vocab_size` | `5000` | Target vocabulary size |
| `min_frequency` | `2` | Minimum pair frequency to merge |
| `retrain_interval` | `hourly` | When to retrain: `hourly` or `daily` |

Set `enabled: false` to disable automatic BPE training during idle time.

### Sleep Agent (Dual-Agent Mode)

Offload heavy idle operations to a local LLM while Claude handles reflections:

```json
{
  "idle_reflection": {
    "sleep_agent": {
      "enabled": true,
      "mode": "local",
      "model": "qwen2.5-coder:14b",
      "api_url": "http://localhost:11434/v1",
      "handle_operations": {
        "memory_consolidation": true,
        "session_summary": true,
        "precompute_context": true
      }
    }
  }
}
```

**Supported backends:** Ollama, LM Studio, llama.cpp, any OpenAI-compatible API.

**Recommended models:**
| Model | Size | Notes |
|-------|------|-------|
| `qwen2.5-coder:14b` | ~9GB | Best balance for 8GB VRAM |
| `qwen2.5-coder:32b` | ~20GB | Best quality, needs 12GB+ VRAM |
| `deepseek-coder-v2:16b` | ~10GB | Fast, MoE architecture |

### Sensitive Info Filter

Automatically detects and redacts sensitive information before saving memories:

- **API keys** — OpenAI, Anthropic, AWS, GitHub, Stripe, etc.
- **Phone numbers** — international formats
- **Secrets** — passwords, tokens, private keys, JWTs
- **PII** — names, emails, addresses
- **High-entropy strings** — random strings likely to be secrets

Configure in `~/.succ/config.json`:

```json
{
  "sensitive_filter_enabled": true,
  "sensitive_auto_redact": false
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `sensitive_filter_enabled` | `true` | Enable detection |
| `sensitive_auto_redact` | `false` | Auto-redact without prompting |

### Quality Scoring

Memories are scored for quality to filter noise:

- **Local (default)** — ONNX zero-shot classification, no API needed
- **Custom** — Ollama, LM Studio, llama.cpp
- **OpenRouter** — Cloud API

Configure in `~/.succ/config.json`:

```json
{
  "quality_scoring_enabled": true,
  "quality_scoring_mode": "local",
  "quality_scoring_threshold": 0.3
}
```

Scoring factors: specificity, clarity, relevance, uniqueness.

### Token Savings Tracking

succ tracks how many tokens are saved by using RAG search instead of loading full files:

```bash
succ stats --tokens
```

Output:
```
## Token Savings

### Session Summaries
  Sessions: 47
  Transcript: 2.3M tokens
  Summary: 89K tokens
  Compression: 96.1%
  Saved: 2.2M tokens

### RAG Queries
  recall      : 234 queries, 45K returned, 1.2M saved
  search      : 156 queries, 32K returned, 890K saved
  search_code :  89 queries, 28K returned, 2.1M saved

### Total
  Queries: 479
  Tokens returned: 105K
  Tokens saved: 4.2M
```

**How it works:**
- For each search/recall, tracks tokens in returned chunks vs full source files
- For session summaries, tracks transcript tokens vs compressed summary
- Uses Anthropic's recommended 3.5 chars/token heuristic

MCP tool: `succ_stats`

### Auto-Retention Policies

succ automatically manages memory lifecycle with decay-based retention:

```bash
succ retention                   # Show retention stats
succ retention --dry-run         # Preview what would be deleted
succ retention --apply           # Actually delete low-score memories
```

**How it works:**

Effective score formula:
```
effective_score = quality_score × recency_factor × access_boost

recency_factor = 1 / (1 + decay_rate × days_since_creation)
access_boost = min(1 + access_weight × access_count, max_boost)
```

- **Quality score** — from quality scoring system (0-1)
- **Recency factor** — newer memories score higher, decay over time
- **Access boost** — frequently recalled memories are preserved

Retention tiers:
- `keep`: effective_score ≥ 0.3 (kept)
- `warn`: effective_score 0.15-0.3 (approaching deletion)
- `delete`: effective_score < 0.15 (removed on --apply)

Configure in `.succ/config.json`:
```json
{
  "retention": {
    "decay_rate": 0.01,
    "access_weight": 0.1,
    "keep_threshold": 0.3,
    "delete_threshold": 0.15
  }
}
```

## Memory System

succ provides two types of memory:

### Local Memory (per-project)
- Stored in `.succ/succ.db`
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

The soul document (`.succ/soul.md`) defines who the AI is in your collaboration:

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

## Next Session Context

When idle reflections run, succ generates `.succ/next-session-context.md` — a briefing for the next session containing:

- **Session summary** — key points from the last conversation
- **Suggested focus** — what to work on next
- **Relevant memories** — recent decisions, learnings, errors

This file is automatically loaded by the session-start hook, giving Claude context about previous work.

## Architecture

```
your-project/
├── .claude/
│   └── settings.json    # Claude Code hooks config
└── .succ/
    ├── brain/           # Obsidian-compatible vault
    ├── hooks/           # Hook scripts
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
| Hosting | Cloud | **Local only** |
| Privacy | Cloud by default | **Everything local** |
| Cost | Free tier, then $19-399/mo | **Free forever** |
| Setup | Account + API key | **`npm i -g succ && succ init`** |
| MCP integration | Yes | Yes |
| Knowledge graph | Via API | **Obsidian-compatible vault** |
| Code search | Via API | **Local semantic search** |
| Local LLM | No | **Ollama, llama.cpp, LM Studio** |
| Watch mode | No | **Auto-reindex on changes** |
| Daemon mode | No | **Continuous background analysis** |
| Soul document | No | **AI personality customization** |
| Idle reflections | No | **AI insights during idle** |
| Sensitive filter | Via API | **Local detection + redaction** |
| Quality scoring | Via API | **Local ONNX classification** |
| Session context | No | **Auto-generated briefings** |
| Cross-project memory | Cloud sync | **Local global DB** |
| Git-friendly | No | **Brain vault is markdown** |
| Open source | Partial (MCP server) | **Fully open source** |

## License

MIT
