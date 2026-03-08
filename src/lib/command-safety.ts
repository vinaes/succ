/**
 * Command safety guard — blocks dangerous shell commands.
 *
 * Extracted from hooks/succ-pre-tool.cjs for reuse in daemon HTTP hook routes.
 * The .cjs hook keeps its own inline copy (CommonJS, no imports).
 */

import type { CommandSafetyGuardConfig, CommandSafetyPattern } from './config-types.js';

export interface DangerousPattern {
  pattern: RegExp;
  reason: string;
  checkPath?: boolean;
  /** Skip if command targets localhost/127.0.0.1 (local dev is safe) */
  exemptLocalhost?: boolean;
}

export interface DangerResult {
  reason: string;
  mode: 'deny' | 'ask';
}

export const DANGEROUS_PATTERNS: DangerousPattern[] = [
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
    pattern: /\bgit\s+restore\s+\.\s*($|[;&|])/,
    reason: 'git restore . discards all modifications.',
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
    reason: 'git filter-branch rewrites history and can destroy data. Use git filter-repo instead.',
  },
  {
    pattern: /\bgit\s+.*--no-verify\b/,
    reason: 'git --no-verify skips pre-commit hooks (safety checks bypassed).',
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
  {
    pattern: /\brm\s+-r\s+\/\s/,
    reason: 'rm -r / would destroy the entire filesystem.',
  },
  {
    pattern: /\brm\s+-r\s+~(?:\s|\/|$)/,
    reason: 'rm -r ~ would destroy the entire home directory.',
  },
  {
    pattern: /\bshred\b/,
    reason: 'shred permanently overwrites file data beyond recovery.',
  },
  {
    pattern: /\bdd\s+.*\bof=\/dev\//,
    reason: 'dd writing to /dev/ devices can destroy disk data.',
  },
  {
    pattern: /\bmkfs\b/,
    reason: 'mkfs formats a filesystem, destroying all existing data.',
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

  // ── Infrastructure — cloud/k8s destruction ──
  {
    pattern: /\bterraform\s+destroy\b/,
    reason: 'terraform destroy tears down all managed infrastructure.',
  },
  {
    pattern: /\bkubectl\s+delete\s+(?:ns|namespace)\b/,
    reason: 'kubectl delete namespace removes the entire namespace and all resources.',
  },
  {
    pattern: /\bkubectl\s+delete\s+.*--all\b/,
    reason: 'kubectl delete --all removes all resources of the specified type.',
  },
  {
    pattern: /\bhelm\s+uninstall\b/,
    reason: 'helm uninstall removes a Helm release and its resources.',
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

  // ── Redis — database destruction ──
  {
    pattern: /\bredis-cli\b.*\bFLUSHALL\b/i,
    reason: 'FLUSHALL removes all data from all Redis databases.',
  },
  {
    pattern: /\bredis-cli\b.*\bFLUSHDB\b/i,
    reason: 'FLUSHDB removes all data from the current Redis database.',
  },

  // ── MongoDB — database destruction ──
  {
    pattern: /\bmongo(?:sh)?\b.*\bdropDatabase\b/,
    reason: 'dropDatabase permanently deletes a MongoDB database.',
  },
  {
    pattern: /\bmongo(?:sh)?\b.*\.drop\s*\(/,
    reason: '.drop() permanently deletes a MongoDB collection.',
  },

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

  // ── Permissions — dangerous changes ──
  {
    pattern: /\bchmod\s+-R\s+777\b/,
    reason: 'chmod -R 777 makes everything world-writable (security risk).',
  },
  {
    pattern: /\bchmod\s+-R\s+666\b/,
    reason: 'chmod -R 666 makes all files world-writable (security risk).',
  },
  {
    pattern: /\bchown\s+-R\s+root\b/,
    reason: 'chown -R root changes ownership recursively (may lock you out).',
  },

  // ── Disk operations — destructive ──
  {
    pattern: /\bfdisk\b/,
    reason: 'fdisk modifies disk partition tables (potential data loss).',
  },
  {
    pattern: /\bparted\b/,
    reason: 'parted modifies disk partitions (potential data loss).',
  },
  {
    pattern: /\bwipefs\b/,
    reason: 'wipefs erases filesystem signatures (potential data loss).',
  },

  // ── Process termination ──
  {
    pattern: /\bkillall\b/,
    reason: 'killall terminates all processes matching the name.',
  },
  {
    pattern: /\bkill\s+-9\b/,
    reason: 'kill -9 forcefully terminates without cleanup (SIGKILL).',
  },
  {
    pattern: /\bkill\s+-(?:KILL|SIGKILL)\b/,
    reason: 'kill -KILL forcefully terminates without cleanup.',
  },

  // ── Lockfile deletion (via rm) ──
  {
    pattern: /\brm\s+.*package-lock\.json\b/,
    reason: 'Deleting package-lock.json can cause dependency resolution issues.',
  },
  {
    pattern: /\brm\s+.*yarn\.lock\b/,
    reason: 'Deleting yarn.lock can cause dependency resolution issues.',
  },
  {
    pattern: /\brm\s+.*pnpm-lock\.yaml\b/,
    reason: 'Deleting pnpm-lock.yaml can cause dependency resolution issues.',
  },

  // ── Exfiltration — data theft ──
  {
    pattern: /\bcurl\b.*(?:-d\b|--data\b|--form\b)/,
    reason: 'curl with data flags can exfiltrate information to external servers.',
    checkPath: false,
    // Exempt localhost/127.0.0.1 — local dev is safe
    exemptLocalhost: true,
  },
  {
    pattern: /\bwget\s+--post-data\b/,
    reason: 'wget --post-data can exfiltrate information.',
  },
  {
    pattern: /\bnc\s+-[a-zA-Z]*\s/,
    reason: 'netcat can be used for data exfiltration or reverse shells.',
  },
  {
    pattern: /\bbase64\b.*\|\s*\bcurl\b/,
    reason: 'Piping base64 to curl is a common exfiltration pattern.',
  },
  {
    pattern: /\bcat\b.*\|\s*\bcurl\b/,
    reason: 'Piping file contents to curl can exfiltrate sensitive data.',
  },

  // ── Supply chain — untrusted sources ──
  {
    pattern: /\bcurl\b.*\|\s*(?:bash|sh|zsh)\b/,
    reason: 'Piping curl to shell executes untrusted remote code.',
  },
  {
    pattern: /\bwget\b.*\|\s*(?:bash|sh|zsh)\b/,
    reason: 'Piping wget to shell executes untrusted remote code.',
  },
  {
    pattern: /\bpip\s+install\s+-i\s/,
    reason: 'pip install -i uses a custom index (supply chain risk).',
  },
  {
    pattern: /\bnpm\s+install\s+--registry\s/,
    reason: 'npm install --registry uses a custom registry (supply chain risk).',
  },
];

/** Paths where rm -rf is considered safe (normalized, lowercase) */
export const SAFE_RM_PATHS = [
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

// ─── File Operation Guards ───────────────────────────────────────────

export interface FileGuardResult {
  reason: string;
  mode: 'deny' | 'ask';
}

/** File extensions that should NEVER be read/written (private keys, certs) */
const SENSITIVE_FILE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'];

/** Files that should NEVER be deleted (critical project files) */
const PROTECTED_DELETE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
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
    reason: 'Lockfile ensures reproducible builds — deletion can cause dependency issues.',
  },
  {
    pattern: /yarn\.lock$/i,
    reason: 'Lockfile ensures reproducible builds — deletion can cause dependency issues.',
  },
  {
    pattern: /pnpm-lock\.yaml$/i,
    reason: 'Lockfile ensures reproducible builds — deletion can cause dependency issues.',
  },
];

/** File patterns that should prompt user (ask mode) on write */
const ASK_ON_WRITE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\.env(?:\.|$)/i,
    reason: '.env files may contain secrets — verify content before writing.',
  },
];

/** Exfiltration URL blocklist (domains commonly used for data theft) */
export const EXFIL_URL_BLOCKLIST = [
  'pastebin.com',
  'hastebin.com',
  'paste.ee',
  'dpaste.org',
  'transfer.sh',
  'file.io',
  '0x0.st',
  'webhook.site',
  'requestbin.com',
  'hookbin.com',
  'pipedream.net',
  'ngrok.io',
  'ngrok.app',
  'burpcollaborator.net',
  'interact.sh',
  'canarytokens.com',
];

/**
 * Check if a file operation (Read, Write, Edit) should be guarded.
 * @param operation - 'read' | 'write' | 'delete'
 * @param filePath - absolute or relative file path
 * @param mode - guard mode from config (default: 'deny')
 */
export function checkFileOperation(
  operation: 'read' | 'write' | 'delete',
  filePath: string,
  mode: 'deny' | 'ask' | 'off' = 'deny'
): FileGuardResult | null {
  if (mode === 'off') return null;

  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const basename = normalized.split('/').pop() || '';
  const parts = basename.split('.');

  // Skip node_modules and .git internals
  if (normalized.includes('/node_modules/') || normalized.includes('/.git/')) return null;

  // Sensitive file extensions — deny read/write (check ALL extensions, e.g. file.pem.bak)
  if (operation === 'read' || operation === 'write') {
    for (let i = 1; i < parts.length; i++) {
      const ext = '.' + parts[i];
      if (SENSITIVE_FILE_EXTENSIONS.includes(ext)) {
        return {
          reason: `${ext} files contain private keys/certificates — ${operation} blocked for security.`,
          mode: mode as 'deny' | 'ask',
        };
      }
    }
  }

  // Protected files — deny delete
  if (operation === 'delete') {
    for (const { pattern, reason } of PROTECTED_DELETE_PATTERNS) {
      if (pattern.test(normalized)) {
        return { reason, mode: mode as 'deny' | 'ask' };
      }
    }
  }

  // .env files — ask on write
  if (operation === 'write') {
    for (const { pattern, reason } of ASK_ON_WRITE_PATTERNS) {
      if (pattern.test(normalized)) {
        return { reason, mode: 'ask' };
      }
    }
  }

  return null;
}

/**
 * Check if a URL appears in the exfiltration blocklist.
 */
export function isExfilUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return EXFIL_URL_BLOCKLIST.some((domain) => lower.includes(domain));
}

/** Prefixes that indicate the command is data, not execution (ONLY for single commands) */
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

/** Max regex pattern length to prevent ReDoS from user-authored patterns */
const MAX_REGEX_LENGTH = 200;

/**
 * Split a shell command line into individual commands separated by ;, &&, ||, |.
 * Respects quoted strings (single and double quotes).
 */
function splitShellCommands(command: string): string[] {
  const parts: string[] = [];
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
      // Check for && || ; |
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

/**
 * Check if command is in a data context (grep, echo, comment, etc.)
 * Only returns true if ALL sub-commands in the line are data context.
 * This prevents bypass via `echo ok && rm -rf .succ`.
 * Also rejects commands with subshell expansion $(...) or backticks
 * since those execute even inside echo/printf.
 */
export function isDataContext(command: string): boolean {
  const parts = splitShellCommands(command);
  if (parts.length === 0) return true;
  return parts.every((part) => {
    const trimmed = part.trim();
    // Reject if contains subshell expansion — these execute even inside echo/printf
    if (/\$\(/.test(trimmed) || /`[^`]+`/.test(trimmed)) return false;
    return DATA_PREFIXES.some((prefix) => prefix.test(trimmed));
  });
}

/** Check if rm -rf target is a safe path */
export function isRmPathSafe(command: string): boolean {
  // Match both short flags (-rf, -fr) and long flags (--recursive --force, -r --force, etc.)
  const match = command.match(
    /\brm\s+(?:-[a-zA-Z]*(?:rf|fr)[a-zA-Z]*|(?:--recursive\s+--force|--force\s+--recursive|-r\s+--force|--force\s+-r|-f\s+--recursive|--recursive\s+-f))\s+(.+?)(?:\s*[;&|]|$)/
  );
  if (!match) return false;

  const target = match[1].trim().replace(/["']/g, '');
  let normalized = target.toLowerCase().replace(/\\/g, '/');

  // Resolve path traversal (../.. ) to prevent /tmp/../etc/passwd bypass
  // Collapse /../ segments manually since path.resolve isn't available here
  const segments = normalized.split('/');
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '..') {
      resolved.pop(); // go up one level
    } else if (seg !== '.') {
      resolved.push(seg);
    }
  }
  normalized = resolved.join('/');

  return SAFE_RM_PATHS.some((safe) => {
    if (normalized === safe || normalized.endsWith('/' + safe)) return true;
    if (safe === '/tmp' && normalized.startsWith('/tmp/')) return true;
    if (safe === '/var/tmp' && normalized.startsWith('/var/tmp/')) return true;
    return false;
  });
}

/** Extract safety config from a parsed SuccConfig object */
export function extractSafetyConfig(guard?: CommandSafetyGuardConfig): {
  mode: 'deny' | 'ask' | 'off';
  allowlist: string[];
  customPatterns: CommandSafetyPattern[];
} {
  return {
    mode: guard?.mode ?? 'deny',
    allowlist: guard?.allowlist ?? [],
    customPatterns: guard?.customPatterns ?? [],
  };
}

/**
 * Check if a command is dangerous.
 * Returns null if safe, or { reason, mode } if dangerous.
 */
export function checkDangerous(
  command: string,
  config: {
    mode: 'deny' | 'ask' | 'off';
    allowlist: string[];
    customPatterns: CommandSafetyPattern[];
  }
): DangerResult | null {
  if (config.mode === 'off') return null;

  // Check allowlist — each entry is tested as an anchored regex against the full command.
  // Examples: "^git push$" (exact), "^npm test" (prefix), "^git push(?! .*(--force|-f))" (push but not force)
  const trimmed = command.trim();
  for (const allowed of config.allowlist) {
    if (allowed.length > MAX_REGEX_LENGTH) continue; // ReDoS guard
    try {
      if (new RegExp(allowed).test(trimmed)) return null;
    } catch {
      // Invalid regex — try as literal exact match fallback
      if (trimmed === allowed) return null;
    }
  }

  // Skip if command is in a data context
  if (isDataContext(command)) return null;

  // Check built-in patterns
  for (const { pattern, reason, checkPath, exemptLocalhost } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      if (checkPath && isRmPathSafe(command)) continue;
      // Require host to be followed by port/path/quote/space/end — prevents localhost.evil.com bypass
      if (
        exemptLocalhost &&
        /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/'")\s]|$)/.test(command)
      )
        continue;
      return { reason, mode: config.mode as 'deny' | 'ask' };
    }
  }

  // Check user-defined custom patterns
  for (const custom of config.customPatterns) {
    if (custom.pattern.length > MAX_REGEX_LENGTH) continue; // ReDoS guard
    try {
      const regex = new RegExp(custom.pattern, custom.flags || '');
      if (regex.test(command)) {
        return {
          reason: custom.reason || `Blocked by custom pattern: ${custom.pattern}`,
          mode: config.mode as 'deny' | 'ask',
        };
      }
    } catch {
      // Invalid regex — skip
    }
  }

  return null;
}
