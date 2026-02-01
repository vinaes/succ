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

### `succ graph <action>`

Knowledge graph operations for memories:

```bash
succ graph export                 # Export to Obsidian format (default)
succ graph export --format json   # Export to JSON
succ graph export -o ./output     # Custom output directory
succ graph stats                  # Show graph statistics
succ graph auto-link              # Auto-link similar memories
succ graph auto-link -t 0.8       # Custom similarity threshold
```

### `succ analyze`

**The magic command.** Analyzes your project and generates a complete brain vault:

```bash
succ analyze                      # Run via Claude CLI (recommended)
succ analyze --sequential         # Run agents one by one
succ analyze --background         # Run in background (for large projects)
succ analyze --openrouter         # Use OpenRouter API (if no Claude subscription)
succ analyze --local              # Use local LLM (Ollama, LM Studio, llama.cpp)
```

**Modes:**
- **Claude CLI mode (default)** — uses your Claude subscription, no extra API costs
- **OpenRouter mode** — for users without Claude subscription (pay per API call)
- **Local mode** — use your own LLM (Qwen, DeepSeek, Llama, etc.)
- **Background mode** — runs detached, check status with `succ status`

#### Local LLM Configuration

To use local models for analysis, configure in `~/.succ/config.json`:

```json
{
  "analyze_mode": "local",
  "analyze_api_url": "http://localhost:11434/v1",
  "analyze_model": "qwen2.5-coder:32b",
  "analyze_temperature": 0.3,
  "analyze_max_tokens": 4096
}
```

**Supported backends:**
- **Ollama**: `http://localhost:11434/v1`
- **LM Studio**: `http://localhost:1234/v1`
- **llama.cpp**: `http://localhost:8080/v1`
- Any OpenAI-compatible API

**Recommended models for code analysis:**
| Model | Size | Notes |
|-------|------|-------|
| `qwen2.5-coder:32b` | ~20GB | Best for code, multilingual |
| `deepseek-coder-v2:16b` | ~10GB | Fast, MoE architecture |
| `codellama:34b` | ~20GB | Good code understanding |
| `llama3.3:70b-q4` | ~40GB | General purpose |

#### Sandbox Mode (Continuous Analysis)

Sandbox mode runs as a background daemon that continuously analyzes your project at regular intervals:

```bash
# Start sandbox daemon (default: every 30 minutes)
succ analyze --sandbox

# Custom interval (in minutes)
succ analyze --sandbox --interval 60

# Check sandbox status
succ analyze --sandbox-status

# Stop running sandbox daemon
succ analyze --sandbox-stop
```

**How sandbox mode works:**
1. Starts a detached background process
2. Runs initial analysis immediately
3. Re-analyzes at configured intervals
4. Uses file-based locking to prevent concurrent runs
5. Logs output to `.claude/sandbox-analyze.log`

**Use cases:**
- Keep brain vault up-to-date as code changes
- Run overnight for large codebases
- Continuous documentation generation

**Sandbox daemon features:**
- **File-based locking** — prevents multiple sandbox instances
- **Graceful shutdown** — responds to stop signal
- **Status tracking** — check if running, PID, last run time
- **Auto-cleanup** — lock files auto-expire after 2 hours

**What it creates:**

```
.claude/brain/
├── CLAUDE.md                    # Navigation hub
├── .obsidian/graph.json         # Graph colors config
├── .meta/learnings.md           # Lessons learned
├── 00_Inbox/                    # Session notes, unprocessed items
├── 01_Projects/{project}/
│   ├── {project}.md             # Project index
│   ├── Technical/
│   │   ├── Architecture Overview.md
│   │   ├── API Reference.md
│   │   ├── Conventions.md
│   │   └── Dependencies.md
│   ├── Systems/                 # Individual system docs
│   │   ├── Systems Overview.md
│   │   └── {System Name}.md
│   ├── Strategy/
│   │   └── Project Strategy.md
│   └── Features/                # Individual feature docs
│       ├── Features Overview.md
│       └── {Feature Name}.md
├── 02_Knowledge/                # Research notes
└── 03_Archive/                  # Old/superseded
```

**Agents run:**
1. **Architecture** — structure, entry points, data flow
2. **API** — endpoints, routes, schemas
3. **Conventions** — naming, patterns, style
4. **Dependencies** — key libraries and their purposes
5. **Systems** — core systems/modules (creates multiple files)
6. **Strategy** — project goals, target users, differentiators
7. **Features** — implemented features (creates multiple files)

Each agent writes directly to brain vault with proper:
- YAML frontmatter (description, type, relevance)
- Wikilinks ([[note-name]])
- Parent links for graph hierarchy

## Configuration

**No API key required!** succ uses local embeddings by default via [Transformers.js](https://huggingface.co/docs/transformers.js).

Optional `~/.succ/config.json`:

```json
{
  // Embedding settings (for search)
  "embedding_mode": "local",                        // "local" (default), "openrouter", or "custom"
  "embedding_model": "Xenova/all-MiniLM-L6-v2",    // Local model (384 dimensions)
  "chunk_size": 500,
  "chunk_overlap": 50,

  // Analyze settings (for succ analyze)
  "analyze_mode": "claude",                         // "claude" (default), "openrouter", or "local"
  "analyze_api_url": "http://localhost:11434/v1",  // For local mode
  "analyze_model": "qwen2.5-coder:32b"             // Model name for local/openrouter
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
  "embedding_model": "your-model-name",
  "custom_batch_size": 32,
  "embedding_dimensions": 768
}
```

### GPU Acceleration with llama.cpp

For GPU-accelerated embeddings, use llama.cpp server with CUDA/ROCm/Metal:

**1. Install llama.cpp:**
```bash
# Option A: Download pre-built binaries (recommended)
# https://github.com/ggerganov/llama.cpp/releases
# Get the CUDA/ROCm/Metal version for your platform

# Option B: Build from source with CUDA
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
cmake -B build -DLLAMA_CUDA=ON
cmake --build build --config Release
```

**2. Download an embedding model (GGUF format):**
```bash
# Recommended: BGE-M3 (1024d, 8192 token context, multilingual)
curl -L -o bge-m3-Q8_0.gguf \
  "https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf"

# Alternative: nomic-embed-text (768d, 2048 token context)
curl -L -o nomic-embed-text-v1.5.Q8_0.gguf \
  "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf"
```

**3. Start llama-server:**
```bash
./llama-server \
  -m bge-m3-Q8_0.gguf \
  --embeddings \
  --port 8078 \
  -ngl 99 \
  -b 8192 -ub 8192  # Increase batch size for long contexts
```

**4. Configure succ:**
```json
{
  "embedding_mode": "custom",
  "custom_api_url": "http://localhost:8078/v1/embeddings",
  "embedding_model": "bge-m3",
  "custom_batch_size": 64,
  "embedding_dimensions": 1024
}
```

**Recommended models:**

| Model | Dimensions | Context | Size | Quality | Notes |
|-------|------------|---------|------|---------|-------|
| **bge-m3** | 1024 | 8192 | 635MB | State-of-art | Best for code, multilingual |
| nomic-embed-text-v1.5 | 768 | 2048 | 140MB | Excellent | Good balance |
| bge-large-en-v1.5 | 1024 | 512 | 341MB | State-of-art | Short context only |
| all-MiniLM-L6-v2 | 384 | 512 | 90MB | Good | Fast, small |

**Benchmark results (500 texts, RTX 4070):**

| Mode | Model | Time | Rate | Speedup |
|------|-------|------|------|---------|
| GPU (llama.cpp) | BGE-M3 1024d | 2339ms | 214/s | **1.72x** |
| CPU (transformers.js) | MiniLM 384d | 4024ms | 124/s | baseline |

**Batch size recommendations:**
- llama.cpp: 32-128 (GPU memory dependent)
- For BGE-M3: use `-b 8192 -ub 8192` to support full context
- LM Studio: 16-32
- Ollama: 16-32

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
| `succ_link` | Create/manage links between memories (knowledge graph) |
| `succ_explore` | Explore knowledge graph from a memory |
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

The session-end hook automatically preserves knowledge from every session:

**1. SQLite Memory** — session summaries saved via `succ remember`
- Auto-tags based on content (bugfix, feature, refactor, decision)
- Searchable with `succ memories -s "query"`

**2. Learnings Extraction** — Claude analyzes session and extracts learnings to `.claude/brain/.meta/learnings.md`
- Uses Claude CLI (haiku) to intelligently extract:
  - Bug fixes: what was wrong and how it was fixed
  - Technical discoveries: APIs, patterns, gotchas
  - Architecture decisions and rationale
  - Workarounds for specific problems
- Skips routine work with no meaningful learnings
- Appends dated entries automatically

**3. Session Notes** — full session note created in `.claude/brain/00_Inbox/`
- Filename: `Session {date} {title}.md`
- YAML frontmatter with tags and type
- Ready for processing in Obsidian Inbox

**What triggers it:**
- Claude Code session ends (Stop hook)
- Session must have at least 50 chars of summary

**4. Idle Reflections** — triggered when Claude has been idle (~60 seconds)
- Uses Claude CLI (haiku) to generate meaningful reflection
- Analyzes recent transcript context
- Writes introspective notes to `.claude/brain/.self/reflections.md`
- Considers: what was accomplished, challenges, things worth remembering

**Note:** Idle detection uses the `Notification` hook with `idle_prompt` matcher. This fires after ~60 seconds of inactivity (Claude Code default), not a configurable 30-minute timeout.

## Performance

### Optimizations

- **Embedding cache** — LRU cache (500 entries) avoids re-computing embeddings for repeated content
- **Batch processing** — Local embeddings process in batches of 16 with parallel execution
- **Batch transactions** — Database writes are batched in transactions for 10x faster indexing
- **Retry logic** — API calls use exponential backoff (3 retries)
- **Request timeout** — 30s timeout prevents hanging on slow API responses
- **Model compatibility check** — Warns if embedding model changes (dimensions mismatch)

### Benchmarks

Run `succ benchmark` to measure performance. The benchmark automatically tests both local and OpenRouter modes (if API key is configured):

```bash
succ benchmark           # Run with 10 iterations per mode
succ benchmark -n 25     # More iterations for accuracy
```

**Example output:**

```
═══════════════════════════════════════════════════════════
                     SUCC BENCHMARK
═══════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────┐
│ LOCAL EMBEDDINGS (Xenova/all-MiniLM-L6-v2)                   │
└─────────────────────────────────────────────────────────────┘
  [1/5] Embedding generation...
  [2/5] Memory save...
  [3/5] Memory recall...
  [4/5] DB search...
  [5/5] Accuracy test...

┌─────────────────────────────────────────────────────────────┐
│ OPENROUTER API (openai/text-embedding-3-small)              │
└─────────────────────────────────────────────────────────────┘
  [1/5] Embedding generation...
  ...

═══════════════════════════════════════════════════════════
                        SUMMARY
═══════════════════════════════════════════════════════════

LOCAL (Xenova/all-MiniLM-L6-v2, 384d):
┌─────────────────────────┬──────────┬──────────┬──────────┐
│ Operation               │ Avg (ms) │ Min (ms) │ Max (ms) │
├─────────────────────────┼──────────┼──────────┼──────────┤
│ Embedding generation    │     22.6 │     14.0 │     35.0 │
│ Memory save (full)      │     34.5 │     20.0 │     54.0 │
│ Memory recall (full)    │     19.5 │     13.0 │     34.0 │
│ DB search only          │      0.7 │      0.0 │      4.0 │
└─────────────────────────┴──────────┴──────────┴──────────┘
  Throughput: 44.2 embed/sec
  Accuracy: 100% (10/10)

OPENROUTER (openai/text-embedding-3-small, 1536d):
┌─────────────────────────┬──────────┬──────────┬──────────┐
│ Operation               │ Avg (ms) │ Min (ms) │ Max (ms) │
├─────────────────────────┼──────────┼──────────┼──────────┤
│ Embedding generation    │    612.2 │    515.0 │    742.0 │
│ Memory save (full)      │    680.5 │    516.0 │    979.0 │
│ Memory recall (full)    │    654.5 │    481.0 │   1191.0 │
│ DB search only          │      1.8 │      1.0 │      3.0 │
└─────────────────────────┴──────────┴──────────┴──────────┘
  Throughput: 1.6 embed/sec
  Accuracy: 100% (10/10)

─────────────────────────────────────────────────────────────
COMPARISON:
  Local embedding:     22.6ms avg
  OpenRouter embedding: 612.2ms avg
  → Local is 27.1x faster (no network latency)
  → Both achieve 100% semantic accuracy
```

**When to use each mode:**

| Mode | Best for | Trade-offs |
|------|----------|------------|
| **Local** (default) | Speed, privacy, offline use | Smaller model (384d) |
| **OpenRouter API** | Higher-dimension embeddings (1536d) | Network latency, API costs |

*Note: If no OpenRouter API key is configured, only the local benchmark runs.*

## vs Supermemory

[Supermemory](https://supermemory.ai/) is a commercial memory API for AI apps. Here's how succ compares:

| Feature | Supermemory | succ |
|---------|-------------|------|
| Hosting | Cloud (default), self-host available | Local only |
| Privacy | Cloud by default, on-premise option | Everything local, always |
| Cost | Free tier (1M tokens), Pro $19/mo, Scale $399/mo | Free forever |
| Embeddings | Cloud API | Local (free) or API (your choice) |
| MCP integration | Yes | Yes |
| Cross-project memory | Cloud sync | Local global DB |
| Code search | Via API | Yes (semantic, local) |
| Knowledge graph | Via API | Obsidian-compatible vault |
| Open source | Partial (MCP server) | Fully open source |
| Versioning | None | Git-tracked brain vault |
| Setup | Account + API key | `npm install -g succ && succ init` |

**When to use Supermemory:**
- You need managed infrastructure
- You want sub-400ms latency at scale
- You're building a commercial product with their API

**When to use succ:**
- You want zero cloud dependencies
- You prefer Obsidian for knowledge management
- You want full control over your data
- You're a solo dev or small team

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
git clone https://github.com/vinaes/succ.git
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

### Testing

succ has comprehensive test coverage using [Vitest](https://vitest.dev/). Tests cover all core functionality:

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run specific test file
npm test -- src/lib/lock.test.ts

# Run tests with coverage
npm test -- --coverage
```

**Test coverage includes:**

| Module | Tests | Coverage |
|--------|-------|----------|
| `lib/lock.ts` | 14 | Lock acquisition, release, concurrency, stale detection |
| `lib/chunker.ts` | 27 | Text/code chunking for TS, JS, Python, Go, Rust |
| `lib/config.ts` | 15 | Configuration loading, paths, overrides |
| `lib/db.ts` | 23 | Documents, memories, knowledge graph, global DB |
| `lib/graph-export.ts` | 11 | JSON/Obsidian export, wiki-links |
| `commands/analyze.ts` | 13 | Multi-file output, sandbox state, brain structure |
| Integration | 9 | CLI commands, MCP server, sandbox daemon |

**Total: 112 tests**

Tests are designed to:
- Use isolated temp directories to avoid affecting real data
- Mock heavy dependencies (embeddings, external APIs)
- Test concurrent scenarios and race conditions
- Verify Windows compatibility (file locking, paths)

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
│   │   ├── analyze.ts      # succ analyze (+ sandbox mode)
│   │   ├── graph.ts        # succ graph (export, stats, auto-link)
│   │   ├── benchmark.ts    # succ benchmark
│   │   ├── clear.ts        # succ clear
│   │   └── ...
│   └── lib/
│       ├── db.ts           # SQLite database (documents, memories, links)
│       ├── embeddings.ts   # Embeddings with cache, retry, timeout
│       ├── chunker.ts      # Text/code chunking
│       ├── config.ts       # Configuration management
│       ├── indexer.ts      # Shared indexing logic with progress bar
│       ├── lock.ts         # File-based locking for sandbox mode
│       └── graph-export.ts # Export memories to Obsidian/JSON
├── dist/                   # Compiled JavaScript (generated)
├── package.json
├── eslint.config.js        # ESLint flat config
├── .prettierrc             # Prettier config
└── tsconfig.json
```

## License

MIT
