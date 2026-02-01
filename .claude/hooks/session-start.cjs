#!/usr/bin/env node
/**
 * SessionStart Hook - Complete Context Injection
 *
 * Inspired by mcp-memory-service 4-phase approach:
 * Phase 0: Git context (branch, uncommitted changes)
 * Phase 1: Recent memories (prioritized by type)
 * Phase 2: Global memories (cross-project)
 * Phase 3: Knowledge base stats + soul
 *
 * Uses execFileSync for security (no shell injection)
 */

const { execFileSync } = require('child_process');
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
    const claudeDir = path.join(projectDir, '.claude');
    const projectName = path.basename(projectDir);
    const sessionSource = hookInput.source || 'startup'; // startup, resume, or clear

    // ============================================
    // Phase 0: Git Context (using execFileSync for safety)
    // ============================================
    try {
      const gitParts = [];

      // Get current branch
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      gitParts.push(`Branch: ${branch}`);

      // Get uncommitted changes count
      const statusOutput = execFileSync('git', ['status', '--porcelain'], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (statusOutput) {
        const changes = statusOutput.split('\n').filter((l) => l.trim());
        gitParts.push(`Uncommitted: ${changes.length} files`);
      }

      // Get recent commits (last 3)
      try {
        const logOutput = execFileSync('git', ['log', '--oneline', '-3'], {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        if (logOutput) {
          gitParts.push('Recent commits:\n' + logOutput);
        }
      } catch {
        // git log failed, skip
      }

      if (gitParts.length > 0) {
        contextParts.push('<git-context>\n' + gitParts.join('\n') + '\n</git-context>');
      }
    } catch {
      // Not a git repo or git not available
    }

    // ============================================
    // Phase 0.4: Commit Guidelines (succ attribution)
    // ============================================
    contextParts.push(`<commit-guidelines>
When making git commits, use this format:

<commit message>

Generated with [Claude Code](https://claude.ai/code)
powered by [succ](https://github.com/vinaes/succ)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: succ <mindpalace@succ.ai>
</commit-guidelines>`);

    // ============================================
    // Phase 0.5: Soul Document
    // ============================================
    const soulPaths = [
      path.join(claudeDir, 'soul.md'),
      path.join(claudeDir, 'SOUL.md'),
      path.join(projectDir, 'soul.md'),
      path.join(projectDir, 'SOUL.md'),
      path.join(projectDir, '.soul.md'),
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

    // ============================================
    // Phase 1: Recent Memories (type prioritized)
    // ============================================
    const nodePath = process.execPath;
    const succCli = path.join(projectDir, 'dist', 'cli.js');

    if (fs.existsSync(succCli)) {
      try {
        const memoriesResult = execFileSync(nodePath, [succCli, 'memories', '--recent', '10', '--json'], {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (memoriesResult.trim() && !memoriesResult.includes('No memories')) {
          try {
            const memories = JSON.parse(memoriesResult);

            // Priority order: decision > learning > error > pattern > observation
            const priorityOrder = { decision: 1, learning: 2, error: 3, pattern: 4, observation: 5 };
            const sorted = [...memories].sort((a, b) => {
              const pa = priorityOrder[a.type] || 5;
              const pb = priorityOrder[b.type] || 5;
              return pa - pb;
            });

            // Separate high-priority types
            const decisions = sorted.filter((m) => m.type === 'decision' || (m.tags && m.tags.includes('decision')));
            const learnings = sorted.filter((m) => m.type === 'learning' || (m.tags && m.tags.includes('learning')));
            const errors = sorted.filter((m) => m.type === 'error' || (m.tags && m.tags.includes('error')));

            // Format decisions (top 3)
            if (decisions.length > 0) {
              const lines = decisions.slice(0, 3).map((d) => {
                const date = new Date(d.created_at).toLocaleDateString();
                const content = d.content.length > 200 ? d.content.substring(0, 200) + '...' : d.content;
                return `- (${date}) ${content}`;
              });
              contextParts.push('<recent-decisions>\n' + lines.join('\n') + '\n</recent-decisions>');
            }

            // Format learnings (top 3)
            if (learnings.length > 0) {
              const lines = learnings.slice(0, 3).map((l) => {
                const date = new Date(l.created_at).toLocaleDateString();
                const content = l.content.length > 200 ? l.content.substring(0, 200) + '...' : l.content;
                return `- (${date}) ${content}`;
              });
              contextParts.push('<key-learnings>\n' + lines.join('\n') + '\n</key-learnings>');
            }

            // Format errors (if resuming, show recent errors)
            if (sessionSource === 'resume' && errors.length > 0) {
              const lines = errors.slice(0, 2).map((e) => {
                const date = new Date(e.created_at).toLocaleDateString();
                const content = e.content.length > 150 ? e.content.substring(0, 150) + '...' : e.content;
                return `- (${date}) ${content}`;
              });
              contextParts.push('<recent-errors>\n' + lines.join('\n') + '\n</recent-errors>');
            }

            // Format all recent (top 5, different from above)
            const shown = new Set([...decisions, ...learnings, ...errors].map((m) => m.id));
            const remaining = memories.filter((m) => !shown.has(m.id)).slice(0, 5);

            if (remaining.length > 0) {
              const lines = remaining.map((m) => {
                const date = new Date(m.created_at).toLocaleDateString();
                const tags = m.tags && m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
                const typeStr = m.type && m.type !== 'observation' ? ` (${m.type})` : '';
                const content = m.content.length > 120 ? m.content.substring(0, 120) + '...' : m.content;
                return `- (${date})${tags}${typeStr} ${content}`;
              });
              contextParts.push('<recent-memories>\n' + lines.join('\n') + '\n</recent-memories>');
            }
          } catch {
            // JSON parse failed
          }
        }
      } catch {
        // CLI failed
      }

      // ============================================
      // Phase 2: Global Memories
      // ============================================
      try {
        const globalResult = execFileSync(nodePath, [succCli, 'memories', '--global', '--recent', '3', '--json'], {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (globalResult.trim() && !globalResult.includes('No memories')) {
          try {
            const globalMemories = JSON.parse(globalResult);
            // Filter out memories from current project
            const crossProject = globalMemories.filter((m) => m.project !== projectName);

            if (crossProject.length > 0) {
              const lines = crossProject.slice(0, 3).map((m) => {
                const date = new Date(m.created_at).toLocaleDateString();
                const project = m.project ? ` (from: ${m.project})` : '';
                const content = m.content.length > 120 ? m.content.substring(0, 120) + '...' : m.content;
                return `- (${date})${project} ${content}`;
              });
              contextParts.push('<global-memories>\n' + lines.join('\n') + '\n</global-memories>');
            }
          } catch {
            // JSON parse failed
          }
        }
      } catch {
        // Global memories not available
      }

      // ============================================
      // Phase 3: Knowledge Base Stats
      // ============================================
      try {
        const statusResult = execFileSync(nodePath, [succCli, 'status'], {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (statusResult.trim()) {
          const filesMatch = statusResult.match(/files indexed:\s*(\d+)/i);
          const chunksMatch = statusResult.match(/chunks:\s*(\d+)/i);
          const memoriesMatch = statusResult.match(/Total:\s*(\d+)/i);

          if (filesMatch || memoriesMatch) {
            const stats = [];
            if (filesMatch && parseInt(filesMatch[1]) > 0) {
              stats.push(`${filesMatch[1]} docs indexed`);
            }
            if (chunksMatch) {
              stats.push(`${chunksMatch[1]} chunks`);
            }
            if (memoriesMatch && parseInt(memoriesMatch[1]) > 0) {
              stats.push(`${memoriesMatch[1]} memories`);
            }
            if (stats.length > 0) {
              contextParts.push('<knowledge-base>\n' + stats.join(', ') + '\nUse succ_search/succ_recall for context.\n</knowledge-base>');
            }
          }
        }
      } catch {
        // Status not available
      }
    }

    // ============================================
    // Output
    // ============================================
    if (contextParts.length > 0) {
      const sourceLabel = sessionSource === 'resume' ? ' (Resumed)' : sessionSource === 'clear' ? ' (Fresh)' : '';
      const output = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `# Session Context: ${projectName}${sourceLabel}\n\n` + contextParts.join('\n\n'),
        },
      };
      console.log(JSON.stringify(output));
    }

    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
});
