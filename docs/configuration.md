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
| `embedding_local_batch_size` | number | 16 | Batch size for local embeddings |
| `embedding_local_concurrency` | number | 4 | Concurrent batches for local embeddings |
| `embedding_worker_pool_enabled` | boolean | true | Use worker thread pool for local embeddings |
| `embedding_worker_pool_size` | number | auto | Worker pool size (auto = based on CPU cores) |
| `embedding_cache_size` | number | 500 | Embedding LRU cache size |

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

> **Note**: `succ analyze` now uses the unified `llm.*` configuration. Legacy `analyze_*` settings are deprecated but still functional.

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

### Legacy Keys (deprecated)

These keys still work but will be removed in a future version. Use `llm.*` instead.

| Option | Type | Description |
|--------|------|-------------|
| `analyze_mode` | `"claude"` \| `"openrouter"` \| `"local"` | Analysis LLM mode |
| `analyze_api_url` | string | Local LLM API URL |
| `analyze_api_key` | string | API key for local LLM |
| `analyze_model` | string | Model name |
| `analyze_temperature` | number | Temperature (default: 0.3) |
| `analyze_max_tokens` | number | Max tokens (default: 4096) |

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

### Core Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `graph_auto_link` | boolean | true | Auto-link similar memories |
| `graph_link_threshold` | number | 0.7 | Similarity threshold for linking |
| `graph_auto_export` | boolean | false | Auto-export on changes |
| `graph_export_format` | `"obsidian"` \| `"json"` | `"obsidian"` | Export format |
| `graph_export_path` | string | `.succ/brain/graph` | Custom export path |

### LLM Relation Enrichment

Replace blind `similar_to` links with semantically accurate relation types via LLM.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `graph_llm_relations.enabled` | boolean | false | Enable LLM relation classification |
| `graph_llm_relations.batch_size` | number | 5 | Pairs per LLM call |
| `graph_llm_relations.auto_on_save` | boolean | false | Enrich links when saving memories |

Available relations: `caused_by`, `leads_to`, `contradicts`, `implements`, `supersedes`, `references`, `related`, `similar_to`

```json
{
  "graph_llm_relations": {
    "enabled": true,
    "batch_size": 5,
    "auto_on_save": false
  }
}
```

**CLI:** `succ graph enrich-relations [--limit N] [--force]`
**MCP:** `succ_link action="enrich"`

### Contextual Proximity

Create `related` links between memories that share the same source/session context.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `graph_contextual_proximity.enabled` | boolean | false | Enable proximity linking |
| `graph_contextual_proximity.min_cooccurrence` | number | 2 | Min co-occurrences to link |
| `graph_contextual_proximity.source_pattern` | string | - | Regex to normalize sources |

```json
{
  "graph_contextual_proximity": {
    "enabled": true,
    "min_cooccurrence": 2
  }
}
```

**CLI:** `succ graph proximity [--min-count 2] [--dry-run]`
**MCP:** `succ_link action="proximity"`

### Community Detection

Auto-group memories into thematic communities via Label Propagation algorithm. Results are stored as `community:N` tags.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `graph_community_detection.enabled` | boolean | false | Enable community detection |
| `graph_community_detection.algorithm` | string | `"label-propagation"` | Detection algorithm |
| `graph_community_detection.max_iterations` | number | 100 | Max LP iterations |
| `graph_community_detection.min_community_size` | number | 2 | Min members to form a community |
| `graph_community_detection.tag_prefix` | string | `"community"` | Tag prefix for communities |

```json
{
  "graph_community_detection": {
    "enabled": true,
    "max_iterations": 100
  }
}
```

**CLI:** `succ graph communities`
**MCP:** `succ_link action="communities"`

Communities are searchable via `succ_recall tags=["community:3"]`.

### Centrality Scoring

Degree centrality scoring with recall boost — well-connected memories rank higher in search results.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `graph_centrality.enabled` | boolean | false | Enable centrality boost |
| `graph_centrality.algorithm` | string | `"degree"` | Centrality algorithm |
| `graph_centrality.boost_weight` | number | 0.1 | Max recall boost (10%) |
| `graph_centrality.cache_ttl_hours` | number | 24 | Cache TTL for scores |

```json
{
  "graph_centrality": {
    "enabled": true,
    "boost_weight": 0.1
  }
}
```

**CLI:** `succ graph centrality`
**MCP:** `succ_link action="centrality"`

Recall scoring pipeline: `hybrid search → temporal decay → dead-end boost → centrality boost → re-sort`

### Example: Export to Obsidian

Obsidian export includes community colors (HLS palette per community) and enriched relation types on wiki-links.

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
| `dead_end_boost` | number | 0.15 | Similarity boost for dead-end memories in recall results (0 to disable) |

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

## Pre-Commit Review Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `preCommitReview` | boolean | false | Run `succ-diff-reviewer` agent before every git commit |

When enabled, the `PreToolUse` hook injects a `<pre-commit-review>` instruction at the exact moment Claude attempts a `git commit`. This tells the AI to run the `succ-diff-reviewer` agent on staged changes before committing. The agent checks for security issues (OWASP Top 10), bugs, regressions, and leftover debug code.

**Behavior on findings:**
- **CRITICAL** — commit is blocked until fixed
- **HIGH** — user is warned before committing
- **MEDIUM and below** — commit proceeds, findings mentioned in summary

```json
{
  "preCommitReview": true
}
```

Enable via CLI: `succ config_set preCommitReview true`

> **Note**: This adds review time before each commit. The `succ-diff-reviewer` agent works with any programming language. Context is injected via `PreToolUse` hook, so it survives context compaction.

---

## Communication Settings

Controls how Claude adapts its communication style based on user patterns.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `communicationAutoAdapt` | boolean | `true` | Allow Claude to auto-update communication preferences in soul.md |
| `communicationTrackHistory` | boolean | `false` | Log style changes to brain vault (`.succ/brain/05_Communication/`) for Obsidian graph |

When `communicationAutoAdapt` is enabled, Claude detects communication patterns (language, formality, tone) and delegates updates to the `succ-style-tracker` agent. The agent updates the `## User Communication Preferences` section in soul.md.

When `communicationTrackHistory` is also enabled, each style change creates a dated markdown file in `.succ/brain/05_Communication/` with wiki-links to previous entries — visible in Obsidian Graph View.

```json
{
  "communicationAutoAdapt": true,
  "communicationTrackHistory": true
}
```

Disable auto-adaptation entirely:

```json
{
  "communicationAutoAdapt": false
}
```

---

## Command Safety Guard

Blocks dangerous git, filesystem, database, and Docker commands before they execute. Runs as a `PreToolUse` hook on every Bash tool call.

```json
{
  "commandSafetyGuard": {
    "mode": "deny",
    "allowlist": ["rm -rf node_modules"],
    "customPatterns": [
      { "pattern": "\\bkubectl\\s+delete\\s+namespace\\b", "reason": "Deletes entire Kubernetes namespace" },
      { "pattern": "\\bredis-cli\\s+FLUSHALL\\b", "reason": "Wipes all Redis databases", "flags": "i" }
    ]
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `commandSafetyGuard.mode` | `"deny"` \| `"ask"` \| `"off"` | `"deny"` | `deny` blocks the command, `ask` prompts the user for confirmation, `off` disables the guard |
| `commandSafetyGuard.allowlist` | string[] | `[]` | Commands to always allow even if they match dangerous patterns |
| `commandSafetyGuard.customPatterns` | object[] | `[]` | User-defined regex patterns to block (see below) |
| `customPatterns[].pattern` | string | — | Regex pattern string to match against the command |
| `customPatterns[].reason` | string | — | Why this command is blocked (shown to Claude) |
| `customPatterns[].flags` | string | `""` | Regex flags (e.g. `"i"` for case-insensitive) |

### Built-in blocked patterns

**Git:**

| Command | Why |
|---------|-----|
| `git reset --hard` / `--merge` | Destroys uncommitted changes |
| `git checkout -- <file>` / `git checkout .` | Discards file modifications |
| `git restore --staged --worktree` | Discards both staged and unstaged changes |
| `git clean -f` | Permanently deletes untracked files |
| `git push --force` / `-f` | Rewrites remote history (use `--force-with-lease`) |
| `git branch -D` | Force-deletes without merge verification |
| `git stash drop` / `clear` | Destroys stashed work |
| `git rebase -i` | Requires interactive terminal |
| `git reflog expire --expire=now` | Permanently removes recovery points |

**Filesystem:**

| Command | Why |
|---------|-----|
| `rm -rf` (unsafe paths) | Permanent file deletion |

**Docker:**

| Command | Why |
|---------|-----|
| `docker system prune` | Removes all unused containers, networks, images |
| `docker volume prune` | Removes all unused volumes (data loss) |
| `docker rm -f` | Force-removes running containers |
| `docker rmi -f` | Force-removes images that may be in use |
| `docker compose down -v` | Removes named volumes (database data loss) |

**SQLite:**

| Command | Why |
|---------|-----|
| `sqlite3 ... DROP TABLE` | Permanently deletes a table |
| `sqlite3 ... DELETE FROM x;` | Deletes all rows (no WHERE clause) |
| `sqlite3 ... TRUNCATE` | Removes all data from a table |

**PostgreSQL:**

| Command | Why |
|---------|-----|
| `psql ... DROP TABLE` / `DROP DATABASE` | Permanently deletes table/database |
| `psql ... DELETE FROM x;` | Deletes all rows (no WHERE clause) |
| `dropdb` / `dropuser` | Permanently deletes database/user |

**Qdrant:**

| Command | Why |
|---------|-----|
| `curl ... qdrant ... DELETE` | Removes collections or points permanently |
| `curl ... :6333 ... DELETE` | DELETE on Qdrant REST port |

### Smart detection

Commands in data contexts (grep, echo, comments) are not blocked. `rm -rf` on safe paths (`node_modules`, `dist`, `build`, `.cache`, `.next`, `/tmp`, `coverage`) is allowed by default.

---

## Readiness Gate Settings

Confidence assessment for search results. When enabled, succ evaluates whether search results are sufficient before proceeding.

```json
{
  "readiness_gate": {
    "enabled": true,
    "thresholds": {
      "proceed": 0.7,
      "warn": 0.4
    },
    "expected_results": 5
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `readiness_gate.enabled` | boolean | true | Enable readiness gate |
| `readiness_gate.thresholds.proceed` | number | 0.7 | Confidence threshold to proceed |
| `readiness_gate.thresholds.warn` | number | 0.4 | Confidence threshold to warn |
| `readiness_gate.expected_results` | number | 5 | Expected result count for coverage calculation |

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

# Export to Obsidian
succ prd export                                   # Export latest PRD
succ prd export --all                             # Export all PRDs
succ prd export prd_abc123                        # Export specific PRD
succ prd export --output ./my-vault/PRD           # Custom output directory
```

### Obsidian Export

`succ prd export` generates Obsidian-compatible markdown with Mermaid diagrams:

| File | Content |
|------|---------|
| `Overview.md` | PRD summary, stats, quality gates, embedded dependency graph |
| `Timeline.md` | Mermaid Gantt chart — sequential bars (loop) or worker sections (team) |
| `Dependencies.md` | Mermaid flowchart DAG — color-coded by status (green/red/gray) |
| `Tasks/task_NNN.md` | Per-task detail: acceptance criteria, attempts, gate results, files modified |

Output goes to `.succ/brain/04_PRD/{prd-title}/`. Open the `.succ/brain/` folder in Obsidian — Mermaid diagrams render natively, wiki-links connect all pages.

For team mode PRDs, the Gantt chart reconstructs worker assignment from timestamps, showing which tasks ran in parallel.

### MCP Tools

The same operations are available via MCP:

| Tool | Description |
|------|-------------|
| `succ_prd_generate` | Generate PRD from description |
| `succ_prd_list` | List all PRDs |
| `succ_prd_status` | Show PRD and task status |
| `succ_prd_run` | Execute or resume a PRD |
| `succ_prd_export` | Export PRD workflow to Obsidian (Mermaid diagrams) |

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
| `daemon.analyze.mode` | `"claude"` \| `"openrouter"` \| `"local"` | `"claude"` | Analysis LLM mode (legacy, prefer `llm.*`) |

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
| `memory_consolidation` | true | Merge similar memories, remove duplicates |
| `graph_refinement` | true | Auto-link memories by similarity |
| `graph_enrichment` | true | LLM enrich + proximity + communities + centrality |
| `session_summary` | true | Extract key facts from session transcript |
| `precompute_context` | false | Prepare context for next session-start |
| `write_reflection` | true | Write human-like reflection text |
| `retention_cleanup` | true | Delete decayed memories below threshold (if `retention.enabled`) |

### Thresholds

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `idle_reflection.thresholds.similarity_for_merge` | number | 0.92 | Cosine similarity to consider memories duplicates |
| `idle_reflection.thresholds.auto_link_threshold` | number | 0.75 | Similarity threshold for graph auto-linking |
| `idle_reflection.thresholds.min_quality_for_summary` | number | 0.5 | Min quality score for extracted facts |

### Consolidation Guards

Safety limits to prevent destructive consolidation.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `idle_reflection.consolidation_guards.min_memory_age_days` | number | 7 | Don't consolidate memories younger than N days |
| `idle_reflection.consolidation_guards.min_corpus_size` | number | 20 | Don't consolidate if total memories < N |
| `idle_reflection.consolidation_guards.require_llm_merge` | boolean | true | Always use LLM for merge, never destructive delete |

### Agent Model

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `idle_reflection.agent_model` | `"haiku"` \| `"sonnet"` \| `"opus"` | `"haiku"` | Claude model for reflection |
| `idle_reflection.max_memories_to_process` | number | 50 | Max memories to process per idle cycle |
| `idle_reflection.timeout_seconds` | number | 25 | Max time for idle operations |

### Idle Reflection Sleep Agent

Optional secondary LLM running in parallel for heavy lifting during idle reflection. Separate from the top-level `sleep_agent` config.

```json
{
  "idle_reflection": {
    "sleep_agent": {
      "enabled": true,
      "mode": "local",
      "model": "qwen2.5:7b",
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

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `idle_reflection.sleep_agent.enabled` | boolean | false | Enable secondary sleep agent |
| `idle_reflection.sleep_agent.mode` | `"local"` \| `"openrouter"` | `"local"` | Backend |
| `idle_reflection.sleep_agent.model` | string | - | Model name |
| `idle_reflection.sleep_agent.api_url` | string | - | API URL for local mode |
| `idle_reflection.sleep_agent.api_key` | string | - | API key for openrouter |
| `idle_reflection.sleep_agent.handle_operations` | object | all true | Which operations to offload |

### Sleep Agent (Top-Level Secondary LLM)

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
| `retention.use_temporal_decay` | boolean | true | Use exponential decay from temporal.ts instead of hyperbolic |

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
| `skills.auto_suggest.llm_backend` | `"claude"` \| `"local"` \| `"openrouter"` | `"claude"` | LLM backend for keyword extraction |
| `skills.auto_suggest.llm_model` | string | `"haiku"` | Model for Claude backend |
| `skills.auto_suggest.local_endpoint` | string | `"http://localhost:11434/v1/chat/completions"` | Local LLM endpoint |
| `skills.auto_suggest.local_model` | string | `"qwen2.5:7b"` | Model for local backend |
| `skills.auto_suggest.openrouter_model` | string | `"anthropic/claude-3-haiku"` | Model for OpenRouter |
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

## Web Search Settings

Real-time web search via Perplexity Sonar models through OpenRouter. Requires `openrouter_api_key`.

```json
{
  "web_search": {
    "enabled": true,
    "quick_search_model": "perplexity/sonar",
    "model": "perplexity/sonar-pro",
    "deep_research_model": "perplexity/sonar-deep-research",
    "max_tokens": 4000,
    "temperature": 0.1,
    "save_to_memory": false
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `web_search.enabled` | boolean | true | Enable web search tools |
| `web_search.quick_search_model` | string | `"perplexity/sonar"` | Model for `succ_quick_search` |
| `web_search.quick_search_max_tokens` | number | 2000 | Max tokens for quick search |
| `web_search.quick_search_timeout_ms` | number | 15000 | Timeout for quick search (ms) |
| `web_search.model` | string | `"perplexity/sonar-pro"` | Model for `succ_web_search` |
| `web_search.deep_research_model` | string | `"perplexity/sonar-deep-research"` | Model for `succ_deep_research` |
| `web_search.max_tokens` | number | 4000 | Max tokens for web search |
| `web_search.deep_research_max_tokens` | number | 8000 | Max tokens for deep research |
| `web_search.timeout_ms` | number | 30000 | Timeout for web search (ms) |
| `web_search.deep_research_timeout_ms` | number | 120000 | Timeout for deep research (ms) |
| `web_search.temperature` | number | 0.1 | Temperature (low for factual search) |
| `web_search.save_to_memory` | boolean | false | Auto-save search results to memory |
| `web_search.daily_budget_usd` | number | 0 | Daily spending limit in USD (0 = unlimited) |

### Cost Comparison

| Tool | Model | Cost | Use case |
|------|-------|------|----------|
| `succ_quick_search` | Sonar | ~$1/MTok | Simple facts, version numbers |
| `succ_web_search` | Sonar Pro | ~$3-15/MTok | Complex queries, documentation |
| `succ_deep_research` | Sonar Deep Research | ~$1+/query | Multi-step synthesis, 30+ sources |

---

## Chat LLM Settings

Separate LLM configuration for interactive chats (`succ chat`, onboarding). Defaults to Claude CLI with Sonnet for best interactive quality.

```json
{
  "chat_llm": {
    "backend": "claude",
    "model": "sonnet",
    "max_tokens": 4000,
    "temperature": 0.7
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `chat_llm.backend` | `"claude"` \| `"local"` \| `"openrouter"` | `"claude"` | LLM provider |
| `chat_llm.model` | string | `"sonnet"` | Model name |
| `chat_llm.local_endpoint` | string | from `llm.local_endpoint` | Local LLM endpoint |
| `chat_llm.max_tokens` | number | 4000 | Max tokens per response |
| `chat_llm.temperature` | number | 0.7 | Generation temperature |

---

## Full Example Configuration

```json
{
  "openrouter_api_key": "sk-or-...",

  "embedding_mode": "local",
  "embedding_model": "Xenova/all-MiniLM-L6-v2",
  "embedding_batch_size": 32,
  "embedding_local_batch_size": 16,
  "embedding_local_concurrency": 4,
  "embedding_worker_pool_enabled": true,
  "embedding_cache_size": 500,
  "chunk_size": 500,
  "chunk_overlap": 50,

  "gpu_enabled": true,

  "llm": {
    "backend": "local",
    "model": "qwen2.5:7b",
    "local_endpoint": "http://localhost:11434/v1/chat/completions",
    "openrouter_model": "anthropic/claude-3-haiku"
  },

  "chat_llm": {
    "backend": "claude",
    "model": "sonnet"
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
  "graph_centrality": {
    "enabled": true,
    "boost_weight": 0.1
  },

  "remember_extract_default": true,
  "consolidation_llm_default": true,
  "dead_end_boost": 0.15,

  "includeCoAuthoredBy": true,
  "preCommitReview": false,
  "communicationAutoAdapt": true,
  "communicationTrackHistory": false,

  "commandSafetyGuard": {
    "mode": "deny",
    "allowlist": []
  },

  "readiness_gate": {
    "enabled": true
  },

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
    "agent_model": "haiku",
    "operations": {
      "memory_consolidation": true,
      "graph_enrichment": true,
      "session_summary": true
    },
    "consolidation_guards": {
      "min_memory_age_days": 7,
      "min_corpus_size": 20,
      "require_llm_merge": true
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

  "web_search": {
    "enabled": true,
    "model": "perplexity/sonar-pro",
    "save_to_memory": false
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
