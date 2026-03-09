/**
 * Git Co-Change Graph — analyzes git history to find files that change together.
 *
 * Reveals architectural coupling. CodeScene pioneered this approach.
 * Uses `git log --name-only` to extract commit file lists, then computes
 * co-change pairs weighted by recency.
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { getProjectRoot } from '../config.js';
import { logInfo, logWarn } from '../fault-logger.js';

const execFile = promisify(execFileCb);

// ============================================================================
// Types
// ============================================================================

export interface CoChangePair {
  fileA: string;
  fileB: string;
  count: number;
  recencyWeight: number;
  score: number; // count * recencyWeight
}

export interface CoChangeResult {
  pairs: CoChangePair[];
  totalCommits: number;
  totalFiles: number;
}

export interface CoChangeForFile {
  file: string;
  cochanges: Array<{
    path: string;
    count: number;
    score: number;
  }>;
}

// ============================================================================
// Analysis
// ============================================================================

/**
 * Analyze git history for co-change patterns.
 *
 * @param maxCommits - Number of recent commits to analyze (default: 200)
 * @param minCooccurrence - Minimum co-change count to include (default: 2)
 */
export async function analyzeCoChanges(
  maxCommits: number = 200,
  minCooccurrence: number = 2
): Promise<CoChangeResult> {
  const projectRoot = getProjectRoot();

  // Get commit file lists
  let log: string;
  try {
    const { stdout } = await execFile(
      'git',
      [
        'log',
        '--name-only',
        '--pretty=format:---COMMIT---',
        `-${Math.floor(Math.abs(maxCommits))}`,
      ],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
      }
    );
    log = stdout;
  } catch (error) {
    logWarn('co-change', 'git log failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { pairs: [], totalCommits: 0, totalFiles: 0 };
  }

  // Parse into commit file lists
  const commits = parseCommitLog(log);
  const allFiles = new Set<string>();

  // Count co-changes with recency weighting
  const pairCounts = new Map<string, { count: number; recencySum: number }>();

  for (let i = 0; i < commits.length; i++) {
    const files = commits[i];
    // Recency: more recent commits have higher weight (1.0 to 0.1)
    const recency = 1.0 - (i / commits.length) * 0.9;

    for (const f of files) allFiles.add(f);

    // Generate all pairs within the commit
    for (let a = 0; a < files.length; a++) {
      for (let b = a + 1; b < files.length; b++) {
        const key = makePairKey(files[a], files[b]);
        const existing = pairCounts.get(key) ?? { count: 0, recencySum: 0 };
        existing.count++;
        existing.recencySum += recency;
        pairCounts.set(key, existing);
      }
    }
  }

  // Filter and sort
  const pairs: CoChangePair[] = [];
  for (const [key, { count, recencySum }] of pairCounts) {
    if (count < minCooccurrence) continue;
    const [fileA, fileB] = key.split('\0');
    const recencyWeight = recencySum / count;
    pairs.push({
      fileA,
      fileB,
      count,
      recencyWeight,
      score: count * recencyWeight,
    });
  }

  pairs.sort((a, b) => b.score - a.score);

  logInfo('co-change', `Analyzed ${commits.length} commits, found ${pairs.length} co-change pairs`);

  return {
    pairs,
    totalCommits: commits.length,
    totalFiles: allFiles.size,
  };
}

/**
 * Get co-changing files for a specific file.
 */
export async function getCoChangesForFile(
  filePath: string,
  maxCommits: number = 200,
  minCooccurrence: number = 2,
  limit: number = 10
): Promise<CoChangeForFile> {
  const result = await analyzeCoChanges(maxCommits, minCooccurrence);

  const cochanges: Array<{ path: string; count: number; score: number }> = [];

  for (const pair of result.pairs) {
    if (pair.fileA === filePath) {
      cochanges.push({ path: pair.fileB, count: pair.count, score: pair.score });
    } else if (pair.fileB === filePath) {
      cochanges.push({ path: pair.fileA, count: pair.count, score: pair.score });
    }
  }

  cochanges.sort((a, b) => b.score - a.score);

  return {
    file: filePath,
    cochanges: cochanges.slice(0, limit),
  };
}

// ============================================================================
// Helpers
// ============================================================================

function parseCommitLog(log: string): string[][] {
  const commits: string[][] = [];
  const blocks = log.split('---COMMIT---');

  for (const block of blocks) {
    const files = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('commit '));

    if (files.length > 0 && files.length <= 50) {
      // Skip huge commits (merges, initial commits)
      commits.push(files);
    }
  }

  return commits;
}

function makePairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}
