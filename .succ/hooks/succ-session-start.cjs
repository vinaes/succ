#!/usr/bin/env node
/**
 * SessionStart Hook - Complete Context Injection
 *
 * 4-phase approach:
 * Phase 0: Git context (branch, uncommitted changes)
 * Phase 0.5: Soul document
 * Phase 1: Recent memories (prioritized by type)
 * Phase 2: Global memories (cross-project)
 * Phase 3: Knowledge base stats
 *
 * Uses execFileSync for security (no shell injection)
 */

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('readable', () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    input += chunk;
  }
});

process.stdin.on('end', () => {
  try {
    const hookInput = JSON.parse(input);
    let projectDir = hookInput.cwd || process.cwd();

    // Windows path fix
    if (process.platform === 'win32' && /^\/[a-z]\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    const contextParts = [];
    const succDir = path.join(projectDir, '.succ');
    const projectName = path.basename(projectDir);

    // Phase 0: Git Context
    try {
      const gitParts = [];
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      gitParts.push('Branch: ' + branch);

      const statusOutput = execFileSync('git', ['status', '--porcelain'], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (statusOutput) {
        const changes = statusOutput.split('\n').filter((l) => l.trim());
        gitParts.push('Uncommitted: ' + changes.length + ' files');
      }

      if (gitParts.length > 0) {
        contextParts.push('<git-context>\n' + gitParts.join('\n') + '\n</git-context>');
      }
    } catch {
      // Not a git repo
    }

    // Phase 0.4: Commit Guidelines (succ attribution)
    contextParts.push(`<commit-guidelines>
When making git commits, add succ to the attribution footer.

Format (order matters):
1. "Generated with" line (Claude Code)
2. "via" line (if using Happy or other wrapper)
3. "powered by" line → ADD: powered by [succ](https://succ.ai)
4. Blank line
5. All Co-Authored-By lines together → ADD: Co-Authored-By: succ <mindpalace@succ.ai>

Example with all tools:
\`\`\`
Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)
powered by [succ](https://succ.ai)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
Co-Authored-By: succ <mindpalace@succ.ai>
\`\`\`

Example without Happy:
\`\`\`
Generated with [Claude Code](https://claude.ai/code)
powered by [succ](https://succ.ai)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: succ <mindpalace@succ.ai>
\`\`\`
</commit-guidelines>`);

    // Phase 0.45: succ MCP Tools Reference (tested & verified)
    contextParts.push(`<succ-mcp-tools>
## succ MCP Tools - Use Actively!

### MEMORY (saved via remember, searched via recall)

**succ_recall** query="..." [tags=["x"]] [since="last week"] [limit=5]
→ Search MEMORIES (decisions, learnings, patterns from past sessions)
→ Use before implementing, when stuck, before decisions

**succ_remember** content="..." [tags=["decision"]] [type="learning"] [global=true]
→ Save to MEMORIES. Types: observation, decision, learning, error, pattern

**succ_forget** id=N | older_than="30d" | tag="temp"

### SEARCH (indexed documents and code)

**succ_search** query="..." [limit=5] [threshold=0.2]
→ Search DOCUMENTS in .succ/brain/ (markdown knowledge base)

**succ_search_code** query="..." [limit=5]
→ Search SOURCE CODE (.ts, .js, .py, etc.)

### SINGLE-FILE OPS

**succ_index_file** file="path/to/doc.md" [force=true]
**succ_index_code_file** file="src/file.ts" [force=true]
**succ_analyze_file** file="src/file.ts" [mode="claude|local|openrouter"]

### KNOWLEDGE GRAPH

**succ_link** action="create|delete|show|graph|auto" [source_id=N] [target_id=N] [relation="leads_to"]
**succ_explore** memory_id=N [depth=2]

### STATUS & CONFIG

**succ_status** → docs indexed, memories count, daemon status
→ Use at session start to understand what's indexed, or when debugging search issues

**succ_config** → show current configuration with all effective values
→ Use when user asks about settings, embedding model, or to debug config issues

---
**recall** = memories (from remember) | **search** = documents (brain/) | **search_code** = source files
</succ-mcp-tools>`);

    // Phase 0.5: Soul Document
    const soulPaths = [
      path.join(succDir, 'soul.md'),
      path.join(succDir, 'SOUL.md'),
      path.join(projectDir, 'soul.md'),
      path.join(projectDir, 'SOUL.md'),
    ];

    for (const soulPath of soulPaths) {
      if (fs.existsSync(soulPath)) {
        const soulContent = fs.readFileSync(soulPath, 'utf8').trim();
        if (soulContent) {
          contextParts.push('<soul>\n' + soulContent + '\n</soul>');
        }
        break;
      }
    }

    // Phase 0.6: Precomputed Context from previous session
    const precomputedContextPath = path.join(succDir, 'next-session-context.md');
    if (fs.existsSync(precomputedContextPath)) {
      try {
        const precomputedContent = fs.readFileSync(precomputedContextPath, 'utf8').trim();
        if (precomputedContent) {
          contextParts.push('<previous-session-context>\n' + precomputedContent + '\n</previous-session-context>');

          // Archive the file after loading (move to .context-archive)
          const archiveDir = path.join(succDir, '.context-archive');
          if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
          }
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const archivePath = path.join(archiveDir, `context-${timestamp}.md`);
          fs.renameSync(precomputedContextPath, archivePath);
        }
      } catch {
        // Ignore errors reading precomputed context
      }
    }

    // Phase 1-3: Memories and stats via succ CLI
    // Use npx succ for CLI commands
    try {
      // Recent memories
      try {
        const memoriesResult = execFileSync('npx', ['succ', 'memories', '--recent', '5'], {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (memoriesResult.trim() && !memoriesResult.includes('No memories')) {
          contextParts.push('<recent-memories>\n' + memoriesResult.trim() + '\n</recent-memories>');
        }
      } catch {
        // memories not available
      }

      // Knowledge base stats
      try {
        const statusResult = execFileSync('npx', ['succ', 'status'], {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (statusResult.trim()) {
          const filesMatch = statusResult.match(/files indexed:\s*(\d+)/i);
          const memoriesMatch = statusResult.match(/Total:\s*(\d+)/i);

          if (filesMatch || memoriesMatch) {
            const stats = [];
            if (filesMatch && parseInt(filesMatch[1]) > 0) {
              stats.push(filesMatch[1] + ' docs indexed');
            }
            if (memoriesMatch && parseInt(memoriesMatch[1]) > 0) {
              stats.push(memoriesMatch[1] + ' memories');
            }
            if (stats.length > 0) {
              contextParts.push('<knowledge-base>\n' + stats.join(', ') + '\nUse succ_search/succ_recall for context.\n</knowledge-base>');
            }
          }
        }
      } catch {
        // status not available
      }
    } catch {
      // npx succ not available
    }

    // Launch idle watcher daemon
    try {
      const watcherPath = path.join(__dirname, 'succ-idle-watcher.cjs');
      if (fs.existsSync(watcherPath)) {
        // Save transcript path for watcher if available
        if (hookInput.transcript_path) {
          const tmpDir = path.join(succDir, '.tmp');
          if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
          }
          fs.writeFileSync(path.join(tmpDir, 'current-transcript.txt'), hookInput.transcript_path);
        }

        // Launch watcher as detached process
        const watcher = spawn('node', [watcherPath, projectDir], {
          cwd: projectDir,
          detached: true,
          stdio: 'ignore',
        });
        watcher.unref();
      }
    } catch {
      // Watcher launch failed, continue without it
    }

    if (contextParts.length > 0) {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: '# Session Context: ' + projectName + '\n\n' + contextParts.join('\n\n')
        }
      };
      console.log(JSON.stringify(output));
    }

    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
});
