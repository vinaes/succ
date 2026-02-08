# succ Configuration Reference

Complete reference for all configuration options in succ.

## Configuration Files

succ reads configuration from multiple sources (in order of priority):

1. **Project config**: `.succ/config.json` (highest priority)
2. **Legacy project config**: `.claude/succ.json`
3. **Global config**: `~/.succ/config.json`
4. **Environment variables**: `OPENROUTER_API_KEY`

Project config overrides global config. You can view current effective config with:

```bash
succ config
```

---

## Quick Start Examples

### Minimal Local Setup (Default)

No config needed! succ works out of the box with local embeddings.

### OpenRouter Cloud Embeddings

```json
{
  "openrouter_api_key": "sk-or-...",
  "embedding_mode": "openrouter"
}
```

### Local LLM with Ollama

```json
{
  "embedding_mode": "custom",
  "embedding_api_url": "http://localhost:11434/v1/embeddings",
  "embedding_model": "nomic-embed-text",
  "llm": {
    "backend": "local",
    "model": "qwen2.5-coder:14b",
    "local_endpoint": "http://localhost:11434/v1/chat/completions"
  }
}
```

---

## Core Settings

### API Keys

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `openrouter_api_key` | string | - | OpenRouter API key for cloud services |

Can also be set via `OPENROUTER_API_KEY` environment variable.

---

## Embedding Settings

Controls how text is converted to vectors for semantic search.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `embedding_mode` | `"local"` \| `"openrouter"` \| `"custom"` | `"local"` | Embedding provider |
| `embedding_model` | string | Mode-dependent | Model name |
| `embedding_api_url` | string | - | API URL for custom mode |
| `embedding_api_key` | string | - | API key for custom endpoint |
| `embedding_batch_size` | number | 32 | Batch size for API calls |
| `embedding_dimensions` | number | - | Override embedding dimensions |

### Default Models by Mode

- **local**: `Xenova/all-MiniLM-L6-v2` (384 dimensions)
- **openrouter**: `openai/text-embedding-3-small`
- **custom**: `text-embedding-3-small`

### Examples

**Local (default, no API needed):**
```json
{
  "embedding_mode": "local"
}
```

**OpenRouter:**
```json
{
  "embedding_mode": "openrouter",
  "openrouter_api_key": "sk-or-..."
}
```

**Ollama:**
```json
{
  "embedding_mode": "custom",
  "embedding_api_url": "http://localhost:11434/v1/embeddings",
  "embedding_model": "nomic-embed-text"
}
```

**LM Studio:**
```json
{
  "embedding_mode": "custom",
  "embedding_api_url": "http://localhost:1234/v1/embeddings",
  "embedding_model": "text-embedding-nomic-embed-text-v1.5"
}
```

**llama.cpp:**
```json
{
  "embedding_mode": "custom",
  "embedding_api_url": "http://localhost:8080/v1/embeddings",
  "embedding_model": "nomic-embed-text-v1.5",
  "embedding_batch_size": 512
}
```

---

## Storage Settings

Controls which backend stores your data. succ supports multiple storage configurations:

- **SQLite + sqlite-vec** (default) — Zero setup, local development
- **PostgreSQL + pgvector** — Production deployments, cloud
- **SQLite + Qdrant** — Local with powerful vector search
- **PostgreSQL + Qdrant** — Enterprise scale

```json
{
  "storage": {
    "backend": "postgresql",
    "vector": "qdrant",
    "postgresql": {
      "connection_string": "postgresql://user:pass@localhost:5432/succ"
    },
    "qdrant": {
      "url": "http://localhost:6333"
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `storage.backend` | `"sqlite"` \| `"postgresql"` | `"sqlite"` | SQL backend |
| `storage.vector` | `"builtin"` \| `"qdrant"` | `"builtin"` | Vector backend |

### SQLite Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `storage.sqlite.path` | string | `.succ/succ.db` | Database path |
| `storage.sqlite.global_path` | string | `~/.succ/global.db` | Global db path |
| `storage.sqlite.wal_mode` | boolean | true | Enable WAL mode |
| `storage.sqlite.busy_timeout` | number | 5000 | Busy timeout (ms) |

### PostgreSQL Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `storage.postgresql.connection_string` | string | - | Full connection string |
| `storage.postgresql.host` | string | `localhost` | Database host |
| `storage.postgresql.port` | number | 5432 | Database port |
| `storage.postgresql.database` | string | `succ` | Database name |
| `storage.postgresql.user` | string | - | Username |
| `storage.postgresql.password` | string | - | Password |
| `storage.postgresql.ssl` | boolean | false | Enable SSL |
| `storage.postgresql.pool_size` | number | 10 | Connection pool size |

### Qdrant Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `storage.qdrant.url` | string | `http://localhost:6333` | Qdrant server URL |
| `storage.qdrant.api_key` | string | - | API key (for Qdrant Cloud) |
| `storage.qdrant.collection_prefix` | string | `succ_` | Collection name prefix |

### Examples

**Default (SQLite + sqlite-vec):**
```json
{}
```

**PostgreSQL + pgvector:**
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

**SQLite + Qdrant (powerful local vector search):**
```json
{
  "storage": {
    "backend": "sqlite",
    "vector": "qdrant",
    "qdrant": {
      "url": "http://localhost:6333"
    }
  }
}
```

**Full Production (PostgreSQL + Qdrant):**
```json
{
  "storage": {
    "backend": "postgresql",
    "vector": "qdrant",
    "postgresql": {
      "connection_string": "postgresql://user:pass@prod-db:5432/succ",
      "pool_size": 20,
      "ssl": true
    },
    "qdrant": {
      "url": "https://qdrant.example.com:6333",
      "api_key": "your-api-key",
      "collection_prefix": "prod_succ_"
    }
  }
}
```

See [Storage Backends](./storage.md) for detailed setup instructions and benchmarks.

---

## Chunking Settings

Controls how documents are split for indexing.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `chunk_size` | number | 500 | Max characters per chunk |
| `chunk_overlap` | number | 50 | Overlap between chunks |

---

## GPU Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `gpu_enabled` | boolean | true | Enable GPU acceleration |
| `gpu_device` | `"cuda"` \| `"directml"` \| `"webgpu"` \| `"cpu"` | auto | Preferred backend |

---

## LLM Backend Settings

Unified LLM configuration for all succ operations (analyze, idle reflection, skill suggestions, etc.).

> **Warning**: Using `claude` backend invokes Claude Code CLI programmatically. This may violate [Anthropic's Terms of Service](https://www.anthropic.com/legal/consumer-terms). Use at your own risk. We recommend `local` (Ollama) or `openrouter` backends for automated operations.

```json
{
  "llm": {
    "backend": "local",
    "model": "qwen2.5:7b",
    "local_endpoint": "http://localhost:11434/v1/chat/completions",
    "openrouter_model": "anthropic/claude-3-haiku",
    "max_tokens": 2000,
    "temperature": 0.3
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `llm.backend` | `"local"` \| `"openrouter"` \| `"claude"` | `"local"` | LLM provider |
| `llm.model` | string | `"qwen2.5:7b"` | Model for local backend |
| `llm.local_endpoint` | string | `"http://localhost:11434/v1/chat/completions"` | Ollama/local API URL |
| `llm.openrouter_model` | string | `"anthropic/claude-3-haiku"` | Model for OpenRouter |
| `llm.max_tokens` | number | 2000 | Max tokens per response |
| `llm.temperature` | number | 0.3 | Generation temperature |

### Backend Comparison

| Backend | Pros | Cons |
|---------|------|------|
| `local` | Free, private, no rate limits | Requires local GPU/CPU |
| `openrouter` | Many models, no local setup | Requires API key, costs |
| `claude` | High quality | May violate ToS, requires subscription |

### Fallback Chain

succ automatically tries backends in order if one fails:
1. Preferred backend (from config)
2. `local` (if available)
3. `openrouter` (if API key set)
4. `claude` (last resort)

---

## Analyze Settings

> **Note**: `succ analyze` now uses the unified `llm.*` configuration. Legacy `analyze_*` settings are deprecated.

The `succ analyze` command uses the unified LLM backend configured in `llm.*`. To customize analysis behavior, configure your LLM settings:

```json
{
  "llm": {
    "backend": "local",
    "model": "qwen2.5:7b",
    "local_endpoint": "http://localhost:11434/v1/chat/completions"
  }
}
```

---

## Quality Scoring Settings

Controls automatic quality scoring of memories.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `quality_scoring_enabled` | boolean | true | Enable quality scoring |
| `quality_scoring_mode` | `"local"` \| `"custom"` \| `"openrouter"` | `"local"` | Scoring method |
| `quality_scoring_model` | string | - | Model for LLM-based scoring |
| `quality_scoring_api_url` | string | - | API URL for custom mode |
| `quality_scoring_api_key` | string | - | API key for custom mode |
| `quality_scoring_threshold` | number | 0 | Min score to keep (0-1) |

### Example: Filter Low-Quality Memories

```json
{
  "quality_scoring_enabled": true,
  "quality_scoring_threshold": 0.4
}
```

---

## Sensitive Filter Settings

Controls detection and redaction of sensitive information.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sensitive_filter_enabled` | boolean | true | Enable detection |
| `sensitive_auto_redact` | boolean | false | Auto-redact without prompting |

---

## Knowledge Graph Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `graph_auto_link` | boolean | true | Auto-link similar memories |
| `graph_link_threshold` | number | 0.7 | Similarity threshold for linking |
| `graph_auto_export` | boolean | false | Auto-export on changes |
| `graph_export_format` | `"obsidian"` \| `"json"` | `"obsidian"` | Export format |
| `graph_export_path` | string | `.succ/brain/graph` | Custom export path |

### Example: Export to Obsidian

```json
{
  "graph_auto_export": true,
  "graph_export_format": "obsidian",
  "graph_export_path": "/path/to/obsidian/vault/succ"
}
```

---

## Remember & Consolidate Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `remember_extract_default` | boolean | true | Use LLM extraction by default |
| `consolidation_llm_default` | boolean | true | Use LLM merge by default |

---

## Commit Format Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `includeCoAuthoredBy` | boolean | true | Include commit guidelines in session-start |

Set to `false` to disable the `<commit-format>` block injection:

```json
{
  "includeCoAuthoredBy": false
}
```

---

## Quality Gates Settings

Controls quality gates for the PRD pipeline (`succ prd`). Gates run after each task to verify code quality. By default, succ auto-detects gates from project files (TypeScript, Node.js, Python, Go, Rust). Use this config to add custom gates, disable auto-detected ones, or configure per-subdirectory gates for monorepos.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `quality_gates.auto_detect` | boolean | `true` | Auto-detect gates from project files |
| `quality_gates.gates` | GateConfig[] | `[]` | Custom gates to add at root level |
| `quality_gates.disable` | string[] | `[]` | Gate types to remove from auto-detection |
| `quality_gates.subdirs` | Record | `{}` | Per-subdirectory gate overrides |

### GateConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | string | - | Gate type: `typecheck`, `test`, `lint`, `build`, `custom` |
| `command` | string | - | Shell command to run |
| `required` | boolean | `true` | If false, failure doesn't block task completion |
| `timeout_ms` | number | `120000` | Max execution time in milliseconds |

### Auto-Detected Languages

When `auto_detect` is `true` (default), succ scans for:

| Config File | Language | Gates |
|-------------|----------|-------|
| `tsconfig.json` | TypeScript | `npx tsc --noEmit` |
| `package.json` | Node.js | test script from package.json |
| `go.mod` | Go | `go build`, `go test`, `go vet`, optional `golangci-lint` |
| `pyproject.toml` / `setup.py` | Python | `pytest` |
| `Cargo.toml` | Rust | `cargo build`, `cargo test` |

### Examples

**Add gates for unsupported language (Java/Maven):**
```json
{
  "quality_gates": {
    "gates": [
      { "type": "build", "command": "mvn compile" },
      { "type": "test", "command": "mvn test", "timeout_ms": 300000 }
    ]
  }
}
```

**Disable auto-detected typecheck:**
```json
{
  "quality_gates": {
    "disable": ["typecheck"]
  }
}
```

**Only use custom gates (no auto-detection):**
```json
{
  "quality_gates": {
    "auto_detect": false,
    "gates": [
      { "type": "build", "command": "dotnet build" },
      { "type": "test", "command": "dotnet test" },
      { "type": "lint", "command": "dotnet format --verify-no-changes", "required": false }
    ]
  }
}
```

**Monorepo with per-subdirectory gates:**
```json
{
  "quality_gates": {
    "auto_detect": true,
    "subdirs": {
      "backend": {
        "gates": [
          { "type": "build", "command": "mvn compile" },
          { "type": "test", "command": "mvn test" }
        ]
      },
      "frontend": {
        "disable": ["typecheck"],
        "gates": [
          { "type": "lint", "command": "eslint .", "required": false }
        ]
      }
    }
  }
}
```

Subdirectory commands are automatically prefixed with `cd "<subdir>" &&`.

**Full monorepo example (Go + Next.js + Python ML service):**
```json
{
  "quality_gates": {
    "subdirs": {
      "api": {
        "gates": [
          { "type": "build", "command": "go build ./..." },
          { "type": "test", "command": "go test ./..." },
          { "type": "lint", "command": "golangci-lint run", "required": false }
        ]
      },
      "web": {
        "gates": [
          { "type": "typecheck", "command": "npx tsc --noEmit" },
          { "type": "test", "command": "npx vitest run" },
          { "type": "lint", "command": "npx next lint", "required": false }
        ]
      },
      "ml": {
        "gates": [
          { "type": "test", "command": "pytest", "timeout_ms": 600000 },
          { "type": "lint", "command": "ruff check .", "required": false }
        ]
      }
    }
  }
}
```

> **Note**: The CLI `--gates` flag overrides all config when specified: `succ prd generate "..." --gates "test:npm test,lint:eslint ."`

---

## PRD Pipeline Settings

The PRD (Product Requirements Document) pipeline generates tasks from feature descriptions and executes them with Claude Code agent. Tasks run with branch isolation, quality gates, and auto-commit.

### CLI Reference

```bash
# Generate
succ prd generate "Add JWT authentication"
succ prd generate "..." --mode team              # Team mode (parallel)
succ prd generate "..." --gates "test:npm test"   # Custom gates
succ prd generate "..." --model claude-sonnet     # LLM override
succ prd generate "..." --auto-parse              # Auto-parse into tasks

# Parse (if not auto-parsed)
succ prd parse <file-or-prd-id>
succ prd parse <file> --prd-id prd_xxx            # Add to existing PRD
succ prd parse <file> --dry-run                   # Preview without saving

# Run
succ prd run [prd-id]                             # Sequential (default)
succ prd run --mode team                          # Parallel with git worktrees
succ prd run --mode team --concurrency 5          # 5 parallel workers
succ prd run --resume                             # Resume interrupted run
succ prd run --resume --force                     # Force resume (skip lock check)
succ prd run --task task_001                      # Run single task
succ prd run --dry-run                            # Preview execution plan
succ prd run --no-branch                          # Skip branch isolation
succ prd run --model claude-sonnet                # Model override
succ prd run --max-iterations 5                   # Max full-PRD retries

# Management
succ prd list                                     # List all PRDs
succ prd list --all                               # Include archived
succ prd status [prd-id]                          # Show status + tasks
succ prd status --verbose                         # Detailed task info
succ prd status --json                            # JSON output
succ prd archive [prd-id]                         # Archive PRD
```

### MCP Tools

The same operations are available via MCP:

| Tool | Description |
|------|-------------|
| `succ_prd_generate` | Generate PRD from description |
| `succ_prd_list` | List all PRDs |
| `succ_prd_status` | Show PRD and task status |
| `succ_prd_run` | Execute or resume a PRD |

### Execution Modes

| Mode | Description |
|------|-------------|
| `loop` | Sequential execution (default). Tasks run one at a time in topological order. |
| `team` | Parallel execution with git worktrees. Independent tasks run concurrently, each in an isolated checkout. Results merge via cherry-pick. |

**Team mode details:**
- Each worker gets a detached git worktree under `.succ/worktrees/`
- `node_modules` is symlinked (junction on Windows) so tools like `tsc`/`vitest` work
- Quality gates run in the worktree before merging
- Cherry-pick merges changes back to the PRD branch
- On conflict: task retries with updated context
- Concurrency defaults to 3 workers

### Branch Isolation

By default, `succ prd run` creates a `prd/{id}` branch, executes all tasks there, then returns to the original branch. Use `--no-branch` to execute in the current branch.

---

## Daemon Settings

Controls the background daemon service.

```json
{
  "daemon": {
    "enabled": true,
    "port_range_start": 37842,
    "watch": {
      "auto_start": false,
      "patterns": ["**/*.md"],
      "include_code": false,
      "debounce_ms": 500
    },
    "analyze": {
      "auto_start": false,
      "interval_minutes": 30
    }
  }
}
```

> **Note**: Daemon analyze uses the unified `llm.*` configuration.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `daemon.enabled` | boolean | true | Enable daemon |
| `daemon.port_range_start` | number | 37842 | Starting port |
| `daemon.watch.auto_start` | boolean | false | Auto-start file watcher |
| `daemon.watch.patterns` | string[] | `["**/*.md"]` | Watch patterns |
| `daemon.watch.include_code` | boolean | false | Watch code files |
| `daemon.watch.debounce_ms` | number | 500 | Debounce interval |
| `daemon.analyze.auto_start` | boolean | false | Auto-start analyzer |
| `daemon.analyze.interval_minutes` | number | 30 | Analysis interval |

---

## Idle Watcher Settings

Triggers reflections after periods of inactivity.

```json
{
  "idle_watcher": {
    "enabled": true,
    "idle_minutes": 2,
    "check_interval": 30,
    "min_conversation_length": 5,
    "reflection_cooldown_minutes": 30
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `idle_watcher.enabled` | boolean | true | Enable idle detection |
| `idle_watcher.idle_minutes` | number | 2 | Minutes before reflection |
| `idle_watcher.check_interval` | number | 30 | Seconds between checks |
| `idle_watcher.min_conversation_length` | number | 5 | Min entries to trigger |
| `idle_watcher.reflection_cooldown_minutes` | number | 30 | Cooldown between reflections |

---

## Idle Reflection Settings

Controls what happens during idle reflection.

> **Note**: Idle reflection uses the unified `llm.*` configuration (or `sleep_agent.*` if enabled).

```json
{
  "idle_reflection": {
    "enabled": true,
    "operations": {
      "memory_consolidation": true,
      "graph_refinement": true,
      "session_summary": true,
      "precompute_context": true,
      "write_reflection": true,
      "retention_cleanup": true
    },
    "thresholds": {
      "similarity_for_merge": 0.85,
      "auto_link_threshold": 0.75,
      "min_quality_for_summary": 0.5
    },
    "max_memories_to_process": 50,
    "timeout_seconds": 25
  }
}
```

### Operations

| Operation | Default | Description |
|-----------|---------|-------------|
| `memory_consolidation` | true | Merge similar memories |
| `graph_refinement` | true | Auto-link by similarity |
| `session_summary` | true | Extract facts from session |
| `precompute_context` | true | Prepare next session context |
| `write_reflection` | true | Write reflection text |
| `retention_cleanup` | true | Delete decayed memories |

### Sleep Agent (Secondary LLM)

Use a separate LLM for background operations (idle reflection, memory consolidation, precompute context). This allows using a premium model for interactive work while offloading background tasks to a free/local model.

```json
{
  "llm": {
    "backend": "claude",
    "model": "sonnet"
  },
  "sleep_agent": {
    "enabled": true,
    "backend": "local",
    "model": "qwen2.5:7b",
    "local_endpoint": "http://localhost:11434/v1/chat/completions"
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sleep_agent.enabled` | boolean | false | Enable sleep agent |
| `sleep_agent.backend` | `"local"` \| `"openrouter"` | `"local"` | Backend for background ops |
| `sleep_agent.model` | string | from `llm.*` | Model name |
| `sleep_agent.local_endpoint` | string | from `llm.*` | Local LLM endpoint |
| `sleep_agent.max_tokens` | number | from `llm.*` | Max tokens |
| `sleep_agent.temperature` | number | from `llm.*` | Temperature |

**Use cases:**
- Primary: Claude CLI + Sleep: Ollama (free background processing)
- Primary: OpenRouter (fast) + Sleep: Local Ollama (no rate limits)

---

## Retention Policy Settings

Automatic memory cleanup based on decay.

```json
{
  "retention": {
    "enabled": true,
    "decay_rate": 0.01,
    "access_weight": 0.1,
    "max_access_boost": 2.0,
    "keep_threshold": 0.3,
    "delete_threshold": 0.15,
    "default_quality_score": 0.5,
    "auto_cleanup_interval_days": 7
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `retention.enabled` | boolean | false | Enable auto-cleanup |
| `retention.decay_rate` | number | 0.01 | Decay rate (0.01 = 50% at 100 days) |
| `retention.access_weight` | number | 0.1 | Weight per access |
| `retention.max_access_boost` | number | 2.0 | Max boost multiplier |
| `retention.keep_threshold` | number | 0.3 | Score to keep |
| `retention.delete_threshold` | number | 0.15 | Score to delete |
| `retention.default_quality_score` | number | 0.5 | Default quality |
| `retention.auto_cleanup_interval_days` | number | 7 | Days between cleanups |

---

## Temporal Settings

Time-weighted search scoring.

```json
{
  "temporal": {
    "enabled": true,
    "semantic_weight": 0.8,
    "recency_weight": 0.2,
    "decay_half_life_hours": 168,
    "decay_floor": 0.1,
    "access_boost_enabled": true,
    "access_boost_factor": 0.05,
    "max_access_boost": 0.3,
    "filter_expired": true
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `temporal.enabled` | boolean | true | Enable temporal scoring |
| `temporal.semantic_weight` | number | 0.8 | Weight for similarity |
| `temporal.recency_weight` | number | 0.2 | Weight for recency |
| `temporal.decay_half_life_hours` | number | 168 | Hours to 50% decay (7 days) |
| `temporal.decay_floor` | number | 0.1 | Minimum decay factor |
| `temporal.access_boost_enabled` | boolean | true | Enable access boost |
| `temporal.access_boost_factor` | number | 0.05 | Boost per access |
| `temporal.max_access_boost` | number | 0.3 | Max boost |
| `temporal.filter_expired` | boolean | true | Filter expired facts |

---

## BPE Tokenizer Settings

Optional enhancement for better text segmentation.

```json
{
  "bpe": {
    "enabled": false,
    "vocab_size": 5000,
    "min_frequency": 2,
    "retrain_interval": "hourly"
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `bpe.enabled` | boolean | false | Enable BPE tokenizer |
| `bpe.vocab_size` | number | 5000 | Vocabulary size |
| `bpe.min_frequency` | number | 2 | Min pair frequency |
| `bpe.retrain_interval` | `"hourly"` \| `"daily"` | `"hourly"` | Retrain schedule |

---

## Compact Briefing Settings

Controls the briefing generated after `/compact`.

> **Note**: Compact briefing now uses the unified `llm.*` configuration. Legacy `compact_briefing.mode` and `compact_briefing.model` settings are deprecated.

```json
{
  "compact_briefing": {
    "enabled": true,
    "format": "structured",
    "include_learnings": true,
    "include_memories": true,
    "max_memories": 3,
    "timeout_ms": 30000
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `compact_briefing.enabled` | boolean | true | Enable briefing |
| `compact_briefing.format` | `"structured"` \| `"prose"` \| `"minimal"` | `"structured"` | Output format |
| `compact_briefing.include_learnings` | boolean | true | Include learnings |
| `compact_briefing.include_memories` | boolean | true | Include memories |
| `compact_briefing.max_memories` | number | 3 | Max memories |
| `compact_briefing.timeout_ms` | number | 30000 | LLM timeout |

---

## Skills Settings

LLM-powered skill discovery and suggestions.

> **Note**: Skills are **disabled by default** to minimize LLM calls. Enable explicitly if needed.

```json
{
  "skills": {
    "enabled": false, // Set to true to enable
    "local_paths": [".claude/commands"],
    "track_usage": true,
    "auto_suggest": {
      "enabled": false, // Set to true to enable
      "on_user_prompt": true,
      "min_confidence": 0.7,
      "max_suggestions": 2,
      "cooldown_prompts": 3,
      "min_prompt_length": 20
    },
    "skyll": {
      "enabled": true,
      "endpoint": "https://api.skyll.app",
      "cache_ttl": 604800,
      "only_when_no_local": true,
      "rate_limit": 30
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `skills.enabled` | boolean | **false** | Enable skills system |
| `skills.local_paths` | string[] | `[".claude/commands"]` | Paths to scan for local skills |
| `skills.track_usage` | boolean | true | Track skill usage statistics |

### Auto-Suggest Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `skills.auto_suggest.enabled` | boolean | **false** | Enable auto-suggestions |
| `skills.auto_suggest.on_user_prompt` | boolean | true | Suggest on each prompt |
| `skills.auto_suggest.min_confidence` | number | 0.7 | Minimum confidence (0-1) |
| `skills.auto_suggest.max_suggestions` | number | 2 | Max suggestions per prompt |
| `skills.auto_suggest.cooldown_prompts` | number | 3 | Prompts between suggestions |
| `skills.auto_suggest.min_prompt_length` | number | 20 | Min prompt length to trigger |

### Skyll Integration

[Skyll](https://skyll.app) is a community registry for Claude Code skills. succ can search Skyll when local skills don't match.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `skills.skyll.enabled` | boolean | true | Enable Skyll integration |
| `skills.skyll.endpoint` | string | `"https://api.skyll.app"` | Skyll API URL |
| `skills.skyll.api_key` | string | - | Optional API key for higher limits |
| `skills.skyll.cache_ttl` | number | 604800 | Cache TTL in seconds (7 days) |
| `skills.skyll.only_when_no_local` | boolean | true | Only search Skyll if no local match |
| `skills.skyll.rate_limit` | number | 30 | Max requests per hour |

**How it works:**

1. User types a prompt
2. LLM extracts technical keywords
3. BM25 searches local skills (`.claude/commands/`)
4. If no match and `only_when_no_local: true`, searches Skyll
5. LLM ranks candidates and suggests best matches

**Environment variable:** `SKYLL_API_KEY` (alternative to config)

---

## Full Example Configuration

```json
{
  "openrouter_api_key": "sk-or-...",

  "embedding_mode": "local",
  "embedding_model": "Xenova/all-MiniLM-L6-v2",
  "chunk_size": 500,
  "chunk_overlap": 50,

  "gpu_enabled": true,

  "llm": {
    "backend": "local",
    "model": "qwen2.5:7b",
    "local_endpoint": "http://localhost:11434/v1/chat/completions",
    "openrouter_model": "anthropic/claude-3-haiku"
  },

  "sleep_agent": {
    "enabled": false
  },

  "quality_scoring_enabled": true,
  "quality_scoring_mode": "local",
  "quality_scoring_threshold": 0.3,

  "sensitive_filter_enabled": true,
  "sensitive_auto_redact": false,

  "graph_auto_link": true,
  "graph_link_threshold": 0.7,

  "remember_extract_default": true,
  "consolidation_llm_default": true,

  "includeCoAuthoredBy": true,

  "daemon": {
    "enabled": true,
    "watch": {
      "auto_start": false,
      "patterns": ["**/*.md"]
    }
  },

  "idle_watcher": {
    "enabled": true,
    "idle_minutes": 2
  },

  "idle_reflection": {
    "enabled": true,
    "operations": {
      "memory_consolidation": true,
      "session_summary": true
    }
  },

  "compact_briefing": {
    "enabled": true,
    "format": "structured",
    "include_memories": true,
    "max_memories": 3
  },

  "skills": {
    "enabled": true,
    "auto_suggest": {
      "enabled": true,
      "min_confidence": 0.7
    },
    "skyll": {
      "enabled": true,
      "only_when_no_local": true
    }
  },

  "quality_gates": {
    "auto_detect": true,
    "disable": [],
    "gates": [],
    "subdirs": {}
  },

  "retention": {
    "enabled": false
  },

  "temporal": {
    "enabled": true,
    "semantic_weight": 0.8,
    "recency_weight": 0.2
  }
}
```

---

## See Also

- [Ollama Integration](./ollama.md)
- [llama.cpp Integration](./llama-cpp.md)
- [Troubleshooting](./troubleshooting.md)
