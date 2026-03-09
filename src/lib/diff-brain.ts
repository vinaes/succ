/**
 * Diff-Aware Brain Vault Analysis — only re-analyze touched modules.
 *
 * Phase 5.3: `analyze --diff` → detect changed files → re-analyze only
 * those modules → show what changed in brain docs.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import { getProjectRoot } from './config.js';
import { logInfo, logWarn } from './fault-logger.js';

// ============================================================================
// Types
// ============================================================================

export interface DiffAnalysisResult {
  /** Files that changed since the reference point */
  changedFiles: string[];
  /** Files that need re-analysis (source code only) */
  filesToAnalyze: string[];
  /** Brain vault docs that may be affected */
  affectedDocs: string[];
  /** Reference (commit, branch, etc.) */
  reference: string;
}

// ============================================================================
// Analysis
// ============================================================================

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.go',
  '.rs',
  '.rb',
  '.java',
  '.kt',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.vue',
  '.svelte',
  '.php',
  '.swift',
  '.scala',
]);

/**
 * Detect changed files from a git diff reference.
 *
 * @param diffRef - Git reference to diff against (default: HEAD~1)
 * @returns Files that changed and need re-analysis
 */
export function detectChangedFiles(diffRef: string = 'HEAD~1'): DiffAnalysisResult {
  const projectRoot = getProjectRoot();

  // Validate diffRef — reject anything that looks like a git flag
  if (!/^[a-zA-Z0-9_./@~^{}-]+$/.test(diffRef) || diffRef.startsWith('-')) {
    throw new Error(`Invalid diff reference: ${diffRef}`);
  }

  let changedFiles: string[] = [];
  try {
    // Use execFileSync with '--' separator to prevent argument injection
    const output = execFileSync('git', ['diff', '--name-only', '--', diffRef], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 10000,
    });

    changedFiles = output
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  } catch (error) {
    logWarn('diff-brain', 'git diff failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      changedFiles: [],
      filesToAnalyze: [],
      affectedDocs: [],
      reference: diffRef,
    };
  }

  // Filter to source code files
  const filesToAnalyze = changedFiles.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return CODE_EXTENSIONS.has(ext);
  });

  // Find affected brain docs
  const affectedDocs = findAffectedBrainDocs(filesToAnalyze, projectRoot);

  logInfo(
    'diff-brain',
    `${changedFiles.length} changed files, ${filesToAnalyze.length} to analyze, ${affectedDocs.length} brain docs affected`
  );

  return {
    changedFiles,
    filesToAnalyze,
    affectedDocs,
    reference: diffRef,
  };
}

/**
 * Find brain vault docs that correspond to changed source files.
 */
function findAffectedBrainDocs(sourceFiles: string[], projectRoot: string): string[] {
  const brainDir = path.join(projectRoot, '.succ', 'brain');
  const affected: string[] = [];

  for (const srcFile of sourceFiles) {
    // Convention: brain docs are named after the directory they describe
    const dir = path.dirname(srcFile);
    const parts = dir.split('/');

    // Check for brain docs at each directory level
    for (let i = 1; i <= parts.length; i++) {
      const subpath = parts.slice(0, i).join('-');
      const brainFile = path.join(brainDir, `${subpath}.md`);
      if (!affected.includes(brainFile)) {
        affected.push(brainFile);
      }
    }
  }

  return affected;
}
