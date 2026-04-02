/**
 * Undercover mode — hide all AI/succ attribution in commits, PRs, and code.
 *
 * Best-effort approach using:
 * - succ config toggle (undercover: true)
 * - Claude Code project settings overrides (.claude/settings.local.json)
 * - Strong XML hook injections (SessionStart, PreToolUse)
 * - Runtime suppression of all succ attribution
 *
 * Claude settings are defense-in-depth only — the XML hook injections are
 * the primary enforcement mechanism. Multiple open issues report Claude Code
 * attribution settings being intermittently ignored.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { logWarn } from './fault-logger.js';
import { getErrorMessage } from './errors.js';

// ─── XML Blocks ─────────────────────────────────────────────────────

/**
 * Expanded XML block injected at session start — highest priority context.
 * Covers: git attribution, branch naming, PR labels, code writing style, issue comments.
 */
export const UNDERCOVER_SESSION_BLOCK = `<undercover priority="critical" source="succ" mode="public-repo">
UNDERCOVER MODE — CRITICAL

You are operating UNDERCOVER in a PUBLIC/OPEN-SOURCE repository.
Your commit messages, PR titles, PR bodies, code, comments, and user-visible output
MUST NOT reveal that you are an AI or expose any internal tooling. Do not blow your cover.

## Git & PR Attribution
NEVER include:
- "Claude Code", "succ", "Anthropic", or any statement that you are an AI
- Model codenames, model names, model versions, or hints about what model/version you are
- Internal repo/project names, internal tooling, Slack channels, or short links
- "Generated with ...", "powered by ...", "Co-Authored-By", or any attribution footer/trailer

Write commit messages and PR text as a human developer would.
Describe only what the code change does and why.

## Branch Naming
NEVER create branches with AI-related prefixes: claude/, copilot/, ai/, ai-generated/, bot/.
Use conventional branch names: feature/, fix/, chore/, refactor/, docs/.

## PR Labels
Do NOT add labels like "ai-generated", "copilot", "claude", or similar AI-revealing labels.

## Code Writing Style
Write code the way a human developer would. Specifically:
- Match the existing comment style in the codebase. Do NOT over-comment.
- Do NOT add JSDoc/docstrings to every function — only where the project convention requires it.
- Do NOT add "explanatory" comments that state the obvious (e.g. \`// increment counter\` above \`counter++\`).
- Do NOT add comments like "Added by ...", "AI-generated", "Helper function to ..." on trivial code.
- Keep inline comments terse and only where logic is non-obvious — as a human would.
- Match the codebase's existing naming conventions, formatting, and idiom density.
- If the project has sparse comments, write sparse comments. If verbose, match that.

## Issue Comments
Write issue and PR review comments as a developer, not an assistant.
No "I'd be happy to help" or "Here's what I found" phrasing.

GOOD commit messages:
- "Fix race condition in file watcher initialization"
- "Add support for custom key bindings"

BAD commit messages:
- "Generated with Claude Code"
- "Co-Authored-By: Claude ..."
</undercover>`;

/**
 * Compact XML reminder for PreToolUse git commit/PR intercepts.
 */
export const UNDERCOVER_COMMIT_REMINDER = `<undercover-reminder>
UNDERCOVER: No AI attribution, no "Generated with", no "Co-Authored-By", no tool names, no AI labels.
No AI-revealing branch names (claude/, copilot/, ai/).
Write as a human developer. Match existing project style.
</undercover-reminder>`;

// ─── State Types ────────────────────────────────────────────────────

/** Snapshot of Claude settings managed fields — used for restore on disable. */
interface UndercoverSnapshot {
  /** Timestamp when snapshot was created */
  createdAt: string;
  /** Original values of managed fields (undefined means key was absent) */
  managed: {
    includeGitInstructions?: boolean;
    includeCoAuthoredBy?: boolean;
    attribution?: { commit?: string; pr?: string };
  };
  /** Track which keys existed before we wrote them */
  keysExisted: {
    includeGitInstructions: boolean;
    includeCoAuthoredBy: boolean;
    attribution: boolean;
  };
}

/** Values we write to Claude settings when undercover is enabled. */
const UNDERCOVER_SETTINGS = {
  includeGitInstructions: false,
  includeCoAuthoredBy: false,
  attribution: { commit: '', pr: '' },
} as const;

// ─── Core Functions ─────────────────────────────────────────────────

/**
 * Convenience check: is undercover mode enabled?
 */
export function isUndercover(): boolean {
  try {
    return getConfig().undercover === true;
  } catch {
    logWarn('undercover', 'Failed to read config for undercover check');
    return false;
  }
}

/**
 * Sync Claude Code local settings for undercover mode.
 *
 * On enable: snapshot current managed fields, then write suppression values.
 * On disable: restore from snapshot if managed fields still match undercover values.
 *
 * Writes to .claude/settings.local.json (gitignored by convention) — never settings.json.
 * Fail-open: logs warnings, never throws.
 *
 * @param projectRoot Absolute path to the project root
 * @param enable Whether to enable or disable undercover settings
 */
export function syncClaudeSettings(projectRoot: string, enable: boolean): void {
  try {
    const claudeDir = path.join(projectRoot, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.local.json');
    const succDir = path.join(projectRoot, '.succ');
    const statePath = path.join(succDir, 'claude-undercover-state.json');

    if (enable) {
      enableUndercover(claudeDir, settingsPath, succDir, statePath);
    } else {
      disableUndercover(settingsPath, statePath);
    }
  } catch (err: unknown) {
    logWarn('undercover', `syncClaudeSettings(enable=${enable}) failed: ${getErrorMessage(err)}`);
  }
}

/**
 * Verify .succ/ and .claude/ are in .gitignore, warn if not.
 * Does not modify .gitignore — just logs warnings.
 *
 * @param projectRoot Absolute path to the project root
 */
export function ensureGitignore(projectRoot: string): void {
  try {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      logWarn(
        'undercover',
        '.gitignore not found — .succ/ and .claude/ may be committed to the repo'
      );
      return;
    }

    const content = fs.readFileSync(gitignorePath, 'utf8');
    const lines = content.split('\n');

    // Match common .succ ignore patterns: .succ, .succ/, .succ/*, .succ/**, **/.succ, etc.
    const succIgnorePattern = /^(?:\*\*\/)?\.succ(?:\/\*{0,2})?$/;
    const succIgnored = lines.some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      return succIgnorePattern.test(trimmed);
    });
    if (!succIgnored) {
      logWarn(
        'undercover',
        '.succ/ is not in .gitignore — succ state files may be committed to a public repo'
      );
    }

    // Match common .claude ignore patterns: .claude, .claude/, .claude/*, .claude/**, **/.claude, etc.
    const claudeIgnorePattern = /^(?:\*\*\/)?\.claude(?:\/\*{0,2})?$/;
    const claudeIgnored = lines.some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      return claudeIgnorePattern.test(trimmed);
    });
    if (!claudeIgnored) {
      logWarn(
        'undercover',
        '.claude/ is not in .gitignore — Claude settings may be committed to a public repo'
      );
    }
  } catch (err: unknown) {
    logWarn('undercover', `ensureGitignore check failed: ${getErrorMessage(err)}`);
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────

/** Validate parsed JSON is a plain object (not null, array, or primitive). */
function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function enableUndercover(
  claudeDir: string,
  settingsPath: string,
  succDir: string,
  statePath: string
): void {
  // Ensure directories exist
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  if (!fs.existsSync(succDir)) {
    fs.mkdirSync(succDir, { recursive: true });
  }

  // Load current settings
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = asPlainObject(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
      if (parsed) {
        settings = parsed;
      } else {
        logWarn('undercover', `${settingsPath} must contain a JSON object`);
      }
    } catch (err: unknown) {
      logWarn('undercover', `Failed to parse ${settingsPath}: ${getErrorMessage(err)}`);
      settings = {};
    }
  }

  // Create snapshot only if one doesn't already exist (avoid overwriting original values)
  if (!fs.existsSync(statePath)) {
    const snapshot: UndercoverSnapshot = {
      createdAt: new Date().toISOString(),
      managed: {
        includeGitInstructions: settings.includeGitInstructions as boolean | undefined,
        includeCoAuthoredBy: settings.includeCoAuthoredBy as boolean | undefined,
        attribution: settings.attribution as { commit?: string; pr?: string } | undefined,
      },
      keysExisted: {
        includeGitInstructions: 'includeGitInstructions' in settings,
        includeCoAuthoredBy: 'includeCoAuthoredBy' in settings,
        attribution: 'attribution' in settings,
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(snapshot, null, 2));
  }

  // Write undercover values — preserving all other keys
  settings.includeGitInstructions = UNDERCOVER_SETTINGS.includeGitInstructions;
  settings.includeCoAuthoredBy = UNDERCOVER_SETTINGS.includeCoAuthoredBy;
  settings.attribution = { ...UNDERCOVER_SETTINGS.attribution };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function disableUndercover(settingsPath: string, statePath: string): void {
  // No snapshot means nothing to restore
  if (!fs.existsSync(statePath)) {
    logWarn('undercover', 'No undercover snapshot found — nothing to restore');
    return;
  }

  let snapshot: UndercoverSnapshot;
  try {
    const parsed = asPlainObject(JSON.parse(fs.readFileSync(statePath, 'utf8')));
    if (!parsed) {
      logWarn('undercover', `Undercover snapshot must be a JSON object — deleting`);
      safeUnlink(statePath);
      return;
    }
    snapshot = parsed as unknown as UndercoverSnapshot;
  } catch (err: unknown) {
    logWarn('undercover', `Failed to parse undercover snapshot: ${getErrorMessage(err)}`);
    // Delete corrupted snapshot
    safeUnlink(statePath);
    return;
  }

  // If settings file doesn't exist, keep snapshot for future restore attempts
  if (!fs.existsSync(settingsPath)) {
    logWarn(
      'undercover',
      'settings.local.json was deleted while undercover was enabled — keeping snapshot for retry'
    );
    return;
  }

  let settings: Record<string, unknown>;
  try {
    const parsed = asPlainObject(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    if (!parsed) {
      logWarn(
        'undercover',
        `${settingsPath} must contain a JSON object — keeping snapshot for retry`
      );
      return;
    }
    settings = parsed;
  } catch (err: unknown) {
    logWarn('undercover', `Failed to parse ${settingsPath} for restore: ${getErrorMessage(err)}`);
    return;
  }

  // Verify current values still match undercover-managed values before restoring.
  // If user manually changed any managed field, skip restore and respect their edits.
  if (!managedValuesMatch(settings)) {
    logWarn(
      'undercover',
      'Managed Claude settings were manually edited while undercover was active — skipping restore'
    );
    safeUnlink(statePath);
    return;
  }

  // Restore original values
  if (snapshot.keysExisted.includeGitInstructions) {
    settings.includeGitInstructions = snapshot.managed.includeGitInstructions;
  } else {
    delete settings.includeGitInstructions;
  }

  if (snapshot.keysExisted.includeCoAuthoredBy) {
    settings.includeCoAuthoredBy = snapshot.managed.includeCoAuthoredBy;
  } else {
    delete settings.includeCoAuthoredBy;
  }

  if (snapshot.keysExisted.attribution) {
    settings.attribution = snapshot.managed.attribution;
  } else {
    delete settings.attribution;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  safeUnlink(statePath);
}

/**
 * Check if current settings still have the exact undercover-managed values.
 * Returns false if user manually edited any managed field.
 */
function managedValuesMatch(settings: Record<string, unknown>): boolean {
  if (settings.includeGitInstructions !== UNDERCOVER_SETTINGS.includeGitInstructions) {
    return false;
  }
  if (settings.includeCoAuthoredBy !== UNDERCOVER_SETTINGS.includeCoAuthoredBy) {
    return false;
  }
  const attr = settings.attribution as { commit?: string; pr?: string } | undefined;
  if (!attr || attr.commit !== '' || attr.pr !== '') {
    return false;
  }
  return true;
}

/** Safe unlink — log warning on failure, never throw. */
function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err: unknown) {
    logWarn('undercover', `Failed to delete ${filePath}: ${getErrorMessage(err)}`);
  }
}
