# Contributing to succ

Thanks for your interest in contributing to succ! This document covers the basics.

## Development Setup

```bash
git clone https://github.com/Vinaes/succ.git
cd succ
npm install
npm run build
```

## Running Tests

```bash
# Unit tests
npx vitest run

# Storage tests only
npm run test:storage

# Integration tests (requires Claude CLI)
npm run test:integration
```

## Project Structure

```
src/
  cli.ts              # CLI entry point (lazy imports)
  mcp-server.ts       # MCP server entry point
  commands/            # CLI command handlers
  lib/                 # Core library
    storage/           # Storage abstraction (SQLite, PostgreSQL, Qdrant)
    db/                # Database access layer
    tree-sitter/       # AST parsing (13 languages)
    graph/             # Knowledge graph operations
    prd/               # PRD pipeline
    debug/             # Structured debugging
  mcp/tools/           # MCP tool definitions
```

## Code Style

- TypeScript with strict mode
- ESM modules (`.js` extensions in imports, `export type {}` for type-only exports)
- Prettier + ESLint for formatting/linting
- Run `npm run lint` and `npm run format:check` before submitting

## Storage Abstraction

**Never access the database directly.** Always use exports from `src/lib/storage/index.ts`. The storage layer supports SQLite, PostgreSQL, and Qdrant backends.

## Making Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run tests (`npx vitest run`)
5. Run lint (`npm run lint`)
6. Build (`npm run build`)
7. Submit a PR

## Commit Messages

Use conventional commits:

```
feat: add new MCP tool for X
fix: handle edge case in memory search
docs: update configuration guide
refactor: extract helper from dispatcher
```

## Reporting Bugs

Use the [bug report template](https://github.com/Vinaes/succ/issues/new?template=bug_report.yml) to file issues.

## License

By contributing, you agree that your contributions will be licensed under the FSL-1.1-Apache-2.0 license.
