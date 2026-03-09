/**
 * CLI commands for session analysis and surgery.
 *
 * - succ session analyze [path]     — token breakdown, tool stats, cut points
 * - succ session trim [path]        — trim tool content
 * - succ session trim-thinking [path] — trim thinking blocks
 * - succ session trim-all [path]    — trim all strippable content
 * - succ session compact [path]     — manual compact at position N
 */

import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { logWarn } from '../lib/fault-logger.js';
import {
  analyzeSessionFile,
  formatAnalysisReport,
} from '../lib/session-analyzer.js';
import {
  trimToolContent,
  trimThinking,
  trimAll,
  compactBefore,
  type TrimOptions,
} from '../lib/session-surgeon.js';

// ── Path resolution ──────────────────────────────────────────────────

/** Find the most recent .jsonl session file if no path given. */
async function resolveSessionPath(pathArg: string | undefined): Promise<string> {
  if (pathArg) return resolve(pathArg);

  // Try to find most recent JSONL in ~/.claude/projects/
  const projectsDir = join(homedir(), '.claude', 'projects');
  try {
    const projectDirs = await readdir(projectsDir, { withFileTypes: true });
    let newest = { path: '', mtime: 0 };

    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = join(projectsDir, dir.name);
      try {
        const files = await readdir(dirPath);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = join(dirPath, file);
          const fileStat = await stat(filePath);
          if (fileStat.mtimeMs > newest.mtime) {
            newest = { path: filePath, mtime: fileStat.mtimeMs };
          }
        }
      } catch (e) {
        logWarn('session', `Skipping unreadable directory ${dir.name}: ${e}`);
      }
    }

    if (newest.path) {
      console.log(`Auto-detected session: ${newest.path}`);
      return newest.path;
    }
  } catch (e) {
    logWarn('session', `Could not read ~/.claude/projects/: ${e}`);
  }

  throw new Error(
    'No session path provided and no sessions found.\n' +
    'Usage: succ session analyze <path-to-session.jsonl>'
  );
}

// ── Commands ─────────────────────────────────────────────────────────

export async function sessionAnalyze(pathArg: string | undefined): Promise<void> {
  const filePath = await resolveSessionPath(pathArg);
  const analysis = await analyzeSessionFile(filePath);
  console.log(formatAnalysisReport(analysis, filePath));
}

export async function sessionTrim(
  pathArg: string | undefined,
  options: {
    tools?: string;
    onlyInputs?: boolean;
    onlyResults?: boolean;
    keepLastLines?: number;
    dryRun?: boolean;
    backup?: boolean;
  }
): Promise<void> {
  const filePath = await resolveSessionPath(pathArg);

  const trimOptions: TrimOptions = {
    tools: options.tools ? options.tools.split(',').map((t) => t.trim()) : undefined,
    onlyInputs: options.onlyInputs,
    onlyResults: options.onlyResults,
    keepLastLines: options.keepLastLines,
    dryRun: options.dryRun,
    noBackup: options.backup === false,
  };

  const result = await trimToolContent(filePath, trimOptions);

  console.log(`\nTrim complete${options.dryRun ? ' (dry run)' : ''}:`);
  console.log(`  Entries modified: ${result.entriesModified}`);
  console.log(`  Chars removed:    ${result.charsRemoved.toLocaleString()}`);
  console.log(`  Tokens freed:     ~${result.tokensFreed.toLocaleString()}`);
  if (result.backupPath) console.log(`  Backup:           ${result.backupPath}`);
}

export async function sessionTrimThinking(
  pathArg: string | undefined,
  options: { dryRun?: boolean; backup?: boolean }
): Promise<void> {
  const filePath = await resolveSessionPath(pathArg);
  const result = await trimThinking(filePath, {
    dryRun: options.dryRun,
    noBackup: options.backup === false,
  });

  console.log(`\nTrim thinking complete${options.dryRun ? ' (dry run)' : ''}:`);
  console.log(`  Entries modified: ${result.entriesModified}`);
  console.log(`  Chars removed:    ${result.charsRemoved.toLocaleString()}`);
  console.log(`  Tokens freed:     ~${result.tokensFreed.toLocaleString()}`);
  if (result.backupPath) console.log(`  Backup:           ${result.backupPath}`);
}

export async function sessionTrimAll(
  pathArg: string | undefined,
  options: { dryRun?: boolean; backup?: boolean }
): Promise<void> {
  const filePath = await resolveSessionPath(pathArg);
  const result = await trimAll(filePath, {
    dryRun: options.dryRun,
    noBackup: options.backup === false,
  });

  console.log(`\nTrim all complete${options.dryRun ? ' (dry run)' : ''}:`);
  console.log(`  Entries modified: ${result.entriesModified}`);
  console.log(`  Chars removed:    ${result.charsRemoved.toLocaleString()}`);
  console.log(`  Tokens freed:     ~${result.tokensFreed.toLocaleString()}`);
  if (result.backupPath) console.log(`  Backup:           ${result.backupPath}`);
}

export async function sessionCompact(
  pathArg: string | undefined,
  options: { before: number; dryRun?: boolean; backup?: boolean; output?: string }
): Promise<void> {
  const filePath = await resolveSessionPath(pathArg);
  const result = await compactBefore(filePath, options.before, {
    dryRun: options.dryRun,
    noBackup: options.backup === false,
    outputPath: options.output,
  });

  console.log(`\nCompact complete${options.dryRun ? ' (dry run)' : ''}:`);
  console.log(`  Pre-cut messages:  ${result.preCutMessages}`);
  console.log(`  Post-cut messages: ${result.postCutMessages}`);
  console.log(`  Summary chars:     ${result.summaryChars.toLocaleString()}`);
  console.log(`  Summary tokens:    ~${result.summaryTokens.toLocaleString()}`);
  console.log(`  Chain verified:    ${result.chainVerified ? 'OK' : 'FAILED'}`);
  console.log(`  Output:            ${result.outputPath}`);
  console.log(`  Session ID:        ${result.sessionId}`);
  if (!options.dryRun) {
    console.log(`\n  Resume with: claude -r ${result.sessionId}`);
  }
}
