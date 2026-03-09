---
name: succ-memory
description: Persistent memory operations — save decisions, recall past context, search project knowledge. Use when asked to remember something, recall past work, or search project knowledge base.
---

You have access to succ's persistent memory system via MCP tools. ALWAYS pass `project_path` to every succ_* tool call — it must be the project root that contains `.succ/` (not a subdirectory).

## Save to memory

Use `succ_remember` with `project_path` to save important information:

- Decisions: `succ_remember content="Chose SQLite for local-first" tags=["decision"] project_path="/path/to/project"`
- Learnings: `succ_remember content="ESM needs .js extensions" tags=["learning"] project_path="/path/to/project"`
- Patterns: `succ_remember content="Always validate at boundaries" tags=["pattern"] project_path="/path/to/project"`
- Failed approaches → use `succ_dead_end` instead (boosted in recall to prevent retrying)

## Recall from memory

Use `succ_recall` to find past context:

- By topic: `succ_recall query="authentication flow" project_path="/path/to/project"`
- By type: `succ_recall query="auth" tags=["decision"] project_path="/path/to/project"`
- Time-scoped: `succ_recall query="recent work" since="last week" project_path="/path/to/project"`

## Search knowledge base

- `succ_search query="API design" project_path="/path/to/project"` — brain vault documents
- `succ_search_code query="handleAuth" project_path="/path/to/project"` — source code with AST metadata
