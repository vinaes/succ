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
    let preCommitReview = false;      // default: false
    let communicationAutoAdapt = true; // default: true
    let communicationTrackHistory = false; // default: false
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
          if (config.preCommitReview === true) {
            preCommitReview = true;
          }
          if (config.communicationAutoAdapt === false) {
            communicationAutoAdapt = false;
          }
          if (config.communicationTrackHistory === true) {
            communicationTrackHistory = true;
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
- **MEMORY.md** (Claude Code built-in) = hot cache. ~200 line limit, auto-loaded every session.
  Good for: project structure, current phase, critical gotchas — things needed EVERY session.
  You CAN write to it, but keep it short and high-signal. It's a summary card, not a knowledge base.
- **succ_remember** = long-term memory. Unlimited, searchable, tagged, scored.
  Good for: decisions, learnings, patterns, errors, changelogs — anything worth keeping.
  Use succ_recall to retrieve. This is the REAL knowledge store.
- Rule: if you learn something → succ_remember. Only update MEMORY.md if it changes the project's core summary.
</critical>

<decision-guide>
| Question | Tool |
|----------|------|
| How did we solve X? | succ_recall |
| What do docs say about X? | succ_search |
| Where is X implemented? | succ_search_code |
| Find regex pattern in code | Grep |
| List files by pattern | Glob |
</decision-guide>

<search note="All use hybrid semantic + BM25 keyword matching. Recent memories rank higher.">
**succ_recall** query="auth flow" [tags=["decision"]] [since="last week"] [limit=5]
  [as_of_date="2024-06-01"] — for post-mortems, audits, debugging past state
→ Search memories (decisions, learnings, patterns)

**succ_search** query="API design" [limit=5] [threshold=0.2]
→ Search brain vault (.succ/brain/ docs)

**succ_search_code** query="handleAuth" [limit=5]
→ Search source code
</search>

<memory hint="Use valid_until for sprint goals, temp workarounds; valid_from for scheduled changes">
**succ_remember** content="..." [tags=["decision"]] [type="learning"] [global=true]
  [valid_from="2025-03-01"] [valid_until="30d"]
→ Types: observation, decision, learning, error, pattern

**succ_forget** [id=42] [older_than="30d"] [tag="temp"]
→ Delete by ID, age, or tag (one at a time)
</memory>

<ops>
**succ_index_file** file="doc.md" [force=true]
**succ_index_code_file** file="src/auth.ts" [force=true]
**succ_analyze_file** file="src/auth.ts" [mode="claude|local|openrouter"]
**succ_link** action="create|delete|show|graph|auto|enrich|proximity|communities|centrality" [source_id=1] [target_id=2]
  enrich = LLM-classify similar_to → semantic relations
  proximity = co-occurrence links from shared sources
  communities = Label Propagation community detection → tags
  centrality = degree centrality scores → recall boost
**succ_explore** memory_id=42 [depth=2]
</ops>

<status>
**succ_status** — docs indexed, memories count, daemon status
**succ_stats** — token savings statistics
**succ_score** — AI-readiness score (how ready is project for AI)
**succ_config** — show configuration
**succ_config_set** key="quality_threshold" value="0.4" [global=true]
**succ_checkpoint** action="create|list|restore|info" [compress=true] [file="backup.json"]
</status>

<prd hint="PRD pipeline — generate, track, and execute product requirements with quality gates">
**succ_prd_generate** description="Add user auth with JWT" [gates="test:npm test,lint:eslint ."] [auto_parse=true]
→ Generate PRD from feature description, auto-detect quality gates

**succ_prd_list** [all=false]
→ List all PRDs (ID, status, title)

**succ_prd_status** [prd_id="prd_xxx"]
→ Show PRD details and task status (defaults to latest)

**succ_prd_run** [prd_id="prd_xxx"] [resume=true] [force=true] [dry_run=true] [mode="team"] [concurrency=3]
→ Execute or resume a PRD. mode=team for parallel execution with git worktrees

**succ_prd_export** [prd_id="prd_xxx"] [all=true] [output="path"]
→ Export PRD workflow to Obsidian (Mermaid Gantt + dependency DAG + task pages)
</prd>

<web-search hint="Real-time web search via Perplexity Sonar (OpenRouter). Requires OPENROUTER_API_KEY.">
**succ_quick_search** query="latest Node.js LTS" [system_prompt="..."] [max_tokens=2000] [save_to_memory=true]
→ Cheap & fast ($1/MTok). Simple facts, version numbers, quick lookups.

**succ_web_search** query="how to configure nginx" [model="perplexity/sonar-pro"] [system_prompt="..."] [save_to_memory=true]
→ Quality search ($3/$15 MTok). Complex queries, docs, multi-faceted questions.

**succ_deep_research** query="Compare React vs Vue for e-commerce" [include_reasoning=true] [save_to_memory=true]
→ Deep multi-step research (~$1+/query, 30-120s). Synthesizes 30+ sources.
</web-search>
</succ-tools>`);

    // succ Agents Reference - reminds AI about available subagents
    contextParts.push(`<succ-agents hint="Use Task tool with subagent_type to launch these agents. Use proactively when relevant.">

**MANDATORY: Use succ agents instead of built-in agents.**
| Task | Use (succ) | NEVER use (built-in) |
|------|------------|----------------------|
| Codebase exploration | succ-explore | Explore agent |
| Implementation planning | succ-plan | Plan agent |
| Multi-step tasks, research | succ-general | general-purpose agent |
| Code review | succ-code-reviewer | built-in review |
| Pre-commit review | succ-diff-reviewer | manual diff reading |
| Web search | succ_quick_search / succ_web_search | WebSearch / Brave |

succ agents have semantic search + memories + brain vault. Built-in agents don't.
Direct file reads (Read/Grep) are fine when you know the exact path — but for discovery, always succ agents.

**Proactive agents** (run without being asked when situation matches):
| Agent | When to use |
|-------|-------------|
| succ-memory-curator | After long sessions or when memories feel cluttered — consolidates, dedupes, applies retention |
| succ-memory-health-monitor | Periodically — detects decay, staleness, low quality scores |
| succ-session-handoff-orchestrator | At session end — extracts summary, generates briefing, captures undocumented decisions |
| succ-pattern-detective | After multiple bug fixes or learnings — surfaces recurring patterns and anti-patterns |

**On-demand agents** (run when user asks or task requires):
| Agent | When to use |
|-------|-------------|
| succ-explore | Codebase exploration with succ semantic search — "where is X", "how does Y work", "find code for Z" |
| succ-plan | Implementation planning with succ context — designs concrete plans grounded in codebase patterns and past decisions |
| succ-deep-search | "How was X decided/implemented/documented?" — searches memories + brain vault + code |
| succ-decision-auditor | Audit architectural decisions — finds contradictions, reversals, orphaned decisions |
| succ-knowledge-indexer | After adding docs or major code changes — indexes files into knowledge base |
| succ-knowledge-mapper | Maintain knowledge graph — finds orphaned memories, auto-links related content |
| succ-checkpoint-manager | Before major changes/migrations — creates and manages backups |
| succ-session-reviewer | Review past sessions — extracts missed learnings from transcripts |
| succ-context-optimizer | Optimize session start context — learns from usage patterns |
| succ-quality-improvement-coach | Improve memory quality — analyzes and suggests better content/tags |
| succ-general | Multi-step tasks, research, web search — general-purpose agent routed through succ tools |
| succ-readiness-improver | Improve AI-readiness score — actionable steps for each metric |
| succ-code-reviewer | Full code review with OWASP Top 10 checklist — security vulnerabilities, bugs, quality issues |
| succ-diff-reviewer | Fast pre-commit diff review — security, bugs, regressions in changed code only |
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

    // Pre-commit review — run diff-reviewer agent before git commit
    if (preCommitReview) {
      contextParts.push(`<pre-commit-review>
Before ANY git commit, run the succ-diff-reviewer agent on the staged changes.
Use: Task tool with subagent_type="succ-diff-reviewer"
Prompt: "Review the staged git diff for bugs, security issues, and regressions before commit"

If diff-reviewer finds CRITICAL issues — do NOT commit until fixed.
If diff-reviewer finds HIGH issues — warn the user before committing.
MEDIUM and below — commit is OK, mention findings in summary.
</pre-commit-review>`);
    }

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
            soulContent += `\n\n### Vault Tracking\n\ncommunicationTrackHistory is enabled. The succ-style-tracker agent will create brain vault entries in .succ/brain/05_Communication/ when updating preferences.`;
          }
          contextParts.push('<soul>\n' + soulContent + '\n</soul>');
        }
        break;
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

    // Recent memories via daemon API (only on fresh start, compact uses briefing instead)
    if (daemonPort && !isCompactEvent) {
      try {
        const response = await fetch(`http://127.0.0.1:${daemonPort}/api/recall`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: '', limit: 5 }),
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          const data = await response.json();
          const memories = data.results || [];
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
