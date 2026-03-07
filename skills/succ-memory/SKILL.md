---
name: succ-memory
description: Persistent memory operations — save decisions, recall past context, search project knowledge. Use when asked to remember something, recall past work, or search project knowledge base.
---

You have access to succ's persistent memory system via MCP tools. ALWAYS pass `project_path` to every succ_* tool call.

## Save to memory

Use `succ_remember` to save important information:

- Decisions and their rationale → `tags: ["decision"]`
- Learnings from debugging → `tags: ["learning"]`
- Patterns discovered → `tags: ["pattern"]`
- Failed approaches → use `succ_dead_end` instead (boosted in recall to prevent retrying)

Always include relevant tags for categorization.

## Recall from memory

Use `succ_recall` to find past context:

- By topic: `query="authentication flow"`
- By type: `tags=["decision"]`
- Time-scoped: `since="last week"`

## Search knowledge base

- `succ_search` — brain vault documents (architecture docs, specs, research)
- `succ_search_code` — source code (functions, classes, patterns, with AST symbol metadata)
