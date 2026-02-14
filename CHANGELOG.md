# Changelog

All notable changes to succ will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-02-14

### Added
- Session start hook `<architecture>` section — inlines Architecture Overview from brain vault, categorized doc index
- `<pinned-memories>` section in session start — Tier 1 memories (non-observation, top-10 by priority score)
- `GET /api/pinned` and `POST /api/pinned/cleanup` daemon endpoints using storage abstraction
- `succ_fetch` MCP tool — web page fetching via md.succ.ai with Readability + Playwright
- Multi-language invariant detection — Russian, German, French, Spanish, Chinese, Japanese, Korean
- Pattern/learning reinforcement — correction_count incremented on near-duplicate saves instead of skipping
- Process registry with WebSocket idle timeout and graceful CLI shutdown

### Fixed
- Invariant detection no longer runs on observation-type memories (eliminated false positives from subagent reports)
- Semantic dedup threshold for synthesized reflections raised to 0.80
- Reflection synthesizer correctly marks observations as reflected
- Negative cosine clamping in specificity scoring, hardened temporal LLM fallback

## [1.2.0] - 2026-02-13

### Added
- **Tree-sitter AST parsing** for 13 languages with full symbol extraction (TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C, C++, C#, PHP, Ruby, Swift) + 7 additional languages at grammar level (Scala, Dart, Bash, Lua, Elixir, Haskell, SQL)
- `succ_symbols` MCP tool — AST symbol extraction via tree-sitter
- `succ_search_code` MCP tool with `regex`, `symbol_type`, and `output_mode` (full/lean/signatures) filters
- AST-aware BM25 tokenization and static project profiling
- AST chunker as default code indexer with regex fallback
- Enriched embeddings with symbol metadata through BM25 update chain
- Embedding CLI commands and auto-dimension migration for all backends
- `succ_analyze_file` — recursive chunk-analyze-synthesize for large files
- LongMemEval benchmark runner for recall pipeline evaluation

### Changed
- Code search no longer returns brain vault documents
- Symbol metadata (name, type, signature) stored in PostgreSQL documents table
- Qdrant payload includes symbol metadata for filtered search

### Fixed
- Signatures output mode skips JSDoc/comment lines in fallback chunker
- Wikilinks no longer generated inside Mermaid blocks in analyzed docs

## [1.1.0] - 2026-02-12

### Added
- **Working memory pipeline** — validity filtering, scored ranking, priority scoring, tag weights, confidence decay, diversity filter, immutability guards
- Working memory Tier 1 pins — `is_invariant` detection, `correction_count`, two-phase fetch
- **Config-driven retrieval** — mid-session observer, reflection synthesis, temporal decomposition
- **Daemon** — smart supersession, token budget, session observations, `setDb` isolation
- **PRD pipeline** — generate, parse, run with branch isolation, quality gates, resume, team mode with git worktrees
- PRD workflow export to Obsidian with Mermaid diagrams (Gantt timeline, dependency DAG)
- Config-driven quality gates with per-subdirectory overrides, monorepo detection
- **Web search** MCP tools — `succ_web_search` (Perplexity Sonar Pro), `succ_deep_research` (Deep Research), `succ_quick_search` (Sonar, ~$1/MTok)
- Web search history — DB storage, history tool, status integration, configurable models (Grok, Gemini, GPT)
- **`succ_debug`** MCP tool + agent — structured debugging with hypothesis tracking, instrumentation, language detection
- **Knowledge graph enrichment** — LLM-powered relations, proximity linking, community detection, centrality scoring
- Graph enrichment during idle reflection
- **20 Claude Code subagents** — explore, plan, general, code-reviewer, diff-reviewer, memory-curator, pattern-detective, session-handoff, debug, knowledge-mapper, context-optimizer, quality-coach, readiness-improver, session-reviewer, decision-auditor, deep-search, checkpoint-manager, memory-health, knowledge-indexer, style-tracker
- `succ-style-tracker` agent — haiku-powered communication style adaptation with brain vault logging
- `soul.md` communication preferences with auto-adapt config toggle
- TDD enforcement in succ-plan agent with red-green-refactor cycles
- Code-reviewer + diff-reviewer agents with OWASP Top 10 checklist
- `succ_reindex` MCP tool — detect stale/deleted files, re-index modified, clean deleted
- Code index freshness detection and daemon status in CLI
- Index freshness metric in AI-readiness score
- Readiness gate — confidence assessment for search results
- Stable public API barrel export (`succ/api`) with all tool exports
- `PreToolUse` hook — command safety guard + commit context injection
- Auto-save web search results and agent outputs to memory
- Auto-track session counters for learning deltas
- Dead-end tracking (`succ_dead_end`), retention scoring, AGENTS.md export

### Changed
- `succ_link` MCP tool now supports `export` action for Obsidian
- Checkpoint includes `llm_enriched` links and centrality scores
- Agent output rule: key findings to memory, research to `.succ/brain/` as Obsidian markdown
- Two-tier memory guidance — MEMORY.md as hot cache, succ as long-term store

### Fixed
- Dedup race condition in daemon `/api/remember`
- `getDaemonStatuses` reads correct PID path
- `ON CONFLICT` for memory_links insert instead of catch
- PRD runner — vitest watch mode, gate output truncation, retry bloat, dirty tree reset
- Team mode bugs — worktree cleanup, stash pop, gate PATH
- Daemon recall searched documents instead of memories
- Integration test flakiness on Windows and Qdrant

## [1.0.1] - 2026-02-04

### Added
- **Multi-backend storage** — SQLite, PostgreSQL, Qdrant with `project_id` scoping
- Global memory support for PostgreSQL and Qdrant
- **Onboarding system** with unified chat LLM
- **Sensitive info filter** — redactpii + entropy detection, phone patterns (RU/BY/generic)
- **Quality scoring** for memories with hybrid ONNX approach
- **Idle watcher** — smart activity-based reflections
- **Sleep agent** — dual-agent idle-time compute (consolidation, session summary, precompute context)
- Reflections as separate files with YAML frontmatter
- Global hooks installation mode
- Local LLM support for `succ analyze`
- Commit attribution guidelines in session-start hook
- Auto-detect embedding dimension mismatch with reindex offer
- Soft-delete consolidation with undo and config safety

### Changed
- Renamed sandbox to daemon, added watch locking
- CLI uses lazy dynamic imports for faster startup
- Memory dedup uses sqlite-vec KNN instead of full table scan
- File I/O in indexer and loggers converted to async
- Worker pool threshold lowered from 32 to 8
- All `shell: true` replaced with `cross-spawn` for security
- LLM/embedding backend config unified into `llm.*` namespace
- `db.ts` modularized into 15 focused modules
- `mcp-server.ts` modularized into 11 focused tool modules
- Heavy LLM operations made async/detached in idle hook

### Performance
- Prepared statement caching, BM25 pagination, rawContent optimization
- SQLite tuning, embedding batch, search optimization, config cache
- N+1 query fix in session processor (95% reduction)
- RAM usage for indexing reduced from 10GB+ to ~500MB

### Fixed
- `process.exit()` removed from library modules (now throws errors)
- Debug internals no longer exported from public API
- sqlite-vec pinned to exact version (was using `^` on alpha)
- Memory consolidation no longer silently destroys memories
- Batch memory delete functions clean `vec_memories_map`
- Daemon recall no longer searches documents table
- CVE fix: `@modelcontextprotocol/sdk` bumped to 1.26.0
- Skip interactive prompts in non-TTY mode (MCP compatibility)
- Windows compatibility: `windowsHide` on all spawn calls

## [1.0.0] - 2025-06-01

### Added
- Initial release
- Semantic search with hybrid BM25 + vector retrieval
- Memory system with tags, temporal validity (valid_from, valid_until, as_of_date)
- MCP server for Claude Code, Cursor, Windsurf, Continue.dev
- Brain vault document indexing with frontmatter support
- Knowledge graph with auto-linking and Obsidian export
- CLI with 38 commands
- AI-readiness scoring for project health assessment
- Checkpoint backup/restore system
- Memory retention with decay-based cleanup
- Token cost estimation and savings tracking
- Temporal awareness — time-scoped queries, decay scoring
- Advanced benchmark metrics (Recall@K, MRR, NDCG)
- sqlite-vec migration for 20-30x vector search speedup
- WAL mode and BM25 index for global memories
- LLM extraction and LLM-based memory merge for consolidation
- Unified daemon with parallel operations
- Local embeddings via Transformers.js with custom API support
- Auto-generate Obsidian graph colors and temporal params on export
