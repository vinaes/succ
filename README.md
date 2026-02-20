<p align="center">
  <img src="https://img.shields.io/badge/●%20succ-semantic%20memory-3fb950?style=for-the-badge&labelColor=0d1117" alt="succ">
  <br/><br/>
  <em>Semantic Understanding for Code Contexts</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@vinaes/succ"><img src="https://img.shields.io/npm/v/@vinaes/succ?style=flat-square&color=3fb950" alt="npm"></a>
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

> Persistent semantic memory for any MCP-compatible AI editor. Remember decisions, learn from mistakes, never lose context.

### Works with

| Editor | Setup |
|--------|-------|
| **Claude Code** | `succ init` (auto-configured) |
| **Cursor** | `succ setup cursor` |
| **Windsurf** | `succ setup windsurf` |
| **Continue.dev** | `succ setup continue` |
| **Codex** | `succ setup codex`, then always launch via `succ codex` |

See [Editor Guides](docs/editors/index.md) for detailed setup.

## Quick Start

```bash
npm install -g @vinaes/succ
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
| **Hybrid Search** | Semantic embeddings + BM25 keyword matching with AST symbol boost |
| **AST Code Indexing** | Tree-sitter parsing for 21 languages — 13 with full symbol extraction, 8 grammar-only (Swift, Scala, Dart, Bash, Lua, Elixir, Haskell, SQL) |
| **Brain Vault** | Obsidian-compatible markdown knowledge base |
| **Persistent Memory** | Decisions, learnings, patterns across sessions |
| **Cross-Project** | Global memories shared between all projects |
| **Knowledge Graph** | Link memories, LLM-enriched relations, community detection, centrality |
| **MCP Native** | 14 consolidated tools — Claude uses succ tools directly |
| **Web Search** | Real-time web search via Perplexity Sonar (quick, quality, deep research) |
| **Skill Suggestions** | LLM-powered command discovery (opt-in, disabled by default) |
| **Web Fetch** | Fetch any URL as clean Markdown via md.succ.ai (Readability + Playwright) |
| **Working Memory** | Priority scoring, validity filtering, diversity, pinned memories |
| **Dynamic Hook Rules** | Save memories that auto-fire as pre-tool rules — inject context, block, or ask confirmation |
| **File-Linked Memories** | Link memories to files; auto-recalled when editing those files |
| **Dead-End Tracking** | Record failed approaches to prevent retrying |
| **Debug Sessions** | Structured debugging with hypothesis testing, 13-language instrumentation |
| **PRD Pipeline** | Generate PRDs, parse into tasks, execute with quality gates |
| **Team Mode** | Parallel task execution with git worktrees |
| **Multi-Backend Storage** | SQLite, PostgreSQL, Qdrant — scale from laptop to cloud |

<details>
<summary>All features</summary>

- **AST Code Indexing** — Tree-sitter parsing for 21 languages (13 with full symbol extraction + 8 grammar-only); symbol-aware BM25 tokenization boosts function/class names in search results
- **Web Search** — Real-time search via Perplexity Sonar through OpenRouter (quick $1/MTok, quality $3-15/MTok, deep research); search history tracking with cost auditing
- **PRD Pipeline** — Generate PRDs from feature descriptions, parse into executable tasks, run with Claude Code agent, export workflow to Obsidian (Mermaid Gantt + dependency DAG)
- **Team Mode** — Parallel task execution using git worktrees; each worker gets an isolated checkout, results merge via cherry-pick
- **Quality Gates** — Auto-detected (TypeScript, Go, Python, Rust) or custom; run after each task to verify code quality
- **Graph Enrichment** — LLM-classified relations (implements, leads_to, contradicts...), contextual proximity, Label Propagation communities, degree centrality with recall boost
- **Dead-End Tracking** — Record failed approaches; auto-boosted in recall to prevent retrying
- **AGENTS.md Auto-Export** — Auto-generate editor instructions from decisions, patterns, dead-ends
- **Learning Delta** — Track knowledge growth per session (memories added, types, quality)
- **Confidence Retention** — Time-decay scoring with auto-cleanup of low-value memories
- **Safe Consolidation** — Soft-delete with undo support; no data loss on merge
- **Skill Discovery** — Auto-suggest relevant skills based on user prompt (opt-in, disabled by default)
- **Skyll Integration** — Access community skills from [Skyll registry](https://skyll.app) (requires skills.enabled = true)
- **Soul Document** — Define AI personality and values
- **Dynamic Hook Rules** — Memories tagged `hook-rule` auto-fire before matching tool calls; filter by `tool:{Name}` and `match:{regex}` tags; `error` type blocks, `pattern` asks confirmation, others inject as context
- **File-Linked Memories** — Attach memories to files via `files` parameter; pre-tool hook auto-recalls related memories when editing those files
- **Auto-Hooks** — Context injection at session start/end
- **Idle Reflections** — AI generates insights during idle time
- **Session Context** — Auto-generated briefings for next session
- **Sensitive Filter** — Detect and redact PII, API keys, secrets
- **Quality Scoring** — Local ONNX classification to filter noise
- **Token Savings** — Track RAG efficiency vs full files
- **Temporal Awareness** — Time decay, validity periods, point-in-time queries
- **Unified Daemon** — Single background process for watch, analyze, idle tracking
- **Watch Mode** — Auto-reindex on file changes via @parcel/watcher
- **Fast Analyze** — `--fast` mode with fewer agents and smaller context for quick onboarding
- **Incremental Analyze** — Git-based change detection, skip unchanged agents
- **Local LLM** — Ollama, LM Studio, llama.cpp support
- **Sleep Agent** — Offload heavy operations to local LLM
- **Checkpoints** — Backup and restore full succ state
- **AI-Readiness Score** — Measure project readiness for AI collaboration
- **Multiple LLM Backends** — Local (Ollama), OpenRouter, or Claude CLI
- **Storage Backends** — SQLite (default), PostgreSQL + pgvector, Qdrant
- **Data Migration** — Export/import JSON, migrate between backends

</details>

## Claude Code Agents

succ ships with 20 specialized agents in `.claude/agents/` that run as subagents inside Claude Code:

| Agent | What it does |
|-------|-------------|
| `succ-explore` | Codebase exploration powered by semantic search |
| `succ-plan` | TDD-enforced implementation planning with red-green-refactor cycles |
| `succ-code-reviewer` | Full code review with OWASP Top 10 checklist — works with any language |
| `succ-diff-reviewer` | Fast pre-commit diff review for security, bugs, and regressions |
| `succ-deep-search` | Cross-search memories, brain vault, and code |
| `succ-memory-curator` | Consolidate, deduplicate, and clean up memories |
| `succ-memory-health-monitor` | Detect decayed, stale, or low-quality memories |
| `succ-pattern-detective` | Surface recurring patterns and anti-patterns from sessions |
| `succ-session-handoff-orchestrator` | Extract summary and briefing at session end |
| `succ-session-reviewer` | Review past sessions, extract missed learnings |
| `succ-decision-auditor` | Find contradictions and reversals in architectural decisions |
| `succ-knowledge-indexer` | Index documentation and code into the knowledge base |
| `succ-knowledge-mapper` | Maintain knowledge graph, find orphaned memories |
| `succ-checkpoint-manager` | Create and manage state backups |
| `succ-context-optimizer` | Optimize what gets preloaded at session start |
| `succ-quality-improvement-coach` | Analyze memory quality, suggest improvements |
| `succ-readiness-improver` | Actionable steps to improve AI-readiness score |
| `succ-general` | General-purpose agent with semantic search, web search, and all tools |
| `succ-debug` | Structured debugging — hypothesize, instrument, reproduce, fix with dead-end tracking |
| `succ-style-tracker` | Track communication style changes, update soul.md and brain vault |

Agents are auto-discovered by Claude Code from `.claude/agents/` and can be launched via the Task tool with `subagent_type`.

## Commands

| Command | Description |
|---------|-------------|
| `succ init` | Interactive setup wizard |
| `succ setup <editor>` | Configure MCP for any editor |
| `succ codex-chat` | Launch Codex chat with succ briefing/hooks |
| `succ analyze` | Generate brain vault with Claude agents |
| `succ index [path]` | Index files for semantic search |
| `succ search <query>` | Semantic search in brain vault |
| `succ remember <content>` | Save to memory |
| `succ memories` | List and search memories |
| `succ watch` | Watch for changes and auto-reindex |
| `succ daemon <action>` | Manage unified daemon |
| `succ prd generate` | Generate PRD from feature description |
| `succ prd run` | Execute PRD tasks with quality gates |
| `succ status` | Show index statistics |

<details>
<summary>All commands</summary>

| Command | Description |
|---------|-------------|
| `succ index-code [path]` | Index source code (AST chunking via tree-sitter) |
| `succ index --memories` | Re-embed all memories with current embedding model |
| `succ reindex` | Detect and fix stale/deleted index entries |
| `succ chat <query>` | RAG chat with context |
| `succ train-bpe` | Train BPE vocabulary from indexed code |
| `succ forget` | Delete memories |
| `succ graph <action>` | Knowledge graph: stats, auto-link, enrich, proximity, communities, centrality |
| `succ consolidate` | Merge duplicate memories (soft-delete with undo) |
| `succ agents-md` | Generate .claude/AGENTS.md from memories |
| `succ progress` | Show learning delta history |
| `succ retention` | Memory retention analysis and cleanup |
| `succ soul` | Generate personalized soul.md |
| `succ config` | Interactive configuration |
| `succ stats` | Show token savings statistics |
| `succ checkpoint <action>` | Create, restore, or list checkpoints |
| `succ score` | Show AI-readiness score |
| `succ prd parse <file>` | Parse PRD markdown into tasks |
| `succ prd list` | List all PRDs |
| `succ prd status [id]` | Show PRD status and tasks |
| `succ prd archive [id]` | Archive a PRD |
| `succ prd export [id]` | Export PRD workflow to Obsidian (Mermaid diagrams) |
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
succ analyze --fast      # Fast mode (fewer agents, smaller context)
succ analyze --force     # Force full re-analysis (skip incremental)
succ analyze --local     # Use local LLM (Ollama, LM Studio)
succ analyze --openrouter # Use OpenRouter API
succ analyze --background # Run in background
```

Generates brain vault structure:

```
.succ/brain/
├── CLAUDE.md              # Navigation hub
├── project/               # Project knowledge
│   ├── technical/         # Architecture, API, Conventions
│   ├── systems/           # Core systems/modules
│   ├── strategy/          # Project goals
│   └── features/          # Implemented features
├── knowledge/             # Research notes
└── archive/               # Old/superseded
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

### succ prd

```bash
succ prd generate "Add JWT authentication"   # Generate PRD + parse tasks
succ prd run                                  # Execute sequentially (default)
succ prd run --mode team                      # Execute in parallel (git worktrees)
succ prd run --mode team --concurrency 5      # Parallel with 5 workers
succ prd run --resume                         # Resume interrupted run
succ prd run --dry-run                        # Preview execution plan
succ prd status                               # Show latest PRD status
succ prd list                                 # List all PRDs
succ prd export                               # Export latest PRD to Obsidian
succ prd export --all                         # Export all PRDs
succ prd export prd_abc123                    # Export specific PRD
```

Team mode runs independent tasks in parallel using git worktrees for isolation. Each worker gets its own checkout; results merge via cherry-pick. Quality gates (typecheck, test, lint, build) run automatically after each task.

Export generates Obsidian-compatible markdown with Mermaid diagrams (Gantt timeline, dependency DAG), per-task detail pages with gate results, and wiki-links between pages. Output goes to `.succ/brain/prd/`.

## Configuration

No API key required. Uses local embeddings by default.

```json
{
  "llm": {
    "embeddings": {
      "mode": "local",
      "model": "Xenova/all-MiniLM-L6-v2"
    }
  },
  "chunk_size": 500,
  "chunk_overlap": 50
}
```

<details>
<summary>Embedding modes</summary>

**Local (default):**
```json
{
  "llm": { "embeddings": { "mode": "local" } }
}
```

**Ollama (unified namespace):**
```json
{
  "llm": {
    "embeddings": {
      "mode": "api",
      "model": "nomic-embed-text",
      "api_url": "http://localhost:11434/v1/embeddings"
    }
  }
}
```

**OpenRouter:**
```json
{
  "embedding_mode": "openrouter",
  "openrouter_api_key": "sk-or-..."
}
```

**MRL dimension override (Matryoshka models):**
```json
{
  "llm": {
    "embeddings": {
      "mode": "api",
      "model": "nomic-embed-text-v1.5",
      "api_url": "http://localhost:11434/v1/embeddings",
      "dimensions": 256
    }
  }
}
```

</details>

<details>
<summary>GPU acceleration</summary>

succ uses native ONNX Runtime for embedding inference with automatic GPU detection:

| Platform | Backend | GPUs |
|----------|---------|------|
| Windows | DirectML | AMD, Intel, NVIDIA |
| Linux | CUDA | NVIDIA |
| macOS | CoreML | Apple Silicon |
| Fallback | CPU | Any |

GPU is enabled by default. No manual configuration needed — the best available backend is auto-detected.

```json
{
  "gpu_enabled": true,
  "gpu_device": "directml"
}
```

Set `gpu_device` to override auto-detection: `cuda`, `directml`, `coreml`, or `cpu`.

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
<summary>Pre-commit review</summary>

Automatically run the `succ-diff-reviewer` agent before every git commit to catch security issues, bugs, and regressions:

```json
{
  "preCommitReview": true
}
```

When enabled, Claude will run a diff review before each commit. Critical findings block the commit; high findings trigger a warning.

Disabled by default. Set via `succ_config(action="set", key="preCommitReview", value="true")`.

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
    "type": "local",
    "model": "qwen2.5:7b",
    "local": {
      "endpoint": "http://localhost:11434/v1/chat/completions"
    },
    "openrouter": {
      "model": "anthropic/claude-3-haiku"
    }
  }
}
```

| Key | Values | Default | Description |
|-----|--------|---------|-------------|
| `llm.type` | `local` / `openrouter` / `claude` | `local` | LLM provider |
| `llm.model` | string | per-type | Model name for the active type |
| `llm.transport` | `process` / `ws` / `http` | auto | How to talk to the backend |

**Transport** auto-selects based on type: `claude` uses `process` (or `ws` for persistent WebSocket), `local`/`openrouter` use `http`.

**WebSocket transport** (`transport: "ws"`) keeps a persistent connection to Claude CLI, avoiding process spawn overhead on repeated calls:

```json
{
  "llm": {
    "type": "claude",
    "model": "sonnet",
    "transport": "ws"
  }
}
```

**Per-backend model overrides** for the fallback chain:

```json
{
  "llm": {
    "type": "claude",
    "model": "sonnet",
    "transport": "ws",
    "local": { "endpoint": "http://localhost:11434/v1/chat/completions", "model": "qwen2.5:7b" },
    "openrouter": { "model": "anthropic/claude-3-haiku" }
  }
}
```

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

Combines semantic embeddings with BM25 keyword search. Code search includes AST symbol boost, regex post-filtering, and symbol type filtering (function, method, class, interface, type_alias). Three output modes: `full` (code blocks), `lean` (file+lines), `signatures` (symbol names only).

| Aspect | Documents | Code |
|--------|-----------|------|
| Tokenizer | Markdown-aware + stemming | Naming convention splitter + AST symbol boost |
| Stemming | Yes | No |
| Stop words | Filtered | Kept |
| Segmentation | Standard | Ronin + BPE |
| Symbol metadata | N/A | function, class, interface names via tree-sitter |

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
- [PRD Pipeline](docs/prd.md) — Generate, execute, and verify tasks with quality gates
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
