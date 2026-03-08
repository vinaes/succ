/**
 * File Label Assignment — 4-layer label resolution for BLP IFC
 *
 * Assigns SecurityLabels to files using conservative (highest wins) layering:
 *   1. Extension-based (deterministic, instant)
 *   2. Path-based (deterministic, instant)
 *   3. Content-based regex (deterministic, requires file content)
 *   4. LLM classification (Phase 3, opt-in)
 *
 * Label assignment is monotonic — higher label always wins.
 */

import {
  type SecurityLabel,
  type SecurityLevel,
  type Compartment,
  makeLabel,
  join,
  isBottom,
  BOTTOM,
} from './label.js';

// ─── Layer 1: Extension-based labels ────────────────────────────────

interface ExtensionRule {
  extensions: string[];
  label: SecurityLabel;
}

const EXTENSION_RULES: ExtensionRule[] = [
  // Highly confidential: private keys and certs
  {
    extensions: ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'],
    label: makeLabel(3, ['credentials']),
  },
  // Confidential: environment files with secrets
  {
    extensions: ['.env', '.env.local', '.env.production', '.env.staging', '.env.development'],
    label: makeLabel(2, ['secrets', 'credentials']),
  },
  // Internal: config files that may contain infrastructure info
  {
    extensions: ['.htpasswd', '.htaccess'],
    label: makeLabel(2, ['credentials']),
  },
  // Public: documentation
  {
    extensions: ['.md', '.txt', '.rst', '.adoc'],
    label: BOTTOM,
  },
];

function labelByExtension(filePath: string): SecurityLabel {
  const lower = filePath.toLowerCase().replace(/\\/g, '/');
  const basename = lower.split('/').pop() || '';

  // Check full basename match first (for .env, .env.local, .env.production, etc.)
  for (const rule of EXTENSION_RULES) {
    for (const ext of rule.extensions) {
      const name = ext.slice(1); // e.g. "env", "env.local", "pem"
      // Exact match: ".env" → basename ".env"
      if (basename === ext || basename === name) {
        return rule.label;
      }
      // Prefix match: ".env" rule matches ".env.production", ".env.staging", etc.
      // But NOT env.sh, env.py, etc. — only .env.* or bare env files
      if (ext === '.env' && basename.startsWith('.env.')) {
        return rule.label;
      }
      // Match bare "env" followed by dot-separated qualifiers (env.local, env.production)
      // but NOT env.sh, env.py, env.ts, etc. (script files)
      if (ext === '.env' && basename.startsWith('env.')) {
        const afterEnvDot = basename.slice(4); // after "env."
        // If it looks like a file extension (2-4 chars, common code ext), skip
        if (/^(?:sh|py|ts|js|rb|go|rs|pl|bat|cmd|ps1|php|java|c|h|cpp)$/i.test(afterEnvDot)) {
          // Not an env config file — skip
        } else {
          return rule.label;
        }
      }
    }
  }

  // Check by file extension (last dot segment)
  const lastDot = basename.lastIndexOf('.');
  if (lastDot >= 0) {
    const ext = basename.slice(lastDot);
    for (const rule of EXTENSION_RULES) {
      if (rule.extensions.includes(ext)) {
        return rule.label;
      }
    }
  }

  return BOTTOM;
}

// ─── Layer 2: Path-based labels ─────────────────────────────────────

interface PathRule {
  pattern: RegExp;
  label: SecurityLabel;
}

const PATH_RULES: PathRule[] = [
  // Secrets directories
  { pattern: /[/\\]secrets?[/\\]/i, label: makeLabel(3, ['secrets']) },
  { pattern: /[/\\]\.ssh[/\\]/i, label: makeLabel(3, ['credentials']) },
  { pattern: /[/\\]\.gnupg[/\\]/i, label: makeLabel(3, ['credentials']) },
  { pattern: /[/\\]private[/\\]/i, label: makeLabel(2, ['credentials']) },

  // Infrastructure
  { pattern: /[/\\]deploy[/\\]/i, label: makeLabel(2, ['internal_infra']) },
  { pattern: /[/\\]infrastructure[/\\]/i, label: makeLabel(2, ['internal_infra']) },
  { pattern: /[/\\]terraform[/\\]/i, label: makeLabel(2, ['internal_infra']) },
  { pattern: /[/\\]k8s[/\\]/i, label: makeLabel(2, ['internal_infra']) },
  { pattern: /[/\\]kubernetes[/\\]/i, label: makeLabel(2, ['internal_infra']) },
  { pattern: /[/\\]ansible[/\\]/i, label: makeLabel(2, ['internal_infra']) },

  // CI/CD configs (may contain deployment secrets)
  { pattern: /[/\\]\.github[/\\]workflows[/\\]/i, label: makeLabel(1, ['internal_infra']) },
  { pattern: /[/\\]\.gitlab-ci\.yml$/i, label: makeLabel(1, ['internal_infra']) },
  { pattern: /[/\\]\.circleci[/\\]/i, label: makeLabel(1, ['internal_infra']) },

  // Skip: node_modules, .git internals — not sensitive per se
  { pattern: /[/\\]node_modules[/\\]/i, label: BOTTOM },
  { pattern: /[/\\]\.git[/\\]/i, label: makeLabel(1) },
];

function labelByPath(filePath: string): SecurityLabel {
  const normalized = filePath.replace(/\\/g, '/');
  let result = BOTTOM;

  for (const rule of PATH_RULES) {
    if (rule.pattern.test(normalized)) {
      result = join(result, rule.label);
    }
  }

  return result;
}

// ─── Layer 3: Content-based regex labels ────────────────────────────

interface ContentPattern {
  pattern: RegExp;
  compartments: Compartment[];
  level: SecurityLevel;
}

const CONTENT_PATTERNS: ContentPattern[] = [
  // API keys / tokens (→ secrets)
  { pattern: /sk-(?:proj-)?[a-zA-Z0-9]{20,}/, compartments: ['secrets'], level: 3 },
  { pattern: /sk-ant-[a-zA-Z0-9-]{20,}/, compartments: ['secrets'], level: 3 },
  { pattern: /AKIA[0-9A-Z]{16}/, compartments: ['secrets'], level: 3 },
  { pattern: /gh[pousr]_[a-zA-Z0-9]{36}/, compartments: ['secrets'], level: 3 },
  { pattern: /github_pat_[a-zA-Z0-9]{22,}/, compartments: ['secrets'], level: 3 },
  { pattern: /glpat-[a-zA-Z0-9-]{20,}/, compartments: ['secrets'], level: 3 },
  { pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}/, compartments: ['secrets'], level: 3 },
  { pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/, compartments: ['secrets'], level: 2 },

  // Private keys (→ credentials)
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, compartments: ['credentials'], level: 3 },

  // Password assignments (→ secrets)
  { pattern: /(?:password|passwd|secret|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/, compartments: ['secrets'], level: 2 },

  // Connection strings (→ credentials + internal_infra)
  { pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@/, compartments: ['credentials', 'internal_infra'], level: 2 },

  // PII patterns
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, compartments: ['pii'], level: 2 }, // SSN
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i, compartments: ['pii'], level: 1 }, // Email (low level — very common)

  // Internal infrastructure markers
  { pattern: /(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})/, compartments: ['internal_infra'], level: 1 },
];

/**
 * Scan file content for sensitive patterns and return accumulated label.
 * Short-circuits if content is empty.
 */
export function labelByContent(content: string): SecurityLabel {
  if (!content || content.length === 0) return BOTTOM;

  let result = BOTTOM;

  for (const { pattern, compartments, level } of CONTENT_PATTERNS) {
    if (pattern.test(content)) {
      result = join(result, makeLabel(level, compartments));
    }
  }

  return result;
}

// ─── Combined label resolution ──────────────────────────────────────

export interface FileLabelOptions {
  /** File content (for Layer 3 content-based scanning). Omit to skip. */
  content?: string;
}

/**
 * Resolve the security label for a file using 3 deterministic layers.
 * Returns the join (LUB) of all applicable labels.
 *
 * Layer 4 (LLM classification) is handled externally in Phase 3.
 */
export function resolveFileLabel(filePath: string, options: FileLabelOptions = {}): SecurityLabel {
  // Normalize relative paths to have path separators for path-based rules
  const normalizedPath = filePath.includes('/') || filePath.includes('\\')
    ? filePath
    : './' + filePath;

  let result = BOTTOM;

  // Layer 1: Extension
  result = join(result, labelByExtension(normalizedPath));

  // Layer 2: Path
  result = join(result, labelByPath(normalizedPath));

  // Layer 3: Content (if provided)
  if (options.content) {
    result = join(result, labelByContent(options.content));
  }

  return result;
}

/**
 * Quick label check — extension + path only (no content scan).
 * Use for pre-tool checks where content isn't available yet.
 */
export function quickFileLabel(filePath: string): SecurityLabel {
  return join(labelByExtension(filePath), labelByPath(filePath));
}

// Re-export for convenience
export { BOTTOM, makeLabel, join, isBottom, type SecurityLabel, type Compartment } from './label.js';
