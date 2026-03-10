/**
 * Scan & index all code files in a project.
 *
 * Three stages:
 *   1. discoverCodeFiles — git ls-files or recursive walk, filtered by extension/size/.succignore
 *   2. categorizeFiles  — diff discovered files against stored hashes (new/modified/unchanged)
 *   3. scanCode          — orchestrate discovery → categorization → batch indexing via p-limit
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pLimit from 'p-limit';
import { EXTENSION_TO_LANGUAGE } from '../lib/tree-sitter/types.js';
import { getAllFileHashes } from '../lib/storage/index.js';
import { getProjectRoot, getConfig } from '../lib/config.js';
import { indexCodeFile } from './index-code.js';
import { computeHash } from './index-code.js';
import { logInfo, logWarn } from '../lib/fault-logger.js';
import { minimatch } from 'minimatch';

// ============================================================================
// Types
// ============================================================================

export interface DiscoverOptions {
  projectRoot: string;
  filterPath?: string;
  maxFileSizeKb?: number;
  ignorePatterns?: string[];
}

export interface DiscoverResult {
  files: string[];
  totalScanned: number;
  skippedExtension: number;
  skippedSize: number;
  skippedPath: number;
  skippedIgnore: number;
  source: 'git' | 'walk';
}

export interface CategorizeResult {
  toIndex: string[];
  newCount: number;
  modifiedCount: number;
  unchangedCount: number;
  readErrors: number;
  readErrorDetails: string[];
}

export interface ScanResult {
  totalScanned: number;
  totalCode: number;
  indexed: number;
  newCount: number;
  updatedCount: number;
  unchanged: number;
  chunks: number;
  errors: number;
  errorDetails: string[];
  skippedSize: number;
  skippedExtension: number;
  skippedIgnore: number;
  source: 'git' | 'walk';
}

// ============================================================================
// Default ignore directories for non-git walk
// ============================================================================

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
  'target',
  '.succ',
  '.cache',
  'coverage',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
]);

// ============================================================================
// .succignore
// ============================================================================

/**
 * Load ignore patterns from .succignore file.
 * Format: one glob per line, # comments, blank lines skipped.
 */
export function loadIgnorePatterns(projectRoot: string): string[] {
  const ignorePath = path.join(projectRoot, '.succignore');
  try {
    const content = fs.readFileSync(ignorePath, 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw new Error(`Failed to read ${ignorePath}: ${e?.message ?? e}`);
  }
}

/**
 * Check if a relative path matches any ignore pattern.
 * Supports negation (!) — a negated pattern re-includes previously excluded files.
 */
export function isIgnored(relativePath: string, patterns: string[]): boolean {
  let ignored = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (minimatch(relativePath, pattern.slice(1))) {
        ignored = false;
      }
    } else {
      if (minimatch(relativePath, pattern)) {
        ignored = true;
      }
    }
  }
  return ignored;
}

// ============================================================================
// File discovery
// ============================================================================

/**
 * Discover code files in the project. Uses git ls-files when available,
 * falls back to recursive directory walk for non-git projects.
 */
export function discoverCodeFiles(options: DiscoverOptions): DiscoverResult {
  const { projectRoot, filterPath, maxFileSizeKb = 500, ignorePatterns = [] } = options;
  const supportedExtensions = new Set(Object.keys(EXTENSION_TO_LANGUAGE));

  let rawFiles: string[];
  let source: 'git' | 'walk';

  try {
    const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    rawFiles = output.split('\n').filter((f) => f.length > 0);
    source = 'git';
  } catch (e) {
    logWarn('scan-code', `git ls-files failed, falling back to directory walk: ${e}`);
    rawFiles = recursiveWalk(projectRoot, projectRoot);
    source = 'walk';
  }

  const totalScanned = rawFiles.length;
  let skippedExtension = 0;
  let skippedSize = 0;
  let skippedPath = 0;
  let skippedIgnore = 0;
  const files: string[] = [];

  // Normalize filterPath once before the loop
  const normalizedFilterPath = filterPath
    ? (() => {
        const f = filterPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
        return f !== '' && f !== '.' ? f : null;
      })()
    : null;

  for (const relativePath of rawFiles) {
    // Normalize to forward slashes for consistent matching
    const normalized = relativePath.replace(/\\/g, '/');

    // Filter by path prefix
    if (normalizedFilterPath) {
      if (!normalized.startsWith(normalizedFilterPath + '/') && normalized !== normalizedFilterPath) {
        skippedPath++;
        continue;
      }
    }

    // Filter by extension
    const ext = path.extname(normalized).slice(1).toLowerCase();
    if (!supportedExtensions.has(ext)) {
      skippedExtension++;
      continue;
    }

    // Filter by .succignore
    if (ignorePatterns.length > 0 && isIgnored(normalized, ignorePatterns)) {
      skippedIgnore++;
      continue;
    }

    // Filter by size; use lstatSync to avoid following symlinks (path traversal risk)
    const absolutePath = path.resolve(projectRoot, relativePath);
    try {
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        logWarn('scan-code', `Skipping symlinked file: ${relativePath}`);
        continue;
      }
      if (stat.size > maxFileSizeKb * 1024) {
        skippedSize++;
        continue;
      }
    } catch (e) {
      logWarn('scan-code', `Stat failed for ${relativePath}, skipping: ${e}`);
      continue;
    }

    files.push(absolutePath);
  }

  return { files, totalScanned, skippedExtension, skippedSize, skippedPath, skippedIgnore, source };
}

/**
 * Recursive directory walk with default ignore directories.
 * Returns relative paths (forward slashes).
 */
function recursiveWalk(dir: string, projectRoot: string): string[] {
  const results: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    logWarn('scan-code', `Cannot read directory ${dir}: ${e}`);
    return results;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
      results.push(...recursiveWalk(path.join(dir, entry.name), projectRoot));
    } else if (entry.isFile()) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(projectRoot, fullPath).replace(/\\/g, '/');
      results.push(relativePath);
    }
  }

  return results;
}

// ============================================================================
// Categorization
// ============================================================================

/**
 * Categorize discovered files as new, modified, or unchanged by comparing
 * content hashes against the stored index.
 */
export async function categorizeFiles(
  files: string[],
  projectRoot: string,
  force: boolean
): Promise<CategorizeResult> {
  const existingHashes = await getAllFileHashes();
  const toIndex: string[] = [];
  let newCount = 0;
  let modifiedCount = 0;
  let unchangedCount = 0;
  let readErrors = 0;
  const readErrorDetails: string[] = [];

  for (const absolutePath of files) {
    const relativePath = path.relative(projectRoot, absolutePath).replace(/\\/g, '/');
    const storedKey = `code:${relativePath}`;
    const existingHash = existingHashes.get(storedKey);

    if (existingHash === undefined) {
      // New file — never indexed
      toIndex.push(absolutePath);
      newCount++;
      continue;
    }

    if (force) {
      toIndex.push(absolutePath);
      modifiedCount++;
      continue;
    }

    // Compare hashes
    let content: string;
    try {
      content = fs.readFileSync(absolutePath, 'utf-8');
    } catch (e) {
      logWarn('scan-code', `Failed to read ${absolutePath}: ${e}`);
      readErrors++;
      const rel = path.relative(projectRoot, absolutePath).replace(/\\/g, '/');
      readErrorDetails.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const currentHash = computeHash(content);
    if (currentHash !== existingHash) {
      toIndex.push(absolutePath);
      modifiedCount++;
    } else {
      unchangedCount++;
    }
  }

  return { toIndex, newCount, modifiedCount, unchangedCount, readErrors, readErrorDetails };
}

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * Scan the project: discover code files, categorize, and batch-index.
 */
export async function scanCode(options: {
  filterPath?: string;
  force?: boolean;
}): Promise<ScanResult> {
  const { filterPath, force = false } = options;
  const projectRoot = getProjectRoot();
  const config = getConfig();
  const maxFileSizeKb = config.indexing?.max_file_size_kb ?? 500;
  const concurrency = config.indexing?.concurrency ?? 3;

  // Load .succignore
  const ignorePatterns = loadIgnorePatterns(projectRoot);

  // Discover
  const discovery = discoverCodeFiles({
    projectRoot,
    filterPath,
    maxFileSizeKb,
    ignorePatterns,
  });

  if (discovery.files.length === 0) {
    return {
      totalScanned: discovery.totalScanned,
      totalCode: 0,
      indexed: 0,
      newCount: 0,
      updatedCount: 0,
      unchanged: 0,
      chunks: 0,
      errors: 0,
      errorDetails: [],
      skippedSize: discovery.skippedSize,
      skippedExtension: discovery.skippedExtension,
      skippedIgnore: discovery.skippedIgnore,
      source: discovery.source,
    };
  }

  // Categorize
  const category = await categorizeFiles(discovery.files, projectRoot, force);

  if (category.toIndex.length === 0) {
    return {
      totalScanned: discovery.totalScanned,
      totalCode: discovery.files.length,
      indexed: 0,
      newCount: 0,
      updatedCount: 0,
      unchanged: category.unchangedCount,
      chunks: 0,
      errors: category.readErrors,
      errorDetails: category.readErrorDetails,
      skippedSize: discovery.skippedSize,
      skippedExtension: discovery.skippedExtension,
      skippedIgnore: discovery.skippedIgnore,
      source: discovery.source,
    };
  }

  // Batch index with p-limit
  const limiter = pLimit(concurrency);
  let indexed = 0;
  let totalChunks = 0;
  let errors = 0;
  const errorDetails: string[] = [];
  let processed = 0;

  logInfo('scan-code', `Indexing ${category.toIndex.length} files (concurrency: ${concurrency})`);

  const tasks = category.toIndex.map((filePath) =>
    limiter(async () => {
      try {
        const result = await indexCodeFile(filePath, { force: true });
        processed++;

        if (processed % 50 === 0) {
          logInfo('scan-code', `Progress: ${processed}/${category.toIndex.length} files`);
        }

        if (result.success && !result.skipped) {
          indexed++;
          totalChunks += result.chunks ?? 0;
        } else if (!result.success) {
          errors++;
          const relative = path.relative(projectRoot, filePath);
          errorDetails.push(`${relative}: ${result.error ?? 'unknown error'}`);
        }
      } catch (error: any) {
        processed++;
        errors++;
        const relative = path.relative(projectRoot, filePath);
        errorDetails.push(`${relative}: ${error?.message ?? 'unknown error'}`);
      }
    })
  );

  await Promise.all(tasks);

  logInfo(
    'scan-code',
    `Done: ${indexed} indexed, ${category.newCount} new, ${category.modifiedCount} updated, ${category.unchangedCount} unchanged, ${errors} errors`
  );

  return {
    totalScanned: discovery.totalScanned,
    totalCode: discovery.files.length,
    indexed,
    newCount: category.newCount,
    updatedCount: category.modifiedCount,
    unchanged: category.unchangedCount,
    chunks: totalChunks,
    errors: errors + category.readErrors,
    errorDetails: [...errorDetails, ...category.readErrorDetails],
    skippedSize: discovery.skippedSize,
    skippedExtension: discovery.skippedExtension,
    skippedIgnore: discovery.skippedIgnore,
    source: discovery.source,
  };
}
