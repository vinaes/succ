/**
 * Tracks analyze state for incremental re-analysis.
 * Stores which agents were run, when, and what the project state was.
 * Allows skipping agents whose outputs are still fresh.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

export interface AgentState {
  lastRun: string; // ISO timestamp
  outputHash: string; // MD5 of output content
}

export interface AnalyzeState {
  lastRun: string; // ISO timestamp
  gitCommit: string; // HEAD at last run
  fileCount: number;
  agents: Record<string, AgentState>;
}

const STATE_FILE = 'analyze-state.json';

export function loadAnalyzeState(succDir: string): AnalyzeState | null {
  const statePath = path.join(succDir, STATE_FILE);
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveAnalyzeState(succDir: string, state: AnalyzeState): void {
  const statePath = path.join(succDir, STATE_FILE);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Get current git HEAD commit hash, or empty string if not a git repo.
 */
export function getGitHead(projectRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Get list of files changed since a given commit.
 */
export function getChangedFiles(projectRoot: string, sinceCommit: string): string[] {
  if (!sinceCommit) return [];
  try {
    const output = execFileSync('git', ['diff', '--name-only', sinceCommit, 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    return output ? output.split('\n') : [];
  } catch {
    return [];
  }
}

/**
 * Compute MD5 hash of a file's content.
 */
export function hashFile(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf-8');
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Determine if an agent should be re-run based on changed files.
 */
export function shouldRerunAgent(
  agentName: string,
  state: AnalyzeState,
  changedFiles: string[]
): boolean {
  const agentState = state.agents[agentName];
  if (!agentState) return true; // Never run before

  // No changes at all — skip
  if (changedFiles.length === 0) return false;

  // Agent-specific rules
  switch (agentName) {
    case 'dependencies':
      // Only re-run if package.json, go.mod, etc. changed
      return changedFiles.some((f) =>
        /^(package\.json|go\.mod|pyproject\.toml|Cargo\.toml|requirements\.txt)$/.test(
          path.basename(f)
        )
      );

    case 'architecture':
      // Re-run if new directories appeared or >20% of files changed
      return (
        changedFiles.length > 10 ||
        changedFiles.some((f) => f.split('/').length <= 2 && !f.includes('.'))
      );

    case 'conventions':
      // Re-run if >15% of source files changed
      return changedFiles.filter((f) => /\.(ts|js|go|py|rs|java)$/.test(f)).length > 10;

    case 'api':
      // Re-run if route/handler/controller files changed
      return changedFiles.some((f) => /(route|handler|controller|api|endpoint|server)/i.test(f));

    case 'systems-overview':
    case 'features':
      // These are expensive multi-file agents — re-run if >10% files changed
      return changedFiles.length > 5;

    case 'strategy':
      // Only re-run if README or docs changed significantly
      return changedFiles.some((f) => /^(README|CHANGELOG|docs\/)/i.test(f) || /\.md$/i.test(f));

    default:
      return true;
  }
}
