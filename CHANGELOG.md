# Changelog

All notable changes to succ will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - 2026-03-09

### Added
- **Cross-encoder reranker** — ONNX-based cross-encoder (ms-marco-MiniLM-L-6-v2) reranks hybrid search results by scoring (query, document) pairs for relevance. Configurable weight, min results, max doc chars. Graceful degradation on failure
- **HyDE (Hypothetical Document Embeddings)** — generates hypothetical code snippets via LLM for natural language queries, embeds them to bridge the NL↔code embedding gap. Uses tree-sitter AST to detect code queries and skip HyDE
- **Late chunking** — embeds full file with long-context model (e.g., jina 8192 tokens), pools per-token hidden states by AST chunk boundaries for context-aware chunk embeddings
- **Hierarchical summaries (RAPTOR-style)** — bottom-up LLM summarization at file → directory → module → repo zoom levels. Query routing via `inferSummaryLevel()` matches query specificity to the right zoom
- **Code-specific embedding models** — support for jina-embeddings-v2-base-code (768d, 8192 ctx), nomic-embed-code, BGE-M3 with configurable `max_length` per model
- **Graph algorithms** — Personalized PageRank (PPR) retrieval, Tarjan's SCC for circular dependency detection, articulation point (bridge) analysis for architectural bottlenecks, community summaries via LLM
- **Retrieval feedback loop** — tracks search result clicks/usage, adjusts future ranking based on historical relevance signals
- **Observability pipeline** — structured logging of search latency, embedding times, LLM calls; recall analytics with per-query metrics stored in SQLite
- **Auto-memory extraction** — session-end fact extraction via LLM with quality gate + periodic consolidation (merge duplicates, promote high-usage)
- **Repo map** — generates tree-style project structure maps for LLM context
- **Cross-repo search** — search across multiple succ-indexed repositories
- **Diff-brain analysis** — LLM-powered diff analysis for brain vault document changes
- **LSP client infrastructure** — language server protocol client, installer, and server registry for code intelligence
- **MCP review tool** — `succ_review` for code review via MCP
- **Bridge edges** — cross-graph edges connecting code graph and memory graph
- **Co-change analysis** — git log mining to detect files frequently changed together
- **Session surgeon** — session analyzer (token breakdown by type + tool name, cut points) and surgeon (trim tool content, thinking, images; manual compact with UUID chain integrity). PreCompact hook auto-saves stats, SessionStart displays before/after delta table after compact. CLI: `succ session analyze|trim|trim-thinking|trim-all|compact`

### Changed
- `generateHyDE()` uses tree-sitter AST parsing instead of regex heuristics for code detection — more accurate, zero false positives on natural language
- `NativeOrtSession` accepts configurable `maxLength` (was hardcoded 128) for long-context embedding models
- `NativeOrtSession` exports `embedRaw()` for per-token hidden states and `getTokenOffsets()` for token position mapping
- PPR algorithm precomputes weighted degrees for O(E) total instead of O(E) per neighbor per iteration
- Reranker uses failure memoization — `rerankerInitFailed` flag prevents retrying initialization on every search call
- `db.prepare()` used instead of `cachedPrepare` for dynamic SQL with variable placeholder counts in recall-events

### Fixed
- `diff-brain`: removed `--` separator before diffRef in execFileSync (was treating revision as file path)
- `execSync` → `execFileSync` in review context-pack and co-change analysis (command injection prevention)
- All empty catch blocks replaced with `logWarn()` per NO SILENT CATCH convention
- `inferSummaryLevel`: directory-level indicators checked before repo-level (fixes "describe this folder" → repo)
- `inferSummaryLevel`: camelCase regex fixed from `/[A-Z][a-z]+[A-Z]/` to `/[a-z][A-Z]/` (matches "hashPassword")
- `getTokenOffsets`: passes `[text]` (array) for consistency with `embedRaw` 2D tensor output
- Iterative Tarjan DFS replaces recursive implementation (avoids stack overflow on large graphs)

## [1.4.10] - 2026-03-06

### Added
- **Multi-layered security hardening** — 3-tier prompt injection detection (structural patterns → multilingual regex + semantic embedding → LLM classification), Bell-LaPadula information flow control with 4 security levels + 4 compartments, content sanitization across 13 entry points, +35 command safety patterns across 10 categories
- **HTTP hooks + PermissionRequest** — daemon handles hooks via HTTP POST (Claude Code v2.1.63+), auto-approve/deny permission dialogs via hook-rules (`type="allow"` skips dialog, `type="error"` blocks), deterministic daemon port from SHA-256(projectDir)
- **Multi-agent support** — shared adapter module normalizes hook I/O for Cursor, GitHub Copilot, and Gemini CLI; `succ setup cursor|copilot|gemini` installation commands
- **PostgreSQL full-text search** — `tsvector` column + GIN indexes, `ts_rank_cd` text scoring fused with pgvector cosine via RRF; all 8 BM25 dispatcher methods properly branch on PG backend
- **Codex integration** — `succ setup codex` configures MCP + project trust, `succ codex` generates AGENTS.md with fresh succ context then spawns codex
- **`succ init` copies hooks/core/ shared modules** — adapter, daemon-boot, and shared utils bundled with project hooks

### Changed
- Storage dispatcher decomposed: 2698-line monolith → 14 mixin modules in `src/lib/storage/dispatcher/`
- Daemon service decomposed: 1710-line monolith → 9 route modules in `src/daemon/routes/`
- ~116 `any` types eliminated via typed interfaces, `unknown`, boundary parsing
- Zod validation on all 28 daemon API routes with 10MB body limit
- 185 generic logWarn messages → descriptive context-specific messages
- ESLint upgraded 9 → 10, all lint errors fixed, npm audit vulnerabilities resolved
- Replaced `@iarna/toml` (unmaintained, CJS) with `smol-toml` (ESM, typed)
- Removed `node-pty` dependency (native C++ build requirement eliminated)

### Fixed
- 31 CodeQL alerts addressed across 6 categories
- Subdomain spoofing in URL hostname checks prevented
- Skill suggestions always failing with fetch error
- Daemon startup error logging in session-start hook
- IFC step counting, tag validation, chunk sampling (CodeRabbit review)
- `console.log` → `logInfo` across codebase, magic numbers extracted to constants

## [1.4.0] - 2026-02-20

### Breaking Changes
- **31 MCP tools consolidated into 14** — related tools merged behind `action` parameters. No aliases for old tool names. See [Migration Guide](docs/mcp.md) for consolidation map
- **Tool profiles updated** — `core` (8 tools), `standard` (12), `full` (14)

### Added
- **Tool consolidation** — `succ_status` (overview/stats/score), `succ_config` (show/set/checkpoint_*), `succ_index` (doc/code/analyze/refresh/symbols), `succ_link` (+explore, +cleanup), `succ_fetch` (+schema extraction), `succ_prd` (generate/list/status/run/export), `succ_web` (quick/search/deep/history)
- **Per-action profile gating** — `gateAction()` restricts expensive actions within consolidated tools (e.g., `succ_web` deep/history require `full` profile)
- **Prompt registry** — all ~45 prompt constants centralized in `src/prompts/`, zero inline prompts remaining
- **`cache_control` support** — `callApiLLM` auto-enables Anthropic prompt caching for system messages
- **`systemPrompt` in `callLLM`/`callApiLLM`** — dedicated `{role: "system"}` message for LLM prompt caching; all 16 prompt call sites split into `*_SYSTEM` + `*_PROMPT`
- **`auto` tool profile** (new default) — detects client via `getClientVersion()`, Claude clients get `full`, others get `standard`
- **ToolAnnotations** on all 14 tools — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`
- **`succ_fetch` schema extraction** — `schema` parameter triggers structured data extraction via LLM with JSON Schema validation
- **md.succ.ai health check** in `succ_status` overview — pings `/status` (3s timeout), reports service availability
- **Global error handler** in CLI — clean one-line messages instead of stack traces (`DEBUG=1` for full trace)
- **Centralized project init guard** in `getDb()` — clear "Run `succ init` first" message instead of opaque SQLite errors
- `getPinnedMemories` and `HybridMemoryResult` exported from public API
- `extract` parameter on search tools for smart result compression
- 28 tests for profile gating, LLM systemPrompt tests

### Changed
- MCP SDK upgraded 1.26.0 → 1.27.0; all tools migrated from `server.tool()` to `server.registerTool()`
- Test audit: removed tests that duplicate type system guarantees, test implementation details, or check internal arg shapes (8 test files cleaned)
- ~140 lines dead code removed from `session-processor.ts`
- `closeStorageDispatcher()` called in config checkpoint to release PG/Qdrant connections

### Fixed
- Template injection in `extractAnswerFromResults` (replace order + function callbacks)
- PG integration tests: dynamic embedding dimensions from `getEmbeddingInfo()` instead of hardcoded 384
- `succ_fetch` schema validation: reject non-object schemas (primitives, arrays)
- `succ_fetch` respects `format="json"` in schema extraction path

### Dependencies
- `@modelcontextprotocol/sdk` 1.26.0 → 1.27.0

## [1.3.31] - 2026-02-16

### Added
- **Dynamic hook rules from memory** — memories tagged `hook-rule` automatically become pre-tool rules; filter by `tool:{Name}` and `match:{regex}` tags; action derived from memory type (`error`=deny, `pattern`=ask, else=inject as additionalContext)
- **File-linked memories** — `succ_remember` accepts `files` parameter; memories auto-recalled when editing linked files via pre-tool hook
- `POST /api/hook-rules` daemon endpoint with 60s cache and automatic invalidation on new hook-rule saves
- `POST /api/recall-by-tag` daemon endpoint for tag-based memory retrieval
- `getMemoriesByTag()` storage function for efficient tag-based lookups
- ReDoS guard — regex patterns from hook-rule tags capped at 200 characters
- Hook-rules convention documented in session-start hook and MCP `succ_remember` tool description
- `fetchAsMarkdown` exported from public API
- 21 unit tests for hook-rules matching logic

### Changed
- Pre-tool hook refactored from early-exit to `contextParts[]` accumulator — hook rules, file-linked memories, and commit format context can now coexist in a single `additionalContext` output
- Pre-tool hook extracted `getDaemonPort()` helper to deduplicate port-reading logic
- Web search tools use `OPENROUTER_API_KEY` env var (not generic `llm.api_key`)
- Web search tools conditionally shown based on API key availability
- Lint + format checks added to build pipeline (`prettier --check && eslint && tsc`)
- All ESLint warnings fixed across codebase

### Fixed
- Windows CI — `.gitattributes` enforces LF line endings, `endOfLine: "lf"` in `.prettierrc`, `prepare` script runs only `tsc` (not prettier+eslint)
- `tool_input` type guard in `/api/hook-rules` — non-object input safely defaults to `{}`
- ONNX model download uses `AutoModel` instead of `AutoTokenizer`
- Lowercase GitHub org in `package.json` for npm provenance
- Package renamed to `@vinaes/succ` for npm org publishing

## [1.3.15] - 2026-02-16

### Added
- **Auto-archive on supersedes** — memories linked with `relation=supersedes` are automatically tagged `superseded` and routed to `archive/` in brain vault; stale files cleaned up on re-export
- `succ_extract` MCP tool — structured data extraction from URLs using JSON schema + LLM
- `succ_fetch` `mode=fit` (default) — Readability-based content pruning for 30-50% fewer tokens
- `succ_fetch` `links=citations` — inline links converted to numbered references with footer
- **Graph cleanup pipeline** — `graphCleanup()` combines prune, enrich, reconnect orphans, rebuild communities + centrality in one call
- Session hook tool documentation section for `succ_fetch` and `succ_extract`

### Changed
- Brain vault flat structure — removed numbered prefixes (`00_Inbox` → `inbox`, `01_Projects/<name>/` → `project/`, `02_Knowledge` → `knowledge`, etc.)
- Removed dead directories: `.self/` (unused since Feb 2), `06_Evolution/` (zero references)
- Fixed `Reflections` → `reflections` case inconsistency (Linux/macOS compatibility)
- Daemon idle reflection refactored to use `graphCleanup()` pipeline
- `succ init` onboarding updated — multi-editor support, new brain vault dirs, current feature list
- `succ_fetch` defaults to `mode=fit` instead of `mode=full`
- Author updated to vinaes

### Fixed
- `callLLM` respects WebSocket transport — unblocks nested Claude CLI spawn
- Retry with exponential backoff for md.succ.ai fetch failures
- Obsidian export paths updated to match new lowercase directory names
- Test data sanitized for public release, npm package cleanup

### Dependencies
- `better-sqlite3` 11.10.0 → 12.6.2
- `glob` 10.5.0 → 13.0.3
- `ora` 9.1.0 → 9.3.0
- `commander` → 14.0.3
- `@types/node` → 25.2.3

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
