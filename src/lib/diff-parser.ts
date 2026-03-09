/**
 * Structured diff parsing using parse-diff.
 *
 * Parses `git diff` output into typed objects for use by:
 * - succ_review (MR context pack generator)
 * - succ_debug (understanding code changes)
 * - Co-change graph analysis
 */

import parseDiff from 'parse-diff';
import { logWarn } from './fault-logger.js';

// ============================================================================
// Types
// ============================================================================

export interface DiffChange {
  type: 'add' | 'del' | 'normal';
  content: string;
  /** Line number in old file (for del/normal) */
  oldLine?: number;
  /** Line number in new file (for add/normal) */
  newLine?: number;
}

export interface DiffChunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  changes: DiffChange[];
}

export interface DiffFile {
  from: string;
  to: string;
  additions: number;
  deletions: number;
  chunks: DiffChunk[];
  /** True if this is a new file */
  isNew: boolean;
  /** True if file was deleted */
  isDeleted: boolean;
  /** True if file was renamed */
  isRenamed: boolean;
  /** Binary file (no diff content) */
  isBinary: boolean;
}

export interface ParsedDiff {
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  totalFiles: number;
  /** Files grouped by extension */
  filesByExtension: Record<string, string[]>;
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a unified diff string into structured objects.
 *
 * @param diffText - Raw `git diff` output (unified diff format)
 * @returns Structured diff with typed files, chunks, and changes
 */
export function parseDiffText(diffText: string): ParsedDiff {
  if (!diffText || diffText.trim().length === 0) {
    return {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      totalFiles: 0,
      filesByExtension: {},
    };
  }

  let rawFiles: parseDiff.File[];
  try {
    rawFiles = parseDiff(diffText);
  } catch (error) {
    logWarn('diff-parser', 'Failed to parse diff text', {
      error: error instanceof Error ? error.message : String(error),
      inputLength: diffText.length,
    });
    return {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      totalFiles: 0,
      filesByExtension: {},
    };
  }

  const files: DiffFile[] = rawFiles.map(mapFile);

  let totalAdditions = 0;
  let totalDeletions = 0;
  const filesByExtension: Record<string, string[]> = {};

  for (const file of files) {
    totalAdditions += file.additions;
    totalDeletions += file.deletions;

    const filePath = file.to !== '/dev/null' ? file.to : file.from;
    const ext = getExtension(filePath);
    if (!filesByExtension[ext]) {
      filesByExtension[ext] = [];
    }
    filesByExtension[ext].push(filePath);
  }

  return {
    files,
    totalAdditions,
    totalDeletions,
    totalFiles: files.length,
    filesByExtension,
  };
}

/**
 * Extract only the changed function/symbol names from a diff.
 * Looks at chunk headers (@@...@@ functionName) for context.
 */
export function extractChangedSymbols(diff: ParsedDiff): Array<{ file: string; symbol: string }> {
  const symbols: Array<{ file: string; symbol: string }> = [];
  const seen = new Set<string>();

  for (const file of diff.files) {
    const filePath = file.to !== '/dev/null' ? file.to : file.from;

    for (const chunk of file.chunks) {
      // The @@ header often contains function/class context after the second @@.
      // Avoid regex backtracking — use indexOf to find the closing @@.
      const headerStr = chunk.header;
      const closingAt = headerStr.indexOf('@@', 2);
      const symbolContext =
        closingAt >= 0 ? headerStr.slice(closingAt + 2, closingAt + 202).trimStart() : '';
      if (symbolContext.length > 0) {
        const symbolName = symbolContext.trim();
        const key = `${filePath}:${symbolName}`;
        if (!seen.has(key) && symbolName.length > 0) {
          seen.add(key);
          symbols.push({ file: filePath, symbol: symbolName });
        }
      }
    }
  }

  return symbols;
}

/**
 * Get a compact summary of the diff for LLM context.
 */
export function summarizeDiff(diff: ParsedDiff): string {
  if (diff.totalFiles === 0) return 'No changes.';

  const lines: string[] = [];
  lines.push(`${diff.totalFiles} file(s) changed: +${diff.totalAdditions} -${diff.totalDeletions}`);

  for (const file of diff.files) {
    const filePath = file.to !== '/dev/null' ? file.to : file.from;
    const status = file.isNew
      ? ' (new)'
      : file.isDeleted
        ? ' (deleted)'
        : file.isRenamed
          ? ` (renamed from ${file.from})`
          : '';
    lines.push(`  ${filePath}${status}: +${file.additions} -${file.deletions}`);
  }

  return lines.join('\n');
}

/**
 * Get the added/removed lines for a specific file from the diff.
 */
export function getFileChanges(
  diff: ParsedDiff,
  filePath: string
): { added: string[]; removed: string[] } | null {
  const file = diff.files.find((f) => f.to === filePath || f.from === filePath);
  if (!file) return null;

  const added: string[] = [];
  const removed: string[] = [];

  for (const chunk of file.chunks) {
    for (const change of chunk.changes) {
      // Strip the leading +/- from content
      const content = change.content.substring(1);
      if (change.type === 'add') {
        added.push(content);
      } else if (change.type === 'del') {
        removed.push(content);
      }
    }
  }

  return { added, removed };
}

// ============================================================================
// Internal helpers
// ============================================================================

function mapFile(raw: parseDiff.File): DiffFile {
  const from = raw.from ?? '/dev/null';
  const to = raw.to ?? '/dev/null';

  return {
    from,
    to,
    additions: raw.additions,
    deletions: raw.deletions,
    chunks: raw.chunks.map(mapChunk),
    isNew: from === '/dev/null',
    isDeleted: to === '/dev/null',
    isRenamed: from !== to && from !== '/dev/null' && to !== '/dev/null',
    isBinary: raw.chunks.length === 0 && raw.additions === 0 && raw.deletions === 0,
  };
}

function mapChunk(raw: parseDiff.Chunk): DiffChunk {
  return {
    oldStart: raw.oldStart,
    oldLines: raw.oldLines,
    newStart: raw.newStart,
    newLines: raw.newLines,
    header: raw.content,
    changes: raw.changes.map(mapChange),
  };
}

function mapChange(raw: parseDiff.Change): DiffChange {
  const change: DiffChange = {
    type: raw.type === 'add' ? 'add' : raw.type === 'del' ? 'del' : 'normal',
    content: raw.content,
  };

  if (raw.type === 'add') {
    change.newLine = (raw as parseDiff.AddChange).ln;
  } else if (raw.type === 'del') {
    change.oldLine = (raw as parseDiff.DeleteChange).ln;
  } else {
    const normal = raw as parseDiff.NormalChange;
    change.oldLine = normal.ln1;
    change.newLine = normal.ln2;
  }

  return change;
}

function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1 || lastDot === filePath.length - 1) return '(none)';
  return filePath.substring(lastDot + 1);
}
