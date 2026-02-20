# Development

## Installation from Source

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

## Development Commands

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

## Testing

succ has comprehensive test coverage using [Vitest](https://vitest.dev/):

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

### Test Coverage

**Total: 1300+ tests** across 70+ test files.

Key test areas:
- Core libraries: config, chunker, lock, embeddings, quality scoring, temporal
- Storage: SQLite, PostgreSQL, dispatcher, hybrid search, retention
- Tree-sitter: AST parsing, symbol extraction, code chunking (13 languages)
- Working memory: pipeline, priority scoring, validity filtering, diversity
- MCP tools: search, memory, graph, indexing, debug, web-fetch, PRD
- Commands: init, index, analyze, watch, graph, PRD pipeline
- Integration: CLI commands, MCP server, daemon

Tests are designed to:
- Use isolated temp directories to avoid affecting real data
- Mock heavy dependencies (embeddings, external APIs)
- Test concurrent scenarios and race conditions
- Verify Windows compatibility (file locking, paths)

## Project Structure

```
succ/
├── src/
│   ├── cli.ts                  # CLI entry point
│   ├── mcp/
│   │   ├── server.ts           # MCP server entry point
│   │   ├── helpers.ts          # MCP utilities (project path, responses)
│   │   ├── resources.ts        # MCP resources (brain://, soul://)
│   │   └── tools/              # 11 MCP tool modules (14 consolidated tools)
│   │       ├── search.ts       # succ_search, succ_search_code
│   │       ├── memory.ts       # succ_remember, succ_recall, succ_forget
│   │       ├── graph.ts        # succ_link (create/delete/show/graph/auto/enrich/proximity/communities/centrality/export/explore)
│   │       ├── indexing.ts     # succ_index (doc/code/refresh/analyze/symbols)
│   │       ├── status.ts       # succ_status (default/stats/score)
│   │       ├── config.ts       # succ_config (show/set/checkpoint_create/checkpoint_list)
│   │       ├── dead-end.ts     # succ_dead_end
│   │       ├── prd.ts          # succ_prd (generate/list/status/run/export)
│   │       ├── web-search.ts   # succ_web (quick/search/deep/history)
│   │       ├── web-fetch.ts    # succ_fetch (md.succ.ai integration)
│   │       └── debug.ts        # succ_debug
│   ├── commands/               # CLI commands (init, index, analyze, watch, prd, etc.)
│   ├── daemon/                 # Background daemon service
│   │   ├── service.ts          # Express server with REST API
│   │   └── ...
│   ├── prompts/                # LLM prompt templates
│   └── lib/
│       ├── db/                 # Database layer
│       │   ├── schema.ts       # Schema definitions and migrations
│       │   ├── memories.ts     # Memory CRUD operations
│       │   └── retention.ts    # Retention and cleanup
│       ├── storage/            # Multi-backend storage abstraction
│       │   ├── dispatcher.ts   # Routes calls to active backend (124 methods)
│       │   ├── backends/       # SQLite, PostgreSQL implementations
│       │   └── vector/         # Qdrant vector backend
│       ├── tree-sitter/        # AST parsing (13 languages)
│       │   ├── parser.ts       # Language-aware parser
│       │   ├── extractor.ts    # Symbol extraction
│       │   ├── chunker.ts      # AST-aware code chunking
│       │   └── queries/        # Tree-sitter .scm queries per language
│       ├── debug/              # Structured debugging sessions
│       ├── embeddings.ts       # ONNX embeddings with GPU auto-detection
│       ├── config.ts           # Configuration management
│       ├── quality.ts          # Memory quality scoring (local ONNX + LLM)
│       ├── temporal.ts         # Time-weighted scoring, validity periods
│       ├── working-memory-pipeline.ts  # Priority scoring, diversity filter
│       ├── md-fetch.ts         # md.succ.ai client (URL→Markdown)
│       ├── llm.ts              # LLM abstraction (local, OpenRouter, Claude)
│       ├── chunker.ts          # Text/code chunking
│       ├── indexer.ts          # Shared indexing logic
│       ├── lock.ts             # File-based locking
│       └── graph-export.ts     # Obsidian/JSON graph export
├── hooks/                      # Claude Code hook scripts
├── docs/                       # Documentation
├── dist/                       # Compiled JavaScript (generated)
├── package.json
├── vitest.config.ts
├── eslint.config.js
├── .prettierrc
└── tsconfig.json
```
