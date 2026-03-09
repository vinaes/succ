#!/usr/bin/env node
/**
 * SessionStart Hook - Context Injection
 *
 * Best practices applied:
 * - XML tags for semantic boundaries (<task>, <context>, <tools>)
 * - Progressive disclosure (index → details via MCP tools)
 * - Compact format (~100-200 tokens for tools reference)
 * - Quick decision guide at top
 *
 * Loads:
 * - Git context (branch, changes)
 * - succ tools reference (compact)
 * - Soul document
 * - Previous session context
 * - Recent memories (compact index)
 * - Knowledge base stats
 */

const fs = require('fs');
const path = require('path');
const adapter = require('./core/adapter.cjs');
const { ensureDaemon } = require('./core/daemon-boot.cjs');
const { log: _log } = require('./core/log.cjs');
const { loadMergedConfig } = require('./core/config.cjs');

adapter.runHook('session-start', async ({ agent, hookInput, projectDir, succDir }) => {
  const log = (msg) => _log(succDir, 'session-start', msg);

  // Load merged config (global defaults, project overrides)
  const config = loadMergedConfig(projectDir);
  let includeCoAuthoredBy = config.includeCoAuthoredBy !== false;
  let communicationAutoAdapt = config.communicationAutoAdapt !== false;
  let communicationTrackHistory = config.communicationTrackHistory === true;
  let hasOpenRouterKey = !!process.env.OPENROUTER_API_KEY;
  if (!hasOpenRouterKey) {
    const keys = [config.llm?.api_key, config.llm?.embeddings?.api_key, config.web_search?.api_key];
    if (keys.some((k) => typeof k === 'string' && k.startsWith('sk-or-'))) {
      hasOpenRouterKey = true;
    }
  }

  const contextParts = [];
  const projectName = path.basename(projectDir);

  // Git Context removed - Claude Code provides native git integration

  // succ MCP Tools Reference (hybrid: XML wrapper + markdown examples)
  contextParts.push(`<succ-tools>
<critical>
⚠️ ALWAYS pass project_path="${projectDir}" to ALL succ_* tool calls.
Without it, succ works in global-only mode and can't access project data.

⚠️ ALWAYS use succ tools for knowledge retrieval:
- User says "brain", "docs", "vault", "spec" → **succ_search**
- User says "remember", "decided", "learned", "how did we" → **succ_recall**
- User says "where is", "find code", "implementation" → **succ_search_code**

❌ NEVER use Glob/Grep to search .succ/brain/ — use succ_search instead
❌ NEVER use Grep to find memories — use succ_recall instead
❌ NEVER use Read to browse brain vault — use succ_search first

📦 MEMORY — two-tier system:
- **MEMORY.md** = hot cache (~200 lines, auto-loaded). Project structure, current phase, critical gotchas.
- **succ_remember** = long-term memory. Unlimited, searchable, tagged, scored. The REAL knowledge store.
- Rule: learn something → succ_remember. Update MEMORY.md only if it changes the project's core summary.
</critical>

<decision-guide>
| Question | Tool |
|----------|------|
| How did we solve X? | succ_recall |
| What do docs say about X? | succ_search |
| Where is X implemented? | succ_search_code |
| Find functions/classes named X | succ_search_code symbol_type="function" |
| Find code matching regex | succ_search_code regex="pattern" |
| What symbols are in file X? | succ_index action="symbols" file="X" |
| Fetch web page content | succ_fetch |
| Find regex pattern in code | Grep |
| List files by pattern | Glob |
</decision-guide>

<search note="All use hybrid semantic + BM25. Recent memories rank higher.">
**succ_recall** query="auth flow" [tags=["decision"]] [since="last week"] [limit=5] [as_of_date="2024-06-01"]
→ Search memories (decisions, learnings, patterns)

**succ_search** query="API design" [limit=5] [threshold=0.2] [output="full|lean"]
→ Search brain vault (.succ/brain/ docs)

**succ_search_code** query="handleAuth" [limit=5] [regex="pattern"] [symbol_type="function|method|class|interface|type_alias"] [output="full|lean|signatures"]
→ Search source code (hybrid BM25 + semantic, with AST symbol metadata)

**succ_index** action="symbols" file="src/auth.ts" [type="all|function|method|class|interface|type_alias"]
→ Extract AST symbols via tree-sitter (13 languages)
</search>

<memory hint="Use valid_until for sprint goals, temp workarounds; valid_from for scheduled changes">
**succ_remember** content="..." [tags=["decision"]] [type="learning"] [global=true] [valid_from="2025-03-01"] [valid_until="30d"]
→ Types: observation, decision, learning, error, pattern, dead_end

**succ_forget** [id=42] [older_than="30d"] [tag="temp"]
→ Delete by ID, age, or tag

**succ_dead_end** approach="..." why_failed="..." [context="..."] [tags=["debug"]]
→ Record failed approach (boosted in recall to prevent retrying)
</memory>

<hook-rules hint="Dynamic pre-tool rules from memory. Saved rules auto-fire before matching tool calls.">
When user asks to remember a rule about tool behavior (e.g., "before deploy run tests",
"always review before commit", "block rm -rf"), save with hook-rule convention:

**succ_remember** content="..." tags=["hook-rule", "tool:{ToolName}", "match:{regex}"] type="decision|error|pattern"

Tags:
- **hook-rule** — required, marks memory as a pre-tool rule
- **tool:{Name}** — optional, filter by tool (Bash, Edit, Write, Read, Skill, Task). Omit = all tools
- **match:{regex}** — optional, regex tested against tool input (command, skill name, file basename, prompt)

Action via type:
- **decision/observation/learning** → inject as additionalContext (guide the agent)
- **error** → deny the tool call (block it)
- **pattern** → ask user for confirmation before proceeding

Examples:
\`succ_remember content="Run diff-reviewer before deploying" tags=["hook-rule","tool:Skill","match:deploy"] type="decision"\`
\`succ_remember content="Never force-push to main" tags=["hook-rule","tool:Bash","match:push.*--force.*main"] type="error"\`
\`succ_remember content="Editing test files — run tests after" tags=["hook-rule","tool:Edit","match:\\\\.test\\\\."] type="decision"\`
</hook-rules>

<ops>
**succ_index** action="doc" file="doc.md" [force=true] — index doc for succ_search
**succ_index** action="code" file="src/auth.ts" [force=true] — index code for succ_search_code
**succ_index** action="refresh" — detect stale/deleted files, re-index modified, clean deleted
**succ_index** action="analyze" file="src/auth.ts" [mode="claude|api"] — generate brain vault doc
**succ_index** action="symbols" file="src/auth.ts" [type="all|function|method|class|interface|type_alias"] — extract AST symbols
**succ_link** action="create|delete|show|graph|auto|enrich|proximity|communities|centrality|export|explore" [source_id=1] [target_id=2]
</ops>

<status>
**succ_status** — indexed docs/code, memories, daemon status
**succ_status** action="stats" — token savings from RAG vs full-file reads
**succ_status** action="score" — AI-readiness score
**succ_config** / **succ_config** action="set" key="..." value="..." [scope="global|project"]
**succ_config** action="checkpoint_create" [compress=true] / action="checkpoint_list"
</status>

<prd hint="PRD pipeline — generate, track, execute with quality gates">
**succ_prd** action="generate" description="..." [gates="test:npm test,lint:eslint ."] [auto_parse=true]
**succ_prd** action="list" / action="status" [prd_id="prd_xxx"] / action="run" [resume=true] [mode="loop|team"]
**succ_prd** action="export" [prd_id="prd_xxx"] — Obsidian Mermaid export
</prd>

${
  hasOpenRouterKey
    ? `<web-search hint="Perplexity Sonar via OpenRouter.">
**succ_web** action="quick" query="..." — cheap & fast, simple facts
**succ_web** action="search" query="..." [model="perplexity/sonar-pro"] — quality search, complex queries
**succ_web** action="deep" query="..." — multi-step research (30-120s, 30+ sources)
**succ_web** action="history" [tool_name="..."] [limit=20] — past searches and costs
</web-search>`
    : ''
}

<debug hint="Structured debugging with hypothesis testing. Sessions in .succ/debugs/.">
**succ_debug** action="create|hypothesis|instrument|result|resolve|abandon|status|list|log|show_log|detect_lang|gen_log"
→ Create session, add hypotheses, instrument code, confirm/refute, resolve with root cause
</debug>
</succ-tools>`);

  // succ Agents Reference - reminds AI about available subagents
  contextParts.push(`<succ-agents hint="Use Task tool with subagent_type to launch these. All have semantic search + memories + brain vault.">

**MANDATORY: Use succ agents instead of built-in agents.**
| Task | Use (succ) | NEVER use (built-in) |
|------|------------|----------------------|
| Codebase exploration | succ-explore | Explore agent |
| Implementation planning | succ-plan | Plan agent |
| Multi-step tasks, research | succ-general | general-purpose agent |
| Code review | succ-code-reviewer | built-in review |
| Pre-commit review | succ-diff-reviewer | manual diff reading |
| Web page fetch | succ_fetch | WebFetch |${
    hasOpenRouterKey
      ? `
| Web search | succ_web(action="quick") / succ_web(action="search") | WebSearch / Brave |`
      : ''
  }

Direct file reads (Read/Grep) are fine when you know the exact path — for discovery, always succ agents.

**Output rule:** Key findings → \`succ_remember\`. Research → \`.succ/brain/\` as Obsidian markdown → \`succ_index(action="doc")\`.

**Proactive agents** (run without being asked):
| Agent | When |
|-------|------|
| succ-memory-curator | After long sessions — consolidates, dedupes |
| succ-session-handoff-orchestrator | At session end — summary, briefing, undocumented decisions |
| succ-pattern-detective | After multiple bug fixes — surfaces recurring patterns |
</succ-agents>`);

  // Commit Guidelines (strict order) - only if includeCoAuthoredBy is enabled
  if (includeCoAuthoredBy) {
    contextParts.push(`<commit-format>
RULE: Every commit footer MUST end with the succ lines. Other tools may appear before succ but succ is always LAST.

TEMPLATE — copy the relevant lines exactly:
Generated with [Claude Code](https://claude.ai/code)
powered by [succ](https://succ.ai)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: succ <mindpalace@succ.ai>

Other tools (Happy, Cursor, etc.) may add their own "via [Tool]" and "Co-Authored-By: Tool" lines.
Place them BEFORE the succ lines. The only hard rule: succ is always the last footer line and last Co-Authored-By.
</commit-format>`);
  }

  // Pre-commit review + commit guidelines are now handled by PreToolUse hook (succ-pre-tool.cjs)
  // They inject context at the exact moment of git commit, not at session start

  // Soul Document
  const soulPaths = [
    path.join(succDir, 'soul.md'),
    path.join(succDir, 'SOUL.md'),
    path.join(projectDir, 'soul.md'),
    path.join(projectDir, 'SOUL.md'),
  ];

  for (const soulPath of soulPaths) {
    if (fs.existsSync(soulPath)) {
      let soulContent = fs.readFileSync(soulPath, 'utf8').trim();
      if (soulContent) {
        // Strip Adaptation rules if auto-adapt is disabled
        if (!communicationAutoAdapt) {
          soulContent = soulContent.replace(/### Adaptation[\s\S]*?(?=\n## |\n---|\s*$)/, '');
        }
        // Inject vault tracking hint if enabled (agent handles the actual work)
        if (communicationTrackHistory && communicationAutoAdapt) {
          soulContent += `\n\n### Vault Tracking\n\ncommunicationTrackHistory is enabled. The succ-style-tracker agent will create brain vault entries in .succ/brain/communication/ when updating preferences.`;
        }
        contextParts.push('<soul>\n' + soulContent + '\n</soul>');
      }
      break;
    }
  }

  // Architecture / Brain Vault — inline overview + categorized doc index
  const brainDir = path.join(succDir, 'brain');
  if (fs.existsSync(brainDir)) {
    try {
      const archParts = [];

      // Phase 1: Find and inline Architecture Overview (compact extract)
      const knowledgeDir = path.join(brainDir, 'knowledge');
      if (fs.existsSync(knowledgeDir)) {
        const archFiles = fs
          .readdirSync(knowledgeDir)
          .filter((f) => /architect/i.test(f) && f.endsWith('.md'))
          .sort(); // 00_Architecture.md first
        if (archFiles.length > 0) {
          const archContent = fs.readFileSync(path.join(knowledgeDir, archFiles[0]), 'utf8');
          // Strip frontmatter
          const body = archContent.replace(/^---[\s\S]*?\n---\s*\n/, '');
          // Extract from start to second "---" or "## Tech Stack" — whichever comes first
          // This gives us Overview + Core Mission (~15-20 lines)
          const overviewEnd = body.search(/\n---\n|\n## Tech Stack|\n## Directory/);
          const overview =
            overviewEnd > 0 ? body.slice(0, overviewEnd).trim() : body.slice(0, 1500).trim();
          if (overview) {
            archParts.push(overview);
          }
        }
      }

      // Phase 2: Collect remaining docs grouped by category
      const scanDirs = [
        { dir: 'knowledge', label: 'Knowledge & Research' },
        { dir: 'project', label: 'Project' },
      ];
      const docGroups = {};

      for (const { dir, label } of scanDirs) {
        const fullDir = path.join(brainDir, dir);
        if (!fs.existsSync(fullDir)) continue;

        const files = fs.readdirSync(fullDir, { withFileTypes: true });
        for (const entry of files) {
          if (entry.isDirectory()) continue;
          if (!entry.name.endsWith('.md')) continue;

          const filePath = path.join(fullDir, entry.name);
          const stat = fs.statSync(filePath);
          if (stat.size < 2048) continue;
          // Skip architecture files (already inlined above)
          if (/architect/i.test(entry.name)) continue;

          // Read first 500 bytes for frontmatter/H1
          const fd = fs.openSync(filePath, 'r');
          const buf = Buffer.alloc(500);
          fs.readSync(fd, buf, 0, 500, 0);
          fs.closeSync(fd);
          const head = buf.toString('utf8');

          let description = '';
          const fmMatch = head.match(/^---\s*\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const descMatch = fmMatch[1].match(/description:\s*["']?([^"'\n]+)/);
            if (descMatch) description = descMatch[1].trim();
          }
          if (!description) {
            const h1Match = head.match(/^#\s+(.+)/m);
            if (h1Match) description = h1Match[1].trim();
          }

          if (description) {
            if (!docGroups[label]) docGroups[label] = [];
            docGroups[label].push(`${entry.name}: ${description}`);
          }
        }
      }

      // Phase 3: Format grouped docs
      const groupLines = [];
      for (const [label, docs] of Object.entries(docGroups)) {
        groupLines.push(`**${label}:** ${docs.join(' | ')}`);
      }
      if (groupLines.length > 0) {
        archParts.push(groupLines.join('\n'));
      }

      if (archParts.length > 0) {
        contextParts.push(
          `<architecture hint="Use succ_search to read full docs">\n${archParts.join('\n\n')}\n</architecture>`
        );
      }
    } catch {
      // intentionally empty — brain vault scan failed, not critical
    }
  }

  // Check if this is a compact event (after /compact)
  const isCompactEvent = hookInput.source === 'compact';

  log(
    `source=${hookInput.source}, isCompact=${isCompactEvent}, session=${hookInput.session_id || 'unknown'}`
  );

  // Precomputed Context from previous session (only on fresh start, not compact)
  if (!isCompactEvent) {
    const precomputedContextPath = path.join(succDir, 'next-session-context.md');
    if (fs.existsSync(precomputedContextPath)) {
      try {
        const precomputedContent = fs.readFileSync(precomputedContextPath, 'utf8').trim();
        if (precomputedContent) {
          contextParts.push('<previous-session>\n' + precomputedContent + '\n</previous-session>');

          // Archive the file after loading
          const archiveDir = path.join(succDir, '.context-archive');
          if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
          }
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const archivePath = path.join(archiveDir, `context-${timestamp}.md`);
          fs.renameSync(precomputedContextPath, archivePath);

          // Cleanup old archives (keep last 10)
          try {
            const archives = fs
              .readdirSync(archiveDir)
              .filter((f) => f.startsWith('context-') && f.endsWith('.md'))
              .sort()
              .reverse();
            for (const oldArchive of archives.slice(10)) {
              fs.unlinkSync(path.join(archiveDir, oldArchive));
            }
          } catch {
            // intentionally empty — cleanup failed, not critical
          }
        }
      } catch {
        // intentionally empty — ignore errors
      }
    }
  }

  // Ensure daemon is running and get port (shared module)
  const { port: daemonPort } = await ensureDaemon(projectDir, log);

  // Propagate daemon port to Bash environment via CLAUDE_ENV_FILE
  // ensureDaemon already verified the port is alive, so no need to re-check
  if (daemonPort && process.env.CLAUDE_ENV_FILE) {
    try {
      fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export SUCC_DAEMON_PORT=${daemonPort}\n`);
      log(`Wrote SUCC_DAEMON_PORT=${daemonPort} to CLAUDE_ENV_FILE`);
    } catch (err) {
      log(`Failed to write CLAUDE_ENV_FILE: ${err.message || err}`);
    }
  }

  // Skip for service sessions (reflection subagents)
  const isServiceSession = process.env.SUCC_SERVICE_SESSION === '1';

  // IMPORTANT: Create compact-pending flag FIRST (before any slow operations)
  // This ensures fallback context is available even if hook times out during briefing
  // Hook timeout is 10s, briefing can take 60s+ → would block flag creation
  if (isCompactEvent && !isServiceSession) {
    const compactPendingFile = path.join(succDir, '.tmp', 'compact-pending');
    try {
      if (!fs.existsSync(path.join(succDir, '.tmp'))) {
        fs.mkdirSync(path.join(succDir, '.tmp'), { recursive: true });
      }
      // Store the full context that should be injected (without briefing, that comes later)
      const contextForFallback = adapter.adaptContext(agent, contextParts.join('\n\n'));
      fs.writeFileSync(compactPendingFile, contextForFallback, 'utf8');
      log(`Created compact-pending flag (${contextForFallback.length} chars)`);
    } catch (err) {
      log(`Failed to create compact-pending: ${err.message || err}`);
    }
  }

  // Generate compact briefing (slow operation - may timeout)
  // Even if this times out, we have the compact-pending fallback above
  if (isCompactEvent && daemonPort && hookInput.transcript_path && !isServiceSession) {
    log(`Generating compact briefing for ${hookInput.transcript_path}`);
    try {
      const response = await fetch(`http://127.0.0.1:${daemonPort}/api/briefing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript_path: hookInput.transcript_path }),
        signal: AbortSignal.timeout(8000), // 8s timeout - must complete before 10s hook timeout
      });
      if (response.ok) {
        const result = await response.json();
        if (result.success && result.briefing) {
          contextParts.push(
            `<session-briefing source="compact">\n${result.briefing}\n</session-briefing>`
          );
          log(`Briefing generated: ${result.briefing.length} chars`);
        } else {
          log(`Briefing failed: ${result.error || 'no briefing returned'}`);
        }
      } else {
        log(`Briefing API error: ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      log(`Briefing exception: ${err.message || err}`);
      // Briefing generation failed, continue without it
    }
  }

  // Pinned + recent memories via daemon API (only on fresh start, compact uses briefing instead)
  if (daemonPort && !isCompactEvent) {
    const pinnedIds = new Set();

    // Phase 1: Pinned memories (Tier 1 — correction_count >= 2 or is_invariant)
    // Filter: skip observations (noisy subagent reports), limit to top 10 by priority_score
    try {
      const response = await fetch(`http://127.0.0.1:${daemonPort}/api/pinned`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const data = await response.json();
        const allPinned = data.results || [];
        // Track ALL pinned IDs for dedup with recent (including filtered-out observations)
        for (const m of allPinned) pinnedIds.add(m.id);
        // Display only non-observation pinned, sorted by priority, top 10
        const displayPinned = allPinned
          .filter((m) => m.type !== 'observation')
          .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))
          .slice(0, 10);
        if (displayPinned.length > 0) {
          const lines = displayPinned.map((m) => {
            const preview = m.content.slice(0, 100).replace(/\n/g, ' ');
            const type = m.type || 'obs';
            const reason = m.is_invariant ? 'invariant' : `corrected x${m.correction_count}`;
            return `#${m.id} [${type}] (${reason}) ${preview}${m.content.length > 100 ? '...' : ''}`;
          });
          contextParts.push(
            `<pinned-memories count="${displayPinned.length}" total="${allPinned.length}" hint="Tier 1: always loaded, high confidence">\n${lines.join('\n')}\n</pinned-memories>`
          );
        }
      }
    } catch {
      // intentionally empty — pinned memories not available
    }

    // Phase 2: Recent memories (excluding pinned to avoid duplication)
    try {
      const response = await fetch(`http://127.0.0.1:${daemonPort}/api/recall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '', limit: 5 }),
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const data = await response.json();
        const memories = (data.results || []).filter((m) => !pinnedIds.has(m.id));
        if (memories.length > 0) {
          const lines = memories.map((m) => {
            const preview = m.content.slice(0, 50).replace(/\n/g, ' ');
            const type = m.type || 'obs';
            return `#${m.id} [${type}] ${preview}${m.content.length > 50 ? '...' : ''}`;
          });
          contextParts.push(
            `<recent-memories count="${memories.length}" hint="Use succ_recall for details">\n${lines.join('\n')}\n</recent-memories>`
          );
        }
      }
    } catch {
      // intentionally empty — memories not available
    }
  }

  // Knowledge base stats via daemon API
  if (daemonPort) {
    try {
      const response = await fetch(`http://127.0.0.1:${daemonPort}/api/status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const status = await response.json();
        const docs = status.documents || 0;
        const mems = status.memories || 0;
        const code = status.codeChunks || 0;
        if (docs > 0 || mems > 0 || code > 0) {
          contextParts.push(
            `<knowledge-base docs="${docs}" memories="${mems}" code-chunks="${code}" />`
          );
        }
      }
    } catch {
      // intentionally empty — status not available
    }
  }

  // Output context
  if (contextParts.length > 0) {
    // Sanitize closing wrapper tags from dynamic content to prevent XML injection
    // (e.g. a stored memory or soul.md containing literal "</session>" would break the envelope)
    const body = contextParts.join('\n\n').replace(/<\/session>/gi, '&lt;/session&gt;');
    let additionalContext = `<session project="${projectName}">\n${body}\n</session>`;
    // Strip Claude-only sections for non-Claude agents
    additionalContext = adapter.adaptContext(agent, additionalContext);
    const { json, exitCode } = adapter.formatOutput(agent, 'SessionStart', { additionalContext });
    if (json && Object.keys(json).length > 0) {
      console.log(JSON.stringify(json));
    }
    log(
      `Output additionalContext: ${additionalContext.length} chars, parts=${contextParts.length}, agent=${agent}`
    );
    if (exitCode) process.exit(exitCode); // non-zero = deny (Cursor/Gemini); 0 falls through to session registration
  } else {
    log(`No context parts to output`);
  }

  // Register session with daemon
  if (daemonPort) {
    const transcriptPath = hookInput.transcript_path || '';
    const sessionId = transcriptPath
      ? path.basename(transcriptPath, '.jsonl')
      : `session-${Date.now()}`;
    // isServiceSession already defined above

    try {
      await fetch(`http://127.0.0.1:${daemonPort}/api/session/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          transcript_path: transcriptPath,
          is_service: isServiceSession,
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // intentionally empty — registration failed, continue anyway
    }
  }

  process.exit(0);
});
