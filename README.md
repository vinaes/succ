<p align="center">
  <img src="https://img.shields.io/badge/●%20succ-semantic%20memory-3fb950?style=for-the-badge&labelColor=0d1117" alt="succ">
  <br/><br/>
  <em>Semantic Understanding for Claude Code</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/succ"><img src="https://img.shields.io/badge/npm-1.1.11-3fb950?style=flat-square" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-FSL--1.1-blue?style=flat-square" alt="license"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#features">Features</a> •
  <a href="#commands">Commands</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#documentation">Docs</a>
</p>

---

> Local memory system that adds persistent, semantic memory to any Claude Code project.

## Quick Start

```bash
npm install -g succ
```

```bash
cd your-project
succ init
succ index
succ index-code
succ analyze
```

> **That's it.** Claude Code now has persistent memory for your project.

## Features

| Feature | Description |
|---------|-------------|
| **Hybrid Search** | Semantic embeddings + BM25 keyword matching |
| **Brain Vault** | Obsidian-compatible markdown knowledge base |
| **Persistent Memory** | Decisions, learnings, patterns across sessions |
| **Cross-Project** | Global memories shared between all projects |
| **Knowledge Graph** | Link memories, auto-detect relationships |
| **MCP Native** | Claude uses succ tools directly |
| **Skill Suggestions** | LLM-powered command discovery (opt-in, disabled by default) |
| **Multi-Backend Storage** | SQLite, PostgreSQL, Qdrant — scale from laptop to cloud |

<details>
<summary>All features</summary>

- **Skill Discovery** — Auto-suggest relevant skills based on user prompt (opt-in, disabled by default)
- **Skyll Integration** — Access community skills from [Skyll registry](https://skyll.app) (requires skills.enabled = true)
- **Soul Document** — Define AI personality and values
- **Auto-Hooks** — Context injection at session start/end
- **Idle Reflections** — AI generates insights during idle time
- **Session Context** — Auto-generated briefings for next session
- **Sensitive Filter** — Detect and redact PII, API keys, secrets
- **Quality Scoring** — Local ONNX classification to filter noise
- **Token Savings** — Track RAG efficiency vs full files
- **Temporal Awareness** — Time decay, validity periods, point-in-time queries
- **Unified Daemon** — Single background process for watch, analyze, idle tracking
- **Watch Mode** — Auto-reindex on file changes via @parcel/watcher
- **Local LLM** — Ollama, LM Studio, llama.cpp support
- **Sleep Agent** — Offload heavy operations to local LLM
- **Checkpoints** — Backup and restore full succ state
- **AI-Readiness Score** — Measure project readiness for AI collaboration
- **Multiple LLM Backends** — Local (Ollama), OpenRouter, or Claude CLI
- **Storage Backends** — SQLite (default), PostgreSQL + pgvector, Qdrant
- **Data Migration** — Export/import JSON, migrate between backends

</details>

## Commands

| Command | Description |
|---------|-------------|
| `succ init` | Interactive setup wizard |
| `succ analyze` | Generate brain vault with Claude agents |
| `succ index [path]` | Index files for semantic search |
| `succ search <query>` | Semantic search in brain vault |
| `succ remember <content>` | Save to memory |
| `succ memories` | List and search memories |
| `succ watch` | Watch for changes and auto-reindex |
| `succ daemon <action>` | Manage unified daemon |
| `succ status` | Show index statistics |

<details>
<summary>All commands</summary>

| Command | Description |
|---------|-------------|
| `succ index-code [path]` | Index source code |
| `succ chat <query>` | RAG chat with context |
| `succ train-bpe` | Train BPE vocabulary from indexed code |
| `succ forget` | Delete memories |
| `succ graph <action>` | Knowledge graph operations |
| `succ consolidate` | Merge duplicate memories |
| `succ soul` | Generate personalized soul.md |
| `succ config` | Interactive configuration |
| `succ stats` | Show token savings statistics |
| `succ retention` | Memory retention analysis and cleanup |
| `succ checkpoint <action>` | Create, restore, or list checkpoints |
| `succ score` | Show AI-readiness score |
| `succ clear` | Clear index and/or memories |
| `succ benchmark` | Run performance benchmarks |
| `succ migrate` | Migrate data between storage backends |

</details>

### succ init

```bash
succ init                # Interactive mode
succ init --yes          # Non-interactive (defaults)
succ init --force        # Reinitialize existing project
```

Creates `.succ/` structure, configures MCP server, sets up hooks.

### succ analyze

```bash
succ analyze             # Run via Claude CLI (recommended)
succ analyze --local     # Use local LLM (Ollama, LM Studio)
succ analyze --openrouter # Use OpenRouter API
succ analyze --background # Run in background
```

Generates brain vault structure:

```
.succ/brain/
├── CLAUDE.md              # Navigation hub
├── 01_Projects/{project}/
│   ├── Technical/         # Architecture, API, Conventions
│   ├── Systems/           # Core systems/modules
│   ├── Strategy/          # Project goals
│   └── Features/          # Implemented features
├── 02_Knowledge/          # Research notes
└── 03_Archive/            # Old/superseded
```

### succ watch

```bash
succ watch               # Start watch service (via daemon)
succ watch --ignore-code # Watch only docs
succ watch --status      # Check watch service status
succ watch --stop        # Stop watch service
```

### succ daemon

```bash
succ daemon status       # Show daemon status
succ daemon sessions     # List active Claude Code sessions
succ daemon start        # Start daemon manually
succ daemon stop         # Stop daemon
succ daemon logs         # Show recent logs
```

## Configuration

No API key required. Uses local embeddings by default.

```json
{
  "embedding_mode": "local",
  "embedding_model": "Xenova/all-MiniLM-L6-v2",
  "chunk_size": 500,
  "chunk_overlap": 50
}
```

<details>
<summary>Embedding modes</summary>

**Local (default):**
```json
{
  "embedding_mode": "local",
  "embedding_model": "Xenova/all-MiniLM-L6-v2"
}
```

**OpenRouter:**
```json
{
  "embedding_mode": "openrouter",
  "embedding_model": "openai/text-embedding-3-small",
  "openrouter_api_key": "sk-or-..."
}
```

**Custom API:**
```json
{
  "embedding_mode": "custom",
  "embedding_api_url": "http://localhost:11434/v1/embeddings",
  "embedding_model": "nomic-embed-text",
  "embedding_dimensions": 768
}
```

</details>

<details>
<summary>Idle watcher</summary>

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

</details>

<details>
<summary>Sleep agent</summary>

Offload heavy operations to local LLM:

```json
{
  "idle_reflection": {
    "sleep_agent": {
      "enabled": true,
      "mode": "local",
      "model": "qwen2.5-coder:14b",
      "api_url": "http://localhost:11434/v1"
    }
  }
}
```

</details>

<details>
<summary>Storage backends</summary>

succ supports multiple storage backends for different deployment scenarios:

| Setup | Use Case | Requirements |
|-------|----------|--------------|
| SQLite + sqlite-vec | Local development (default) | None |
| PostgreSQL + pgvector | Production/cloud | PostgreSQL 15+ with pgvector |
| SQLite + Qdrant | Local + powerful vector search | Qdrant server |
| PostgreSQL + Qdrant | Full production scale | PostgreSQL + Qdrant |

**Example: PostgreSQL + pgvector**
```json
{
  "storage": {
    "backend": "postgresql",
    "postgresql": {
      "connection_string": "postgresql://user:pass@localhost:5432/succ"
    }
  }
}
```

**Example: PostgreSQL + Qdrant**
```json
{
  "storage": {
    "backend": "postgresql",
    "vector": "qdrant",
    "postgresql": { "connection_string": "postgresql://..." },
    "qdrant": { "url": "http://localhost:6333" }
  }
}
```

See [Storage Configuration](docs/configuration.md#storage-settings) for all options.

</details>

<details>
<summary>LLM Backend Configuration</summary>

succ supports multiple LLM backends for operations like analyze, idle reflection, and skill suggestions:

```json
{
  "llm": {
    "backend": "local",
    "model": "qwen2.5:7b",
    "local_endpoint": "http://localhost:11434/v1/chat/completions",
    "openrouter_model": "anthropic/claude-3-haiku"
  }
}
```

| Backend | Description | Requirements |
|---------|-------------|--------------|
| `local` | Ollama or OpenAI-compatible server (default) | Local server running |
| `openrouter` | OpenRouter API | `OPENROUTER_API_KEY` env var |
| `claude` | Claude Code CLI | Active Claude Code session |

> Claude backend usage

The claude backend integrates with an existing, locally running Claude Code session and is intended only for in-session developer assistance by the same user, including tasks such as file analysis, documentation, indexing, and session summarization.

It is not supported for unattended background processing, cloud deployments, or multi-user scenarios. For automated, long-running, or cloud workloads, use the local or openrouter backends instead.

</details>

<details>
<summary>Retention policies</summary>

```json
{
  "retention": {
    "enabled": true,
    "decay_rate": 0.01,
    "access_weight": 0.1,
    "keep_threshold": 0.3,
    "delete_threshold": 0.15
  }
}
```

</details>

## Hybrid Search

Combines semantic embeddings with BM25 keyword search.

| Aspect | Documents | Code |
|--------|-----------|------|
| Tokenizer | Markdown-aware + stemming | Naming convention splitter |
| Stemming | Yes | No |
| Stop words | Filtered | Kept |
| Segmentation | Standard | Ronin + BPE |

Code tokenizer handles all naming conventions:

| Convention | Example | Tokens |
|------------|---------|--------|
| camelCase | `getUserName` | get, user, name |
| PascalCase | `UserService` | user, service |
| snake_case | `get_user_name` | get, user, name |
| SCREAMING_SNAKE | `MAX_RETRY_COUNT` | max, retry, count |

## Memory System

**Local memory** — stored in `.succ/succ.db`, project-specific.

**Global memory** — stored in `~/.succ/global.db`, shared across projects.

```bash
succ remember "User prefers TypeScript" --global
succ memories --global
```

## Architecture

```
your-project/
├── .claude/
│   └── settings.json      # Claude Code hooks config
└── .succ/
    ├── brain/             # Obsidian-compatible vault
    ├── hooks/             # Hook scripts
    ├── config.json        # Project configuration
    ├── soul.md            # AI personality
    └── succ.db            # Vector database

~/.succ/
├── global.db              # Global memories
└── config.json            # Global configuration
```

## Documentation

- [Configuration Reference](docs/configuration.md) — All config options with examples
- [Storage Backends](docs/storage.md) — SQLite, PostgreSQL, Qdrant setup and benchmarks
- [Benchmarks](docs/benchmarks.md) — Performance and accuracy metrics
- [Temporal Awareness](docs/temporal.md) — Time decay, validity periods
- [Ollama Setup](docs/ollama.md) — Recommended local LLM setup
- [llama.cpp GPU](docs/llama-cpp.md) — GPU-accelerated embeddings
- [MCP Integration](docs/mcp.md) — Claude Code tools and resources
- [Troubleshooting](docs/troubleshooting.md) — Common issues and fixes
- [Development](docs/development.md) — Contributing and testing

## License

[FSL-1.1-Apache-2.0](LICENSE) — Free to use, modify, self-host. Commercial cloud hosting restricted until Apache 2.0 date.
