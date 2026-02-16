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

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Logging helper - writes to .succ/.tmp/hooks.log
function log(succDir, message) {
  try {
    const tmpDir = path.join(succDir, '.tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const logFile = path.join(tmpDir, 'hooks.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] [session-start] ${message}\n`);
  } catch {
    // Logging failed, not critical
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('readable', () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    input += chunk;
  }
});

process.stdin.on('end', async () => {
  try {
    const hookInput = JSON.parse(input);
    let projectDir = hookInput.cwd || process.cwd();

    // Windows path fix
    if (process.platform === 'win32' && /^\/[a-z]\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    const succDir = path.join(projectDir, '.succ');

    // Skip if succ is not initialized in this project
    if (!fs.existsSync(succDir)) {
      process.exit(0);
    }

    // Load config settings
    let includeCoAuthoredBy = true;   // default: true
    let communicationAutoAdapt = true; // default: true
    let communicationTrackHistory = false; // default: false
    let hasOpenRouterKey = !!process.env.OPENROUTER_API_KEY;
    const configPaths = [
      path.join(succDir, 'config.json'),
      path.join(require('os').homedir(), '.succ', 'config.json'),
    ];
    for (const configPath of configPaths) {
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          if (config.includeCoAuthoredBy === false) {
            includeCoAuthoredBy = false;
          }
          if (config.communicationAutoAdapt === false) {
            communicationAutoAdapt = false;
          }
          if (config.communicationTrackHistory === true) {
            communicationTrackHistory = true;
          }
          // Check for OpenRouter API key in config (llm.api_key)
          if (!hasOpenRouterKey && config.llm?.api_key) {
            hasOpenRouterKey = true;
          }
          break;
        } catch {
          // Ignore parse errors
        }
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
| What symbols are in file X? | succ_symbols file="X" |
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

**succ_symbols** file="src/auth.ts" [type="all|function|method|class|interface|type_alias"]
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

<ops>
**succ_index_file** file="doc.md" [force=true] — index doc for succ_search
**succ_index_code_file** file="src/auth.ts" [force=true] — index code for succ_search_code
**succ_reindex** — detect stale/deleted files, re-index modified, clean deleted
**succ_analyze_file** file="src/auth.ts" [mode="claude|api"] — generate brain vault doc
**succ_link** action="create|delete|show|graph|auto|enrich|proximity|communities|centrality|export" [source_id=1] [target_id=2]
**succ_explore** memory_id=42 [depth=2] — traverse knowledge graph
</ops>

<status>
**succ_status** — indexed docs/code, memories, daemon status
**succ_stats** — token savings from RAG vs full-file reads
**succ_score** — AI-readiness score
**succ_config** / **succ_config_set** key="..." value="..." [scope="global|project"]
**succ_checkpoint** action="create|list" [compress=true]
</status>

<prd hint="PRD pipeline — generate, track, execute with quality gates">
**succ_prd_generate** description="..." [gates="test:npm test,lint:eslint ."] [auto_parse=true]
**succ_prd_list** / **succ_prd_status** [prd_id="prd_xxx"] / **succ_prd_run** [resume=true] [mode="loop|team"]
**succ_prd_export** [prd_id="prd_xxx"] — Obsidian Mermaid export
</prd>

${hasOpenRouterKey ? `<web-search hint="Perplexity Sonar via OpenRouter.">
**succ_quick_search** query="..." — cheap & fast, simple facts
**succ_web_search** query="..." [model="perplexity/sonar-pro"] — quality search, complex queries
**succ_deep_research** query="..." — multi-step research (30-120s, 30+ sources)
**succ_web_search_history** [tool_name="..."] [limit=20] — past searches and costs
</web-search>` : ''}

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
| Web page fetch | succ_fetch | WebFetch |${hasOpenRouterKey ? `
| Web search | succ_quick_search / succ_web_search | WebSearch / Brave |` : ''}

Direct file reads (Read/Grep) are fine when you know the exact path — for discovery, always succ agents.

**Output rule:** Key findings → \`succ_remember\`. Research → \`.succ/brain/\` as Obsidian markdown → \`succ_index_file\`.

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
Footer order (succ always LAST):
1. Generated with [Claude Code]
2. via [Happy] (if used)
3. powered by [succ](https://succ.ai) ← ADD THIS LINE

Co-Authored-By order (succ always LAST):
1. Co-Authored-By: Claude <noreply@anthropic.com>
2. Co-Authored-By: Happy <yesreply@happy.engineering> (if used)
3. Co-Authored-By: succ <mindpalace@succ.ai> ← ADD THIS LINE
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
          const archFiles = fs.readdirSync(knowledgeDir)
            .filter(f => /architect/i.test(f) && f.endsWith('.md'))
            .sort(); // 00_Architecture.md first
          if (archFiles.length > 0) {
            const archContent = fs.readFileSync(path.join(knowledgeDir, archFiles[0]), 'utf8');
            // Strip frontmatter
            const body = archContent.replace(/^---[\s\S]*?\n---\s*\n/, '');
            // Extract from start to second "---" or "## Tech Stack" — whichever comes first
            // This gives us Overview + Core Mission (~15-20 lines)
            const overviewEnd = body.search(/\n---\n|\n## Tech Stack|\n## Directory/);
            const overview = overviewEnd > 0 ? body.slice(0, overviewEnd).trim() : body.slice(0, 1500).trim();
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
          contextParts.push(`<architecture hint="Use succ_search to read full docs">\n${archParts.join('\n\n')}\n</architecture>`);
        }
      } catch {
        // Brain vault scan failed, not critical
      }
    }

    // Check if this is a compact event (after /compact)
    const isCompactEvent = hookInput.source === 'compact';

    log(succDir, `source=${hookInput.source}, isCompact=${isCompactEvent}, session=${hookInput.session_id || 'unknown'}`);

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
              const archives = fs.readdirSync(archiveDir)
                .filter(f => f.startsWith('context-') && f.endsWith('.md'))
                .sort()
                .reverse();
              for (const oldArchive of archives.slice(10)) {
                fs.unlinkSync(path.join(archiveDir, oldArchive));
              }
            } catch {
              // Cleanup failed, not critical
            }
          }
        } catch {
          // Ignore errors
        }
      }
    }

    // Helper to get daemon port
    const tmpDir = path.join(succDir, '.tmp');
    const portFile = path.join(tmpDir, 'daemon.port');

    const getDaemonPort = () => {
      try {
        if (fs.existsSync(portFile)) {
          return parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
        }
      } catch {}
      return null;
    };

    const checkDaemon = async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        const data = await response.json();
        return data?.status === 'ok';
      } catch {
        return false;
      }
    };

    const startDaemon = () => {
      const servicePath = path.join(projectDir, 'dist', 'daemon', 'service.js');
      if (fs.existsSync(servicePath)) {
        const daemon = spawn(process.execPath, ['--no-warnings', '--no-deprecation', servicePath], {
          cwd: projectDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, NODE_OPTIONS: '' },
        });
        daemon.unref();
        return true;
      }
      return false;
    };

    // Ensure daemon is running and get port
    let daemonPort = getDaemonPort();
    if (!daemonPort || !(await checkDaemon(daemonPort))) {
      startDaemon();
      // Wait for daemon to start (max 3 seconds)
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        daemonPort = getDaemonPort();
        if (daemonPort && await checkDaemon(daemonPort)) {
          break;
        }
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
        const contextForFallback = contextParts.join('\n\n');
        fs.writeFileSync(compactPendingFile, contextForFallback, 'utf8');
        log(succDir, `Created compact-pending flag (${contextForFallback.length} chars)`);
      } catch (err) {
        log(succDir, `Failed to create compact-pending: ${err.message || err}`);
      }
    }

    // Generate compact briefing (slow operation - may timeout)
    // Even if this times out, we have the compact-pending fallback above
    if (isCompactEvent && daemonPort && hookInput.transcript_path && !isServiceSession) {
      log(succDir, `Generating compact briefing for ${hookInput.transcript_path}`);
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
            contextParts.push(`<session-briefing source="compact">\n${result.briefing}\n</session-briefing>`);
            log(succDir, `Briefing generated: ${result.briefing.length} chars`);
          } else {
            log(succDir, `Briefing failed: ${result.error || 'no briefing returned'}`);
          }
        } else {
          log(succDir, `Briefing API error: ${response.status} ${response.statusText}`);
        }
      } catch (err) {
        log(succDir, `Briefing exception: ${err.message || err}`);
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
          // Display only non-observation pinned, sorted by priority, top 10
          const displayPinned = allPinned
            .filter((m) => m.type !== 'observation')
            .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))
            .slice(0, 10);
          if (displayPinned.length > 0) {
            // Track ALL pinned IDs for dedup with recent (including filtered-out observations)
            for (const m of allPinned) pinnedIds.add(m.id);
            const lines = displayPinned.map((m) => {
              const preview = m.content.slice(0, 100).replace(/\n/g, ' ');
              const type = m.type || 'obs';
              const reason = m.is_invariant ? 'invariant' : `corrected x${m.correction_count}`;
              return `#${m.id} [${type}] (${reason}) ${preview}${m.content.length > 100 ? '...' : ''}`;
            });
            contextParts.push(`<pinned-memories count="${displayPinned.length}" total="${allPinned.length}" hint="Tier 1: always loaded, high confidence">\n${lines.join('\n')}\n</pinned-memories>`);
          }
        }
      } catch {
        // pinned memories not available
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
            contextParts.push(`<recent-memories count="${memories.length}" hint="Use succ_recall for details">\n${lines.join('\n')}\n</recent-memories>`);
          }
        }
      } catch {
        // memories not available
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
            contextParts.push(`<knowledge-base docs="${docs}" memories="${mems}" code-chunks="${code}" />`);
          }
        }
      } catch {
        // status not available
      }
    }

    // Output context
    if (contextParts.length > 0) {
      const additionalContext = `<session project="${projectName}">\n${contextParts.join('\n\n')}\n</session>`;
      const output = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext
        }
      };
      console.log(JSON.stringify(output));
      log(succDir, `Output additionalContext: ${additionalContext.length} chars, parts=${contextParts.length}`);
    } else {
      log(succDir, `No context parts to output`);
    }

    // Register session with daemon
    if (daemonPort) {
      const transcriptPath = hookInput.transcript_path || '';
      const sessionId = transcriptPath ? path.basename(transcriptPath, '.jsonl') : `session-${Date.now()}`;
      // isServiceSession already defined above

      try {
        await fetch(`http://127.0.0.1:${daemonPort}/api/session/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath, is_service: isServiceSession }),
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        // Registration failed, continue anyway
      }
    }

    process.exit(0);

  } catch (err) {
    process.exit(0);
  }
});
