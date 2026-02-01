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

| Module | Tests | Coverage |
|--------|-------|----------|
| `lib/lock.ts` | 14 | Lock acquisition, release, concurrency, stale detection |
| `lib/chunker.ts` | 27 | Text/code chunking for TS, JS, Python, Go, Rust |
| `lib/config.ts` | 15 | Configuration loading, paths, overrides |
| `lib/db.ts` | 23 | Documents, memories, knowledge graph, global DB |
| `lib/graph-export.ts` | 11 | JSON/Obsidian export, wiki-links |
| `commands/analyze.ts` | 13 | Multi-file output, daemon state, brain structure |
| `commands/watch.ts` | 9 | PID files, debouncing, race conditions |
| Integration | 9 | CLI commands, MCP server, daemon |

**Total: 242+ tests**

Tests are designed to:
- Use isolated temp directories to avoid affecting real data
- Mock heavy dependencies (embeddings, external APIs)
- Test concurrent scenarios and race conditions
- Verify Windows compatibility (file locking, paths)

## Project Structure

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
│   │   ├── analyze.ts      # succ analyze (+ daemon mode)
│   │   ├── watch.ts        # succ watch
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
│       ├── lock.ts         # File-based locking for daemon mode
│       └── graph-export.ts # Export memories to Obsidian/JSON
├── docs/                   # Documentation
├── dist/                   # Compiled JavaScript (generated)
├── package.json
├── vitest.config.ts        # Vitest configuration
├── eslint.config.js        # ESLint flat config
├── .prettierrc             # Prettier config
└── tsconfig.json
```
