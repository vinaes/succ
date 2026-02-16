#!/usr/bin/env node
/**
 * PreToolUse Hook — Command safety guard + commit context + file-linked memories
 *
 * Fires before every tool call. Four features:
 *
 * 1. File-linked memories — intercepts Edit/Write, queries daemon for related memories,
 *    injects them as additionalContext (~10ms, fail-open)
 *
 * 2. Command safety guard — blocks dangerous git/filesystem/database/docker commands
 *    Config: commandSafetyGuard.mode = 'deny' | 'ask' | 'off' (default: 'deny')
 *    Config: commandSafetyGuard.allowlist = string[]
 *    Config: commandSafetyGuard.customPatterns = [{ pattern: "regex", reason: "why" }]
 *
 * 3. Commit guidelines injection — injects co-author format into context
 *    when Claude is about to run git commit
 *    Config: includeCoAuthoredBy (default: true)
 *
 * 4. Pre-commit diff review reminder — injects reminder to run diff-reviewer
 *    Config: preCommitReview (default: false)
 */

const fs = require('fs');
const path = require('path');

// ─── Dangerous command patterns ──────────────────────────────────────

const DANGEROUS_PATTERNS = [
  // ── Git — data loss ──
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    reason: 'git reset --hard destroys uncommitted changes. Use git stash first.',
  },
  {
    pattern: /\bgit\s+reset\s+--merge\b/,
    reason: 'git reset --merge can destroy uncommitted changes.',
  },
  {
    pattern: /\bgit\s+checkout\s+--\s/,
    reason: 'git checkout -- discards file modifications. Use git stash first.',
  },
  {
    pattern: /\bgit\s+checkout\s+\.\s*($|[;&|])/,
    reason: 'git checkout . discards all modifications. Use git stash first.',
  },
  {
    pattern: /\bgit\s+restore\s+--staged\s+--worktree\b/,
    reason: 'git restore --staged --worktree discards both staged and unstaged changes.',
  },
  {
    pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/,
    reason: 'git clean -f permanently deletes untracked files.',
  },
  {
    pattern: /\bgit\s+push\s+.*--force(?!-with-lease)\b/,
    reason: 'git push --force rewrites remote history. Use --force-with-lease instead.',
  },
  {
    pattern: /\bgit\s+push\s+-f\b/,
    reason: 'git push -f rewrites remote history. Use --force-with-lease instead.',
  },
  {
    pattern: /\bgit\s+branch\s+-D\b/,
    reason: 'git branch -D force-deletes without merge verification. Use -d for safe delete.',
  },
  {
    pattern: /\bgit\s+stash\s+drop\b/,
    reason: 'git stash drop permanently destroys stashed work.',
  },
  { pattern: /\bgit\s+stash\s+clear\b/, reason: 'git stash clear destroys ALL stashed work.' },
  {
    pattern: /\bgit\s+rebase\s+-i\b/,
    reason: 'git rebase -i requires interactive terminal (not available in hooks).',
  },
  {
    pattern: /\bgit\s+reflog\s+expire\s+--expire=now\b/,
    reason: 'git reflog expire --expire=now permanently removes recovery points.',
  },

  // ── Filesystem — data loss ──
  {
    pattern: /\brm\s+.*\.succ\b/,
    reason:
      '.succ/ contains your memory, brain vault, and config. This would destroy all succ data.',
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b/,
    reason: 'rm -rf can permanently delete files. Verify the target path.',
    checkPath: true,
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\b/,
    reason: 'rm -fr can permanently delete files. Verify the target path.',
    checkPath: true,
  },

  // ── Docker — container/image/volume destruction ──
  {
    pattern: /\bdocker\s+system\s+prune\b/,
    reason:
      'docker system prune removes all unused containers, networks, images, and optionally volumes.',
  },
  {
    pattern: /\bdocker\s+volume\s+prune\b/,
    reason: 'docker volume prune removes all unused volumes (potential data loss).',
  },
  {
    pattern: /\bdocker\s+rm\s+-f\b/,
    reason: 'docker rm -f force-removes running containers without graceful shutdown.',
  },
  {
    pattern: /\bdocker\s+rmi\s+-f\b/,
    reason: 'docker rmi -f force-removes images that may be in use.',
  },
  {
    pattern: /\bdocker-compose\s+down\s+-v\b/,
    reason: 'docker-compose down -v removes named volumes (database data loss).',
  },
  {
    pattern: /\bdocker\s+compose\s+down\s+-v\b/,
    reason: 'docker compose down -v removes named volumes (database data loss).',
  },

  // ── SQLite — database destruction ──
  {
    pattern: /\bsqlite3?\b.*\bDROP\s+TABLE\b/i,
    reason: 'DROP TABLE permanently deletes a SQLite table and all its data.',
  },
  {
    pattern: /\bsqlite3?\b.*\bDROP\s+DATABASE\b/i,
    reason: 'DROP DATABASE permanently deletes the entire SQLite database.',
  },
  {
    pattern: /\bsqlite3?\b.*\bDELETE\s+FROM\s+\w+\s*;/i,
    reason: 'DELETE FROM without WHERE deletes all rows in a SQLite table.',
  },
  {
    pattern: /\bsqlite3?\b.*\bTRUNCATE\b/i,
    reason: 'TRUNCATE removes all data from a SQLite table.',
  },

  // ── PostgreSQL — database destruction ──
  {
    pattern: /\bpsql\b.*\bDROP\s+TABLE\b/i,
    reason: 'DROP TABLE permanently deletes a PostgreSQL table and all its data.',
  },
  {
    pattern: /\bpsql\b.*\bDROP\s+DATABASE\b/i,
    reason: 'DROP DATABASE permanently deletes the entire PostgreSQL database.',
  },
  {
    pattern: /\bpsql\b.*\bDELETE\s+FROM\s+\w+\s*;/i,
    reason: 'DELETE FROM without WHERE deletes all rows in a PostgreSQL table.',
  },
  {
    pattern: /\bpsql\b.*\bTRUNCATE\b/i,
    reason: 'TRUNCATE removes all data from a PostgreSQL table.',
  },
  { pattern: /\bdropdb\b/, reason: 'dropdb permanently deletes a PostgreSQL database.' },
  { pattern: /\bdropuser\b/, reason: 'dropuser permanently deletes a PostgreSQL user/role.' },

  // ── Qdrant — vector database destruction ──
  {
    pattern: /\bcurl\b.*\bqdrant\b.*\bDELETE\b/i,
    reason: 'DELETE on Qdrant API can remove collections or points permanently.',
  },
  {
    pattern: /\bcurl\b.*\b:6333\b.*\bDELETE\b/i,
    reason: 'DELETE on Qdrant port 6333 can remove collections or points permanently.',
  },
  {
    pattern: /\bcurl\b.*\b:6334\b.*\bDELETE\b/i,
    reason: 'DELETE on Qdrant gRPC port can remove data permanently.',
  },
];

// Paths where rm -rf is considered safe (normalized, lowercase)
const SAFE_RM_PATHS = [
  '/tmp',
  '/var/tmp',
  'node_modules',
  'dist',
  'build',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  '.tox',
  'target/debug',
  'target/release',
  '.next',
  '.nuxt',
  '.turbo',
  'coverage',
];

// Prefixes that indicate the command is data, not execution
const DATA_PREFIXES = [
  /^\s*(?:#|\/\/)/, // comments
  /^\s*echo\b/, // echo
  /^\s*printf\b/, // printf
  /^\s*cat\s*<</, // heredoc (cat <<)
  /^\s*grep\b/, // grep
  /^\s*rg\b/, // ripgrep
  /^\s*ag\b/, // silver searcher
  /^\s*(?:"|').*(?:"|')\s*$/, // quoted string
];

// ─── Helpers ─────────────────────────────────────────────────────────

function loadConfig(projectDir) {
  const defaults = {
    commandSafetyGuard: { mode: 'deny', allowlist: [], customPatterns: [] },
    includeCoAuthoredBy: true,
    preCommitReview: false,
  };

  const configPaths = [
    path.join(projectDir, '.succ', 'config.json'),
    path.join(require('os').homedir(), '.succ', 'config.json'),
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        // Command safety guard
        if (config.commandSafetyGuard) {
          if (config.commandSafetyGuard.mode) {
            defaults.commandSafetyGuard.mode = config.commandSafetyGuard.mode;
          }
          if (Array.isArray(config.commandSafetyGuard.allowlist)) {
            defaults.commandSafetyGuard.allowlist = config.commandSafetyGuard.allowlist;
          }
          if (Array.isArray(config.commandSafetyGuard.customPatterns)) {
            defaults.commandSafetyGuard.customPatterns = config.commandSafetyGuard.customPatterns;
          }
        }

        if (config.includeCoAuthoredBy === false) {
          defaults.includeCoAuthoredBy = false;
        }
        if (config.preCommitReview === true) {
          defaults.preCommitReview = true;
        }

        break;
      } catch {
        // Ignore parse errors
      }
    }
  }

  return defaults;
}

function isDataContext(command) {
  const trimmed = command.trim();
  return DATA_PREFIXES.some((prefix) => prefix.test(trimmed));
}

function isRmPathSafe(command) {
  const match = command.match(/\brm\s+-[a-zA-Z]*(?:rf|fr)[a-zA-Z]*\s+(.+?)(?:\s*[;&|]|$)/);
  if (!match) return false;

  const target = match[1].trim().replace(/["']/g, '');
  const normalized = target.toLowerCase().replace(/\\/g, '/');

  return SAFE_RM_PATHS.some((safe) => {
    if (normalized === safe || normalized.endsWith('/' + safe)) return true;
    if (safe === '/tmp' && normalized.startsWith('/tmp/')) return true;
    if (safe === '/var/tmp' && normalized.startsWith('/var/tmp/')) return true;
    return false;
  });
}

function checkDangerous(command, config) {
  if (config.commandSafetyGuard.mode === 'off') return null;

  // Check allowlist first
  const allowlist = config.commandSafetyGuard.allowlist || [];
  for (const allowed of allowlist) {
    if (command.includes(allowed)) return null;
  }

  // Skip if command is in a data context
  if (isDataContext(command)) return null;

  // Check built-in patterns
  for (const { pattern, reason, checkPath } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      if (checkPath && isRmPathSafe(command)) continue;

      return {
        reason,
        mode: config.commandSafetyGuard.mode,
      };
    }
  }

  // Check user-defined custom patterns (blacklist)
  const customPatterns = config.commandSafetyGuard.customPatterns || [];
  for (const custom of customPatterns) {
    try {
      const regex = new RegExp(custom.pattern, custom.flags || '');
      if (regex.test(command)) {
        return {
          reason: custom.reason || `Blocked by custom pattern: ${custom.pattern}`,
          mode: config.commandSafetyGuard.mode,
        };
      }
    } catch {
      // Invalid regex in config — skip silently
    }
  }

  return null;
}

function buildCommitContext(config) {
  const parts = [];

  if (config.includeCoAuthoredBy) {
    parts.push(`<commit-format>
Footer order (succ always LAST):
1. Generated with [Claude Code]
2. via [Happy] (if used)
3. powered by [succ](https://succ.ai)

Co-Authored-By order (succ always LAST):
1. Co-Authored-By: Claude <noreply@anthropic.com>
2. Co-Authored-By: Happy <yesreply@happy.engineering> (if used)
3. Co-Authored-By: succ <mindpalace@succ.ai>
</commit-format>`);
  }

  if (config.preCommitReview) {
    parts.push(`<pre-commit-review>
STOP. Before committing, you MUST run the succ-diff-reviewer agent first.
Use: Task tool with subagent_type="succ-diff-reviewer"
Prompt: "Review the staged git diff for bugs, security issues, and regressions before commit"

If diff-reviewer finds CRITICAL issues — do NOT commit until fixed.
If diff-reviewer finds HIGH issues — warn the user before committing.
MEDIUM and below — commit is OK, mention findings in summary.
</pre-commit-review>`);
  }

  return parts.join('\n');
}

// ─── Daemon helpers ──────────────────────────────────────────────────

function getDaemonPort(projectDir) {
  const portFile = path.join(projectDir, '.succ', '.tmp', 'daemon.port');
  if (!fs.existsSync(portFile)) return null;
  const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
  return port && !isNaN(port) ? port : null;
}

async function recallFileMemories(projectDir, fileName) {
  const port = getDaemonPort(projectDir);
  if (!port) return [];

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/recall-by-tag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: `file:${fileName}`, limit: 5 }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch {
    return []; // fail-open
  }
}

async function fetchHookRules(projectDir, toolName, toolInput) {
  const port = getDaemonPort(projectDir);
  if (!port) return [];

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hook-rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: toolName, tool_input: toolInput || {} }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.rules || [];
  } catch {
    return []; // fail-open
  }
}

function formatFileContext(memories, fileName) {
  const lines = memories.map((m) => `- [${m.type || 'observation'}] ${m.content.slice(0, 200)}`);
  return `<file-context file="${fileName}">\nRelated memories:\n${lines.join('\n')}\n</file-context>`;
}

// ─── Main ────────────────────────────────────────────────────────────

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

    // Skip if this is a service session (daemon, reflection agent, etc.)
    if (process.env.SUCC_SERVICE_SESSION === '1') {
      process.exit(0);
    }

    // Skip if succ is not initialized
    if (!fs.existsSync(path.join(projectDir, '.succ'))) {
      process.exit(0);
    }

    const toolName = hookInput.tool_name || '';
    const toolInput = hookInput.tool_input || {};
    const filePath = toolInput.file_path || '';
    const command = toolInput.command || '';
    const contextParts = [];
    let askReason = null;

    // 1. Dynamic hook rules from memory (ALL tools)
    // Note: deny/ask exit immediately — any accumulated contextParts are intentionally
    // discarded because the tool call is being blocked or requires confirmation.
    const rules = await fetchHookRules(projectDir, toolName, toolInput);
    for (const rule of rules) {
      if (rule.action === 'deny') {
        const output = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `[succ rule] ${rule.content}`,
          },
        };
        console.log(JSON.stringify(output));
        process.exit(0);
      }
      if (rule.action === 'ask' && !askReason) {
        askReason = rule.content;
      }
      if (rule.action === 'inject') {
        contextParts.push(`<hook-rule>${rule.content}</hook-rule>`);
      }
    }

    // 2. File-linked memories (Edit/Write only — Read is too frequent, wastes context)
    if ((toolName === 'Edit' || toolName === 'Write') && filePath) {
      const fileName = path.basename(filePath);
      const memories = await recallFileMemories(projectDir, fileName);
      if (memories.length > 0) {
        contextParts.push(formatFileContext(memories, fileName));
      }
    }

    // 3. Command safety guard (Bash only)
    if (command) {
      const config = loadConfig(projectDir);
      const dangerousResult = checkDangerous(command, config);
      if (dangerousResult) {
        const output = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: dangerousResult.mode === 'ask' ? 'ask' : 'deny',
            permissionDecisionReason: `[succ guard] ${dangerousResult.reason}`,
          },
        };
        console.log(JSON.stringify(output));
        process.exit(0);
      }

      // 4. Hook rule ask (after safety guard, so deny takes priority)
      if (askReason) {
        const output = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: `[succ rule] ${askReason}`,
          },
        };
        console.log(JSON.stringify(output));
        process.exit(0);
      }

      // 5. Git commit — inject guidelines + diff review reminder
      if (/\bgit\s+commit\b/.test(command)) {
        const commitContext = buildCommitContext(config);
        if (commitContext) {
          contextParts.push(commitContext);
        }
      }
    } else if (askReason) {
      // Non-Bash ask rule
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `[succ rule] ${askReason}`,
        },
      };
      console.log(JSON.stringify(output));
      process.exit(0);
    }

    // 6. Emit combined context
    if (contextParts.length > 0) {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: contextParts.join('\n'),
        },
      };
      console.log(JSON.stringify(output));
    }

    process.exit(0);
  } catch {
    // Fail-open: don't block on hook errors
    process.exit(0);
  }
});
