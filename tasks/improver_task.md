# succ Improver Agent — Research-Driven Implementation Plan v2

> Generated 2026-03-27. Validated against full codebase audit (search, graph, storage, hooks).
> Only contains improvements that DO NOT already exist. All existing systems verified.
> Reference: `docs/plan-roadmap-v2.md` for full architectural context.

## CRITICAL: What Already Exists (DO NOT REIMPLEMENT)

Before implementing anything, understand that succ already has:
- **Cross-encoder reranker**: `src/lib/reranker.ts` (ms-marco-MiniLM-L6-v2, blend 0.7/0.3)
- **HyDE**: `src/lib/search/hyde.ts` (generates hypothetical code, embeds it)
- **Query expansion**: `src/lib/query-expansion.ts` (LLM generates 5 alternatives)
- **Late chunking**: `src/lib/search/late-chunking.ts` (Jina/Nomic 8192 ctx supported)
- **PPR retrieval**: `src/lib/search/ppr-retrieval.ts` + `src/lib/graph/graphology-bridge.ts`
- **Louvain communities**: `graphology-bridge.ts` with label propagation fallback
- **Community summaries**: `src/lib/graph/community-summaries.ts` (GraphRAG-style LLM summaries)
- **RAPTOR hierarchical summaries**: `src/lib/search/hierarchical-summaries.ts` (4 levels)
- **Repo map**: `src/lib/search/repo-map.ts` (tree-sitter AST symbols)
- **MMR diversity**: `src/lib/mmr.ts` (lambda=0.8)
- **Temporal decay**: `src/lib/temporal.ts` (exponential, 7-day half-life, access boost)
- **Retrieval feedback**: `src/lib/retrieval-feedback.ts` (boost factors 0.7-1.3)
- **Bridge edges**: `src/lib/graph/bridge-edges.ts` (documents/bug_in/test_covers/motivates)
- **Memory consolidation**: `src/lib/consolidate.ts` (Union-Find + LLM merge + undo)
- **Quality scoring**: `src/lib/quality.ts` (ONNX + heuristic + API modes)
- **Articulation points**: Tarjan's in graphology-bridge.ts
- **Betweenness centrality**: graphology-metrics
- **valid_from/valid_until**: Already on memories AND links tables
- **confidence + source_type**: Already in memory schema
- **Two-phase auto-extraction**: post-tool + session-end + mid-session observer
- **Reflection synthesizer**: Pattern extraction from memory clusters
- **Working memory pipeline**: Priority scoring with pinned tier + scored recency

**If you encounter any of these, EXTEND/TUNE them — do NOT rewrite.**

---

## Research Findings (for context)

### Supermemory (#1 on LongMemEval, 81.6%)
- Key win: **Atomic Memory Extraction** + **Relational Versioning** (updates|extends|derives)
- Dual temporal grounding (documentDate + eventDate)
- Memory-then-Chunk retrieval (search facts, inject source context)

### mem0 (+26% over OpenAI Memory)
- Two-phase LLM: extract facts → ADD/UPDATE/DELETE decision against existing memories
- UUID-to-integer mapping trick for LLM consolidation
- Soft-delete graph edges (valid=false + invalidated_at)

### RAG SOTA 2025-2026
- Contextual embeddings: +35-49% recall (Anthropic technique)
- Query decomposition: +10-25% on complex queries
- Query-adaptive fusion: code→BM25, NL→vector weighting

---

## Implementation Rotation (12 areas, `(hour_utc / 2) % 12`)

### Area 0: Contextual Embeddings (Anthropic-style)

**Gap**: Chunks are embedded without semantic context. `enrichForEmbedding()` only prepends `[type: symbolName(signature)]` — structural, not semantic.

**What exists**: `src/lib/indexer.ts` → `enrichForEmbedding()` in chunker. Tree-sitter AST metadata.

**Improvement**: Add LLM-generated semantic context before embedding.
- For each chunk: `callLLM("Given this file:\n{file_top_200_lines}\n\nDescribe what this code chunk does in 1 sentence:\n{chunk}")`
- Prepend to chunk before embedding: `"[Context: {LLM_description}]\n[type: symbolName(signature)]\n{content}"`
- Store both original and contextualized content; embed the contextualized version
- Gate behind config: `indexing.contextual_embeddings: true`
- Use cheapest LLM (haiku/gpt-4o-mini). Use prompt caching for same-file chunks
- **Files to modify**: `src/lib/indexer.ts`, `src/lib/config-types.ts`, `src/lib/config-defaults.ts`
- **DO NOT touch**: `src/lib/tree-sitter/chunker.ts` (it's fine), `src/lib/embeddings.ts` (no changes needed)

---

### Area 1: Memory Versioning (supermemory-style)

**Gap**: `supersedes` link type exists but no version chain tracking. No `isLatest` flag. Contradictions caught only during consolidation (post-hoc), not at ingestion.

**What exists**: `invalidated_by` field, `supersedes` link type, consolidation with `determineAction()`.

**Improvement**: Add version chains with ingestion-time contradiction detection.
- New schema fields on memories: `version INT DEFAULT 1`, `parent_memory_id INT NULL`, `root_memory_id INT NULL`, `is_latest BOOLEAN DEFAULT true`
- New link relation types: `updates` (replaces), `extends` (adds detail), `derives` (inferred)
- At `saveMemory()` time: search top-3 similar existing memories (>0.85 cosine)
  - If found: call LLM to classify relationship as `updates|extends|derives|none` (mem0's approach)
  - If `updates`: set old memory `is_latest=false`, create `updates` link, inherit `root_memory_id`
  - If `extends`: create `extends` link, both stay `is_latest=true`
  - UUID-to-integer mapping trick before LLM call (from mem0)
- Modify `succ_recall` to prefer `is_latest=true` memories
- **Files to modify**: `src/lib/db/schema.ts`, `src/lib/storage/backends/sqlite.ts`, `src/lib/storage/backends/postgresql.ts`, `src/lib/storage/dispatcher/memories.ts`, `src/lib/storage/types.ts`
- **DO NOT touch**: `src/lib/consolidate.ts` (existing consolidation stays, this is complementary)

---

### Area 2: Query Decomposition

**Gap**: No query splitting for complex queries. Query expansion exists but only adds synonyms, not sub-queries.

**What exists**: `src/lib/query-expansion.ts` (synonym expansion), `src/lib/search/hyde.ts` (hypothetical code).

**Improvement**: Detect and decompose multi-concept queries.
- Detection heuristic: >15 words, contains "and"/"but"/"or", asks about multiple entities
- LLM decomposition: "Split into 2-3 focused sub-queries: {query}" → `["sub1", "sub2"]`
- Parallel retrieval for each sub-query → merge via RRF
- Gate behind `standard` profile (1 LLM call per search)
- **New file**: `src/lib/search/query-decomposition.ts`
- **Modify**: `src/lib/db/hybrid-search.ts` to optionally decompose before searching
- **DO NOT touch**: `src/lib/query-expansion.ts` (complementary, not replacement)

---

### Area 3: Query-Adaptive Fusion + RRF Tuning

**Gap**: RRF K=60 is hard-coded in `bm25.ts`. Same alpha (0.5) for all query types. No query-type detection.

**What exists**: `src/lib/bm25.ts` (RRF_K=60 constant), `src/lib/db/hybrid-search.ts` (alpha=0.5).

**Improvement**:
1. Make RRF K configurable (add to search config). Research suggests K=20-40 better for code.
2. Query-type detection (regex-based, zero LLM cost):
   - Identifier-like (PascalCase, snake_case, dot.notation, contains `()`) → alpha=0.3 (boost BM25)
   - Natural language question (starts with how/what/why/when, >5 words) → alpha=0.7 (boost vector)
   - Mixed/default → alpha=0.5
3. Expose alpha override in `succ_search` and `succ_search_code` params
- **Files to modify**: `src/lib/bm25.ts` (make K configurable), `src/lib/db/hybrid-search.ts` (query classification + adaptive alpha), `src/lib/config-types.ts`
- **DO NOT touch**: BM25 tokenizers, scoring formula, exact match boost (all working well)

---

### Area 4: Graph as Third RRF Signal

**Gap**: PPR retrieval exists (`ppr-retrieval.ts`) but runs as a SEPARATE pipeline. Not integrated into main hybrid search RRF fusion.

**What exists**: `src/lib/search/ppr-retrieval.ts` (standalone), `src/lib/db/hybrid-search.ts` (BM25+vector RRF).

**Improvement**: Wire graph traversal into the main search pipeline as a third signal.
- After BM25+vector retrieval returns top-50:
  1. Extract memory IDs from results
  2. Run PPR from those seed nodes (1-hop expansion)
  3. Add PPR-discovered nodes to result set
  4. Three-signal RRF: `score = 1/(K+rank_bm25) + 1/(K+rank_vector) + weight_graph/(K+rank_ppr)`
  5. Graph weight = 0.3 by default (configurable)
- Only for memory search (code search doesn't have graph yet)
- **Files to modify**: `src/lib/db/hybrid-search.ts` (add graph signal to `hybridSearchMemories`)
- **DO NOT touch**: `src/lib/search/ppr-retrieval.ts` (keep as standalone too), `graphology-bridge.ts`

---

### Area 5: Memory-then-Chunk Retrieval

**Gap**: `succ_recall` returns memory content directly. No link back to source conversation/code that originated the memory. No two-stage retrieval.

**What exists**: Memory content, tags, source field. Session observations JSONL (temporary).

**Improvement**: Store source context references and implement two-stage retrieval.
- New schema field: `source_chunk TEXT NULL` — stores snippet of original context (conversation excerpt, code chunk) that produced the memory
- At `saveMemory()` time (in hooks/daemon): pass source context alongside content
- Modify `succ_recall` to return `{memory, source_context}` — the atomic fact PLUS its supporting detail
- The LLM gets both precise facts (search target) and full context (reasoning support)
- **Files to modify**: `src/lib/db/schema.ts`, `src/lib/storage/backends/*`, `src/lib/storage/dispatcher/memories.ts`, `src/mcp/tools/memory/recall.ts`
- **Also modify**: `hooks/succ-post-tool.cjs` and session-end processor to pass source context

---

### Area 6: Confidence Auto-Degradation + Automatic Forgetting

**Gap**: `confidence` stays at 0.5 forever unless manually promoted. No `forgetAfter` mechanism. Stale auto-extracted memories accumulate.

**What exists**: `confidence` field, `access_count`, `last_accessed`, `valid_until` (but not used for auto-forgetting), consolidation pruning (90-day unused).

**Improvement**:
1. **Confidence degradation**: On each recall, if memory NOT used (retrieval-feedback `wasUsed=false`), decay confidence by 0.05. If used, boost by 0.02 (cap at 0.95).
2. **Automatic forgetting**: New field `forget_after TEXT NULL` (ISO date). At consolidation time, delete memories past their forget date.
   - Auto-extracted memories: `forget_after = created_at + 90 days` (unless promoted)
   - Promoted memories (confidence > 0.7 or access_count > 5): `forget_after = NULL` (permanent)
3. **Contradiction-based forgetting**: When memory versioning (Area 1) detects `updates` relationship, set old memory `forget_after = NOW + 30 days` (grace period, not instant delete)
- **Files to modify**: `src/lib/retrieval-feedback.ts`, `src/lib/auto-memory/consolidation.ts`, `src/lib/db/schema.ts`, `src/lib/storage/backends/*`
- **DO NOT touch**: `src/lib/temporal.ts` (decay works fine), `src/lib/retention.ts` (complementary)

---

### Area 7: mem0-style Fact Extraction Enhancement

**Gap**: Current session-end extraction uses `SESSION_PROGRESS_EXTRACTION_PROMPT` — extracts facts but doesn't compare against existing memories for ADD/UPDATE/DELETE decisions.

**What exists**: `src/daemon/session-processor.ts` (processSessionEnd), `src/lib/session-summary.ts` (extractFactsFromContent), batch save with 0.9 dedup threshold.

**Improvement**: Add mem0's consolidation decision step between extraction and storage.
- After Phase 1 (fact extraction), before saving:
  1. For each extracted fact: embed and search top-5 similar existing memories
  2. Remap real IDs to sequential integers (mem0 trick — prevents LLM UUID hallucination)
  3. Call LLM with existing memories + new facts → decide ADD/UPDATE/DELETE/NONE per fact
  4. ADD: save as new memory
  5. UPDATE: modify existing memory content, increment version (Area 1)
  6. DELETE: set `forget_after = NOW` on contradicted memory
  7. NONE: skip (already known)
- This replaces raw dedup-by-similarity with intelligent consolidation
- **Files to modify**: `src/daemon/session-processor.ts`, `src/lib/session-summary.ts`
- **New file**: `src/lib/auto-memory/extraction-consolidation.ts` (the ADD/UPDATE/DELETE logic)
- **DO NOT touch**: `hooks/succ-post-tool.cjs` (real-time capture stays as-is), `src/lib/consolidate.ts` (batch consolidation stays)

---

### Area 8: Bi-Temporal Enhancement for Documents

**Gap**: Memories have `valid_from`/`valid_until`. Documents DON'T — they only have `created_at`/`updated_at`. No `superseded_at` for tracking re-indexing. No `as_of` for document queries.

**What exists**: Document schema has `created_at`, `updated_at`. Memory schema has full temporal support.

**Improvement**: Add system time tracking to documents for code evolution queries.
- New document fields: `git_commit_date TEXT NULL` (event time), `superseded_at TEXT NULL` (system time)
- On re-indexing a file:
  1. Set `superseded_at = NOW()` on old chunks (don't delete)
  2. Create new chunks with `git_commit_date` from `git log --format=%ai -1 {file}`
  3. Default search: `superseded_at IS NULL` (current code only)
  4. Historical mode: `succ_search_code(as_of="2026-03-01")` returns code state at that date
- Retention: keep superseded chunks for 30 days, then purge
- **Files to modify**: `src/lib/db/schema.ts`, `src/lib/storage/backends/*`, `src/lib/indexer.ts`, `src/lib/db/hybrid-search.ts`
- **DO NOT touch**: Memory temporal fields (already complete)

---

### Area 9: PostgreSQL + Qdrant Performance

**Gap**: No connection pooling for PG. Default Qdrant HNSW params. No query optimization.

**What exists**: `pg` client (no pool), Qdrant client with default config, sqlite with WAL mode.

**Improvement**:
1. **PG connection pooling**: Replace single `pg.Client` with `pg.Pool` (max 10 connections, idle timeout 30s)
2. **Prepared statements**: Cache frequent queries (search, recall, upsert) as prepared statements
3. **Qdrant optimization**:
   - Set `hnsw_config.m = 32, ef_construct = 200` for better recall
   - Enable scalar quantization for faster search with minimal quality loss
   - Add payload indexes on `project_id`, `source_type`, `is_latest`
4. **PG indexes**: Add composite indexes on `(project_id, source_type, is_latest)`, GIN on tags
5. **Query analysis**: Add `EXPLAIN ANALYZE` logging for queries >100ms
- **Files to modify**: `src/lib/storage/backends/postgresql.ts`, `src/lib/storage/vector/qdrant.ts`, `src/lib/db/schema.ts`
- **DO NOT touch**: SQLite backend (already optimized with WAL + busy_timeout)

---

### Area 10: Memory Mutation Audit Trail

**Gap**: No history of memory edits/corrections. Can't answer "what changed in this memory over time?"

**What exists**: `invalidated_by` field, `supersedes` links, consolidation undo. But no structured edit history.

**Improvement**: Create audit trail table.
- New table `memory_audit`:
  ```sql
  id, memory_id, event_type (create|update|delete|merge|version),
  old_content, new_content, changed_by (hook|user|consolidation|extraction),
  created_at
  ```
- Hook into: `saveMemory`, `updateMemory`, consolidation, memory versioning
- Expose via `succ_recall(id, history=true)` — returns memory + its edit history
- Retention: 90 days, then purge audit records
- **Files to modify**: `src/lib/db/schema.ts`, `src/lib/storage/backends/*`, `src/lib/storage/dispatcher/memories.ts`
- **New file**: `src/lib/storage/dispatcher/audit.ts` (mixin)

---

### Area 11: Retrieval Benchmark Suite

**Gap**: No automated way to measure if improvements actually help. No regression detection.

**What exists**: `src/lib/benchmark.ts` (basic indexing/search benchmarks). Manual testing.

**Improvement**: Automated retrieval quality measurement.
- **Test corpus**: Use existing project memories + code as ground truth
- **Metrics**: MRR@10, Recall@20, NDCG@10, latency P50/P95
- **Baseline capture**: Run benchmarks, save results as JSON baseline
- **Regression detection**: After each improvement, compare against baseline. Alert if metrics drop >5%
- **Query test set**: 50 diverse queries covering:
  - Symbol lookup (exact match)
  - NL→code (semantic bridge)
  - Multi-hop (requires graph traversal)
  - Memory recall (temporal + relevance)
  - Cross-type (memory about code, code implementing decision)
- **New file**: `src/lib/search/benchmark-retrieval.ts`
- **Modify**: `src/lib/benchmark.ts` (add retrieval quality metrics)
- **CLI command**: `succ benchmark --retrieval` to run and compare

---

## Environment Notes

- **This machine has PostgreSQL + Qdrant** — use them for testing
- Build: `npm run build` (tsc). Tests: `npx vitest run`
- Storage abstraction: NEVER access DB directly — use `src/lib/storage/index.ts`
- ESM modules: `export type { X }` for type-only exports
- Every catch block MUST log — zero silent catches (`logWarn` or `console.error`)
- `getErrorMessage()` from `src/lib/errors.ts` for error handling in catch blocks

## Execution Rules

1. **Read ALL existing code first** — many systems already exist. Understand before modifying.
2. **EXTEND, don't rewrite** — add to existing functions, don't replace them.
3. **Run the audit grep** before implementing: `grep -rn 'functionName' src/` to find all callers.
4. **Schema changes**: Add to BOTH SQLite (`src/lib/db/schema.ts`) and PostgreSQL (`src/lib/storage/backends/postgresql.ts`). Use `safeMigrate` pattern for SQLite. Update Qdrant payload types if needed.
5. **Config-gate expensive features**: LLM calls during indexing, new retrieval signals — behind config flags.
6. **Tests required**: Write vitest tests for new functionality.
7. **Backwards compatible**: Don't break existing MCP tool interfaces or daemon API.
8. **Verify**: `npm run build && npx vitest run` must pass.
9. **One focused PR per area**: Branch `improve/area-N-NAME`, descriptive commit message.
