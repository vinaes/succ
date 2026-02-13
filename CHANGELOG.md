# Changelog

All notable changes to succ will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Tree-sitter AST parsing for 13 languages (TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C, C++, C#, PHP, Ruby, Swift)
- `succ_search_code` MCP tool with regex, symbol_type, and output mode filters
- `succ_symbols` MCP tool for AST symbol extraction
- `succ_debug` structured debugging with hypothesis tracking
- PRD pipeline (`succ prd generate/parse/run/list/status/export`)
- Web search via OpenRouter (quick, standard, deep research)
- Knowledge graph with community detection, centrality, and proximity linking
- AI readiness scoring
- Memory retention with decay-based cleanup
- Checkpoint backup/restore system
- Multi-backend storage (SQLite, PostgreSQL, Qdrant)
- Embedding migration tool
- Session summary and precompute-context for handoff

### Changed
- CLI uses lazy dynamic imports for faster startup
- Memory dedup uses sqlite-vec KNN instead of full table scan
- File I/O in indexer and loggers converted to async
- Worker pool threshold lowered from 32 to 8

### Fixed
- `process.exit()` removed from library modules (now throws errors)
- Debug internals no longer exported from public API
- sqlite-vec pinned to exact version (was using `^` on alpha)

## [1.0.0] - 2025-06-01

### Added
- Initial release
- Semantic search with hybrid BM25 + vector retrieval
- Memory system with tags, temporal validity, and quality scoring
- MCP server for Claude Code, Cursor, Windsurf, Continue.dev
- Brain vault document indexing
- Knowledge graph with auto-linking
- CLI with 38 commands
