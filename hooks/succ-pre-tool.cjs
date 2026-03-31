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
const adapter = require('./core/adapter.cjs');
const { ensureDaemonLazy } = require('./core/daemon-boot.cjs');
const { loadMergedConfig } = require('./core/config.cjs');

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
  {
    pattern: /\bgit\s+filter-branch\b/,
    reason: 'git filter-branch rewrites history and can destroy data.',
  },
  {
    pattern: /\bgit\s+.*--no-verify\b/,
    reason: 'git --no-verify skips pre-commit hooks (safety checks bypassed).',
  },
  {
    pattern: /\bgit\s+restore\s+\.\s*($|[;&|])/,
    reason: 'git restore . discards all modifications.',
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
  { pattern: /\brm\s+-r\s+\/\s/, reason: 'rm -r / would destroy the entire filesystem.' },
  {
    pattern: /\brm\s+-r\s+~(?:\s|\/|$)/,
    reason: 'rm -r ~ would destroy the entire home directory.',
  },
  { pattern: /\bshred\b/, reason: 'shred permanently overwrites file data beyond recovery.' },
  { pattern: /\bdd\s+.*\bof=\/dev\//, reason: 'dd writing to /dev/ can destroy disk data.' },
  { pattern: /\bmkfs\b/, reason: 'mkfs formats a filesystem, destroying all data.' },

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

  // ── Infrastructure ──
  {
    pattern: /\bterraform\s+destroy\b/,
    reason: 'terraform destroy tears down all managed infrastructure.',
  },
  {
    pattern: /\bkubectl\s+delete\s+(?:ns|namespace)\b/,
    reason: 'kubectl delete namespace removes all resources.',
  },
  {
    pattern: /\bkubectl\s+delete\s+.*--all\b/,
    reason: 'kubectl delete --all removes all resources of type.',
  },
  { pattern: /\bhelm\s+uninstall\b/, reason: 'helm uninstall removes a Helm release.' },

  // ── Redis ──
  { pattern: /\bredis-cli\b.*\bFLUSHALL\b/i, reason: 'FLUSHALL removes all Redis data.' },
  { pattern: /\bredis-cli\b.*\bFLUSHDB\b/i, reason: 'FLUSHDB removes current Redis DB data.' },

  // ── MongoDB ──
  {
    pattern: /\bmongo(?:sh)?\b.*\bdropDatabase\b/,
    reason: 'dropDatabase deletes a MongoDB database.',
  },
  { pattern: /\bmongo(?:sh)?\b.*\.drop\s*\(/, reason: '.drop() deletes a MongoDB collection.' },

  // ── Permissions ──
  { pattern: /\bchmod\s+-R\s+777\b/, reason: 'chmod -R 777 makes everything world-writable.' },
  { pattern: /\bchmod\s+-R\s+666\b/, reason: 'chmod -R 666 makes all files world-writable.' },
  { pattern: /\bchown\s+-R\s+root\b/, reason: 'chown -R root changes ownership recursively.' },

  // ── Disk ──
  { pattern: /\bfdisk\b/, reason: 'fdisk modifies disk partitions.' },
  { pattern: /\bparted\b/, reason: 'parted modifies disk partitions.' },
  { pattern: /\bwipefs\b/, reason: 'wipefs erases filesystem signatures.' },

  // ── Process ──
  { pattern: /\bkillall\b/, reason: 'killall terminates all matching processes.' },
  { pattern: /\bkill\s+-9\b/, reason: 'kill -9 forcefully terminates (SIGKILL).' },
  { pattern: /\bkill\s+-(?:KILL|SIGKILL)\b/, reason: 'kill -KILL forcefully terminates.' },

  // ── Lockfiles ──
  {
    pattern: /\brm\s+.*package-lock\.json\b/,
    reason: 'Deleting package-lock.json causes dep issues.',
  },
  { pattern: /\brm\s+.*yarn\.lock\b/, reason: 'Deleting yarn.lock causes dep issues.' },
  { pattern: /\brm\s+.*pnpm-lock\.yaml\b/, reason: 'Deleting pnpm-lock.yaml causes dep issues.' },

  // ── Exfiltration ──
  {
    pattern: /\bcurl\b.*(?:-d\b|--data\b|--form\b)/,
    reason: 'curl with data flags can exfiltrate information.',
    exemptLocalhost: true,
  },
  { pattern: /\bwget\s+--post-data\b/, reason: 'wget --post-data can exfiltrate information.' },
  { pattern: /\bnc\s+-[a-zA-Z]*\s/, reason: 'netcat can exfiltrate data or open reverse shells.' },
  {
    pattern: /\bbase64\b.*\|\s*\bcurl\b/,
    reason: 'Piping base64 to curl is exfiltration pattern.',
  },
  { pattern: /\bcat\b.*\|\s*\bcurl\b/, reason: 'Piping file to curl can exfiltrate data.' },

  // ── Supply chain ──
  {
    pattern: /\bcurl\b.*\|\s*(?:bash|sh|zsh)\b/,
    reason: 'Piping curl to shell runs untrusted code.',
  },
  {
    pattern: /\bwget\b.*\|\s*(?:bash|sh|zsh)\b/,
    reason: 'Piping wget to shell runs untrusted code.',
  },
  {
    pattern: /\bpip\s+install\s+-i\s/,
    reason: 'pip install -i uses custom index (supply chain risk).',
  },
  {
    pattern: /\bnpm\s+install\s+--registry\s/,
    reason: 'npm --registry uses custom registry (supply chain risk).',
  },
];

// Paths where rm -rf is considered safe (normalized, lowercase)
const SAFE_RM_PATHS = [
  '/tmp',
  '/var/tmp',
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

// ─── Content Sanitization (inline — no imports in .cjs) ─────────────

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stripControlChars(text) {
  return text.replace(/[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u202A-\u202E\u2066-\u2069]/g, '');
}

function sanitize(text, maxLen) {
  maxLen = maxLen || 5000;
  let cleaned = stripControlChars(text);
  if (cleaned.length > maxLen) cleaned = cleaned.slice(0, maxLen) + '... [truncated]';
  return escapeXml(cleaned);
}

function sanitizeFileName(name) {
  let cleaned = name.replace(/\0/g, ''); // Strip null bytes
  cleaned = stripControlChars(cleaned);
  cleaned = cleaned.replace(/[/\\]/g, '');
  return escapeXml(cleaned);
}

// ─── Tier 1 Injection Detection (inline — structural patterns) ──────

const TIER1_PATTERNS = [
  // Delimiter injection
  { re: /<\|im_start\|>/i, desc: 'ChatML delimiter' },
  { re: /<\|im_end\|>/i, desc: 'ChatML delimiter' },
  { re: /\[INST\]/i, desc: 'Llama delimiter' },
  { re: /\[\/INST\]/i, desc: 'Llama delimiter' },
  { re: /<<SYS>>/i, desc: 'Llama system delimiter' },
  { re: /<\|endoftext\|>/i, desc: 'GPT endoftext token' },
  { re: /<\|system\|>/i, desc: 'System role token' },
  {
    re: /<\/(?:hook-rule|file-context|soul|previous-session|session|compact-fallback|security-warning|commit-format|pre-commit-review|succ-agents)>/i,
    desc: 'Closing succ XML tag',
  },
  { re: /<\/?system>/i, desc: 'XML system tag' },
  { re: /<\/?assistant>/i, desc: 'XML assistant tag' },
  { re: /<\/?user>/i, desc: 'XML user tag' },
  { re: /\[system\]/i, desc: 'Bracketed system role' },
  { re: /\[assistant\]/i, desc: 'Bracketed assistant role' },
  // End-of-sequence token (avoid false positive on HTML <s>text</s>)
  { re: /(?<!<s[^>]*>.*)<\/s>/i, desc: 'End-of-sequence token' },
  // Hidden content / obfuscation
  { re: /[\u200B\u200C\u200D\uFEFF\u00AD\u2060]{3,}/, desc: 'Zero-width char cluster' },
  { re: /[\u202A-\u202E\u2066-\u2069]{2,}/, desc: 'RTL/LTR override abuse' },
  {
    re: /<(?:span|div|p)\s+[^>]*(?:display\s*:\s*none|visibility\s*:\s*hidden|hidden)[^>]*>/i,
    desc: 'Hidden HTML element',
  },
  {
    re: /<!--\s*(?:AI|AGENT|LLM|ASSISTANT|IGNORE|INSTRUCTION|SYSTEM|OVERRIDE)/i,
    desc: 'HTML comment targeting AI',
  },
  // Encoded injection
  {
    re: /&(?:lt|gt|amp|quot);.*(?:system|assistant|ignore|instruction)/i,
    desc: 'HTML-entity encoded injection',
  },
  {
    re: /(?:base64|atob|decode)\s*[:(]\s*['"]?[A-Za-z0-9+/]{20,}={0,2}/i,
    desc: 'Explicitly decoded base64',
  },
];

function detectTier1(text) {
  for (const { re, desc } of TIER1_PATTERNS) {
    if (re.test(text)) return desc;
  }
  return null;
}

// ─── File Operation Guards (inline) ─────────────────────────────────

const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'];

const PROTECTED_DELETE_PATTERNS = [
  {
    pattern: /\.gitignore$/i,
    reason: '.gitignore controls tracked files — deletion can expose secrets.',
  },
  {
    pattern: /Dockerfile$/i,
    reason: 'Dockerfile is critical infrastructure — verify before deleting.',
  },
  {
    pattern: /\.github\/workflows\//i,
    reason: 'CI/CD workflow — deletion can break deployment pipeline.',
  },
  {
    pattern: /\.gitlab-ci\.yml$/i,
    reason: 'CI/CD config — deletion can break deployment pipeline.',
  },
  {
    pattern: /CODEOWNERS$/i,
    reason: 'CODEOWNERS controls review policy — verify before deleting.',
  },
  {
    pattern: /migrations?\//i,
    reason: 'Migration files are sequential — deletion can corrupt database schema.',
  },
  {
    pattern: /package-lock\.json$/i,
    reason: 'Lockfile ensures reproducible builds — deletion causes dep issues.',
  },
  {
    pattern: /yarn\.lock$/i,
    reason: 'Lockfile ensures reproducible builds — deletion causes dep issues.',
  },
  {
    pattern: /pnpm-lock\.yaml$/i,
    reason: 'Lockfile ensures reproducible builds — deletion causes dep issues.',
  },
];

function checkFileGuard(operation, filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  // Extract all extensions for compound extension check (e.g. file.pem.bak → .pem, .bak)
  const basename = normalized.split('/').pop() || '';
  const parts = basename.split('.');
  if (normalized.includes('/node_modules/') || normalized.includes('/.git/')) return null;
  // Sensitive file extensions — deny read/write (check all extensions, not just last)
  if (operation === 'read' || operation === 'write') {
    for (let i = 1; i < parts.length; i++) {
      const ext = '.' + parts[i];
      if (SENSITIVE_EXTENSIONS.includes(ext)) {
        return {
          reason: `${ext} files contain private keys/certificates — ${operation} blocked.`,
          mode: 'deny',
        };
      }
    }
  }
  // Protected files — deny delete (Bash rm commands handled separately, this is for the delete flag)
  if (operation === 'delete') {
    for (const { pattern, reason } of PROTECTED_DELETE_PATTERNS) {
      if (pattern.test(normalized)) {
        return { reason, mode: 'deny' };
      }
    }
  }
  if (operation === 'write' && /\.env(?:\.|$)/i.test(normalized)) {
    return { reason: '.env files may contain secrets — verify content.', mode: 'ask' };
  }
  return null;
}

// ─── Lightweight IFC labels (inline — proactive file label for context) ──

const IFC_EXTENSION_LABELS = {
  '.pem': { level: 3, label: 'highly_confidential {credentials}' },
  '.key': { level: 3, label: 'highly_confidential {credentials}' },
  '.p12': { level: 3, label: 'highly_confidential {credentials}' },
  '.pfx': { level: 3, label: 'highly_confidential {credentials}' },
  '.jks': { level: 3, label: 'highly_confidential {credentials}' },
  '.keystore': { level: 3, label: 'highly_confidential {credentials}' },
};

const IFC_PATH_PATTERNS = [
  { re: /[/\\]secrets?[/\\]/i, level: 3, label: 'highly_confidential {secrets}' },
  { re: /[/\\]\.ssh[/\\]/i, level: 3, label: 'highly_confidential {credentials}' },
  { re: /[/\\]deploy[/\\]/i, level: 2, label: 'confidential {internal_infra}' },
  { re: /[/\\]terraform[/\\]/i, level: 2, label: 'confidential {internal_infra}' },
  { re: /[/\\]k8s[/\\]/i, level: 2, label: 'confidential {internal_infra}' },
];

/**
 * Quick file label for .cjs hook (no state, just classification).
 * Returns { level, label } or null for public files.
 */
function quickFileLabel(filePath) {
  const lower = filePath.toLowerCase().replace(/\\/g, '/');
  const basename = lower.split('/').pop() || '';

  // .env files (but not env.sh, env.py, etc.)
  if (basename === '.env' || basename.startsWith('.env.')) {
    return { level: 2, label: 'confidential {secrets, credentials}' };
  }
  if (basename.startsWith('env.')) {
    const afterDot = basename.slice(4);
    if (!/^(?:sh|py|ts|js|rb|go|rs|pl|bat|cmd|ps1|php|java|c|h|cpp)$/i.test(afterDot)) {
      return { level: 2, label: 'confidential {secrets, credentials}' };
    }
  }

  // Extension check
  const lastDot = basename.lastIndexOf('.');
  if (lastDot >= 0) {
    const ext = basename.slice(lastDot);
    if (IFC_EXTENSION_LABELS[ext]) return IFC_EXTENSION_LABELS[ext];
  }

  // Path check (take highest)
  let best = null;
  for (const { re, level, label } of IFC_PATH_PATTERNS) {
    if (re.test(lower) && (!best || level > best.level)) {
      best = { level, label };
    }
  }

  return best;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function loadConfig(projectDir) {
  const merged = loadMergedConfig(projectDir);
  const csg = merged.commandSafetyGuard || {};
  return {
    commandSafetyGuard: {
      mode: csg.mode || 'deny',
      allowlist: Array.isArray(csg.allowlist) ? csg.allowlist : [],
      customPatterns: Array.isArray(csg.customPatterns) ? csg.customPatterns : [],
    },
    undercover: merged.undercover === true,
    includeCoAuthoredBy: merged.includeCoAuthoredBy !== false,
    preCommitReview: merged.preCommitReview === true,
  };
}

/**
 * Split a shell command line into individual commands separated by ;, &&, ||, |.
 * Respects quoted strings (single and double quotes).
 */
function splitShellCommands(command) {
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
    } else if (!inSingle && !inDouble) {
      if (command[i] === '&' && command[i + 1] === '&') {
        parts.push(current);
        current = '';
        i += 2;
      } else if (command[i] === '|' && command[i + 1] === '|') {
        parts.push(current);
        current = '';
        i += 2;
      } else if (command[i] === ';' || command[i] === '|') {
        parts.push(current);
        current = '';
        i++;
      } else {
        current += ch;
        i++;
      }
    } else {
      current += ch;
      i++;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const MAX_REGEX_LENGTH = 200;

function isDataContext(command) {
  const parts = splitShellCommands(command);
  if (parts.length === 0) return true;
  return parts.every((part) => DATA_PREFIXES.some((prefix) => prefix.test(part.trim())));
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

  // Check allowlist — each entry is tested as an anchored regex against the full command
  const trimmed = command.trim();
  const allowlist = config.commandSafetyGuard.allowlist || [];
  for (const allowed of allowlist) {
    if (allowed.length > MAX_REGEX_LENGTH) continue;
    try {
      if (new RegExp(allowed).test(trimmed)) return null;
    } catch (e) {
      console.error(`[succ:pre-tool] Invalid allowlist regex "${allowed}": ${e.message || e}`);
      if (trimmed === allowed) return null;
    }
  }

  // Skip if command is in a data context
  if (isDataContext(command)) return null;

  // Check built-in patterns
  for (const { pattern, reason, checkPath, exemptLocalhost } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      if (checkPath && isRmPathSafe(command)) continue;
      if (
        exemptLocalhost &&
        /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/'")\s]|$)/.test(command)
      )
        continue;

      return {
        reason,
        mode: config.commandSafetyGuard.mode,
      };
    }
  }

  // Check user-defined custom patterns (blacklist)
  const customPatterns = config.commandSafetyGuard.customPatterns || [];
  for (const custom of customPatterns) {
    if (custom.pattern.length > MAX_REGEX_LENGTH) continue;
    try {
      const regex = new RegExp(custom.pattern, custom.flags || '');
      if (regex.test(command)) {
        return {
          reason: custom.reason || `Blocked by custom pattern: ${custom.pattern}`,
          mode: config.commandSafetyGuard.mode,
        };
      }
    } catch (e) {
      console.error(
        `[succ:pre-tool] Invalid custom safety pattern "${custom.pattern}": ${e.message || e}`
      );
    }
  }

  return null;
}

function buildCommitContext(config) {
  const parts = [];

  if (config.includeCoAuthoredBy) {
    parts.push(`<commit-format>
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

async function recallFileMemories(projectDir, succDir, fileName) {
  const port = ensureDaemonLazy(projectDir, succDir);
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
  } catch (e) {
    console.error(`[succ:pre-tool] recallFileMemories failed: ${e.message || e}`);
    return [];
  }
}

async function fetchHookRules(projectDir, succDir, toolName, toolInput) {
  const port = ensureDaemonLazy(projectDir, succDir);
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
  } catch (e) {
    console.error(`[succ:pre-tool] fetchHookRules failed: ${e.message || e}`);
    return [];
  }
}

function formatFileContext(memories, fileName) {
  const lines = memories.map(
    (m) => `- [${escapeXml(m.type || 'observation')}] ${sanitize(m.content, 200)}`
  );
  return `<file-context file="${sanitizeFileName(fileName)}">\nRelated memories:\n${lines.join('\n')}\n</file-context>`;
}

// ─── Context pressure advisory ───────────────────────────────────────

function formatCompactAdvisory(usage) {
  const usedK = Math.round((usage.tokens_used || 0) / 1000);
  const limitK = Math.round((usage.tokens_limit || 0) / 1000);
  const pct = Math.round(usage.usage_percent || 0);
  switch (usage.urgency) {
    case 'low':
      return `<context-pressure level="low">Context ${pct}% used (${usedK}K/${limitK}K). Consider running /compact to keep session lean.</context-pressure>`;
    case 'medium':
      return `<context-pressure level="medium">[IMPORTANT] Context ${pct}% used (${usedK}K/${limitK}K). Run /compact now to maintain quality.</context-pressure>`;
    case 'high':
    case 'critical':
      return `<context-pressure level="critical">[CRITICAL: Context ${pct}% used — ${usedK}K/${limitK}K tokens] You MUST run /compact immediately. Response quality is degrading.</context-pressure>`;
    default:
      return '';
  }
}

// ─── Main ────────────────────────────────────────────────────────────

adapter.runHook('pre-tool', async ({ agent, hookInput, projectDir, succDir }) => {
  // Skip if this is a service session (daemon, reflection agent, etc.)
  if (process.env.SUCC_SERVICE_SESSION === '1') {
    process.exit(0);
  }

  const toolName = hookInput.tool_name || '';
  const toolInput = hookInput.tool_input || {};
  const filePath = toolInput.file_path || '';
  const command = toolInput.command || '';
  const contextParts = [];
  let askReason = null;

  // 0. Injection scan on tool input
  const inputToScan = filePath || command || toolInput.url || '';
  if (inputToScan) {
    const injectionDesc = detectTier1(inputToScan);
    if (injectionDesc) {
      const { json, exitCode } = adapter.formatOutput(agent, 'PreToolUse', {
        deny: true,
        denyReason: `[succ security] Prompt injection detected in tool input: ${injectionDesc}`,
      });
      console.log(JSON.stringify(json));
      process.exit(exitCode);
    }
  }

  // 0b. File operation guard
  if (filePath && (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit')) {
    const operation = toolName === 'Read' ? 'read' : 'write';
    const fileGuardResult = checkFileGuard(operation, filePath);
    if (fileGuardResult) {
      const result =
        fileGuardResult.mode === 'ask'
          ? { ask: true, askReason: `[succ file guard] ${fileGuardResult.reason}` }
          : { deny: true, denyReason: `[succ file guard] ${fileGuardResult.reason}` };
      const { json, exitCode } = adapter.formatOutput(agent, 'PreToolUse', result);
      console.log(JSON.stringify(json));
      process.exit(exitCode);
    }
  }

  // 0c. IFC: Proactive file label classification (warn in context)
  if (filePath && (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit')) {
    const fileLabel = quickFileLabel(filePath);
    if (fileLabel && fileLabel.level >= 2) {
      contextParts.push(
        `<security-warning type="ifc">[succ IFC] File ${sanitizeFileName(path.basename(filePath))} classified as ${escapeXml(fileLabel.label)}. ` +
          `Subsequent outbound operations (curl, WebFetch, git push) may be restricted.</security-warning>`
      );
    }
  }

  // 1. Dynamic hook rules from memory (ALL tools)
  // Note: deny/ask exit immediately — any accumulated contextParts are intentionally
  // discarded because the tool call is being blocked or requires confirmation.
  const rules = await fetchHookRules(projectDir, succDir, toolName, toolInput);
  for (const rule of rules) {
    // Scan rule content for injection (prevents poisoned memory escalation)
    if (detectTier1(rule.content)) continue;

    if (rule.action === 'deny') {
      const { json, exitCode } = adapter.formatOutput(agent, 'PreToolUse', {
        deny: true,
        denyReason: `[succ rule] ${sanitize(rule.content, 500)}`,
      });
      console.log(JSON.stringify(json));
      process.exit(exitCode);
    }
    if (rule.action === 'ask' && !askReason) {
      askReason = sanitize(rule.content, 500);
    }
    if (rule.action === 'inject') {
      contextParts.push(`<hook-rule>${sanitize(rule.content)}</hook-rule>`);
    }
  }

  // 2. File-linked memories (Edit/Write only — Read is too frequent, wastes context)
  if ((toolName === 'Edit' || toolName === 'Write') && filePath) {
    const fileName = path.basename(filePath);
    const memories = await recallFileMemories(projectDir, succDir, fileName);
    if (memories.length > 0) {
      contextParts.push(formatFileContext(memories, fileName));
    }
  }

  // 3. Command safety guard (Bash only)
  if (command) {
    const config = loadConfig(projectDir);
    const dangerousResult = checkDangerous(command, config);
    if (dangerousResult) {
      const result =
        dangerousResult.mode === 'ask'
          ? { ask: true, askReason: `[succ guard] ${dangerousResult.reason}` }
          : { deny: true, denyReason: `[succ guard] ${dangerousResult.reason}` };
      const { json, exitCode } = adapter.formatOutput(agent, 'PreToolUse', result);
      console.log(JSON.stringify(json));
      process.exit(exitCode);
    }

    // 4. Hook rule ask (after safety guard, so deny takes priority)
    if (askReason) {
      const { json, exitCode } = adapter.formatOutput(agent, 'PreToolUse', {
        ask: true,
        askReason: `[succ rule] ${askReason}`,
      });
      console.log(JSON.stringify(json));
      process.exit(exitCode);
    }

    // 5. Git commit / PR — inject guidelines or undercover reminder
    if (config.undercover === true) {
      if (/\bgit\s+commit\b/.test(command) || /\bgh\s+pr\s+(create|edit)\b/.test(command)) {
        contextParts.push(`<undercover-reminder>
UNDERCOVER: No AI attribution, no "Generated with", no "Co-Authored-By", no tool names, no AI labels.
No AI-revealing branch names (claude/, copilot/, ai/).
Write as a human developer. Match existing project style.
</undercover-reminder>`);
        // Still inject pre-commit-review if enabled (independent of undercover)
        if (/\bgit\s+commit\b/.test(command) && config.preCommitReview) {
          contextParts.push(`<pre-commit-review>
STOP. Before committing, you MUST run the succ-diff-reviewer agent first.
Use: Task tool with subagent_type="succ-diff-reviewer"
Prompt: "Review the staged git diff for bugs, security issues, and regressions before commit"

If diff-reviewer finds CRITICAL issues — do NOT commit until fixed.
If diff-reviewer finds HIGH issues — warn the user before committing.
MEDIUM and below — commit is OK, mention findings in summary.
</pre-commit-review>`);
        }
      }
    } else if (/\bgit\s+commit\b/.test(command)) {
      const commitContext = buildCommitContext(config);
      if (commitContext) {
        contextParts.push(commitContext);
      }
    }
  } else if (askReason) {
    // Non-Bash ask rule
    const { json, exitCode } = adapter.formatOutput(agent, 'PreToolUse', {
      ask: true,
      askReason: `[succ rule] ${askReason}`,
    });
    console.log(JSON.stringify(json));
    process.exit(exitCode);
  }

  // 5.5. Context pressure advisory (fail-open, 500ms timeout)
  try {
    const port = ensureDaemonLazy(projectDir, succDir);
    if (port && hookInput.session_id) {
      const usageRes = await fetch(
        `http://127.0.0.1:${port}/api/context-usage?session_id=${encodeURIComponent(hookInput.session_id)}`,
        { signal: AbortSignal.timeout(500) }
      );
      if (usageRes.ok) {
        const usage = await usageRes.json();
        if (usage.should_compact && !usage.cooldown_active) {
          const advisory = formatCompactAdvisory(usage);
          if (advisory) {
            contextParts.push(advisory);
            // ACK: mark cooldown AFTER successful advisory push (prevents consumed cooldown on hook failure)
            fetch(
              `http://127.0.0.1:${port}/api/context-usage/ack?session_id=${encodeURIComponent(hookInput.session_id)}`,
              { method: 'POST', signal: AbortSignal.timeout(300) }
            ).catch((e) => {
              console.error('[succ:pre-tool] context-usage ack failed:', e.message || e);
            });
          }
        }
      }
    }
  } catch (e) {
    console.error('[succ:pre-tool] context pressure check failed:', e.message || e);
  }

  // 6. Emit combined context
  if (contextParts.length > 0) {
    const { json, exitCode } = adapter.formatOutput(agent, 'PreToolUse', {
      additionalContext: contextParts.join('\n'),
    });
    if (json && Object.keys(json).length > 0) {
      console.log(JSON.stringify(json));
    }
    if (exitCode) process.exit(exitCode);
  }

  process.exit(0);
});
