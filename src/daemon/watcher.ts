/**
 * Watch Service for unified daemon
 *
 * File monitoring using @parcel/watcher (native C++, reliable on Windows).
 * Integrated into the main daemon process.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import watcher from '@parcel/watcher';
import type { AsyncSubscription, Event } from '@parcel/watcher';
import { getProjectRoot } from '../lib/config.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { getEmbeddings } from '../lib/embeddings.js';
import { chunkText, extractFrontmatter } from '../lib/chunker.js';
import { withLock } from '../lib/lock.js';
import {
  upsertDocumentsBatch,
  deleteDocumentsByPath,
  getFileHash,
  setFileHash,
  deleteFileHash,
} from '../lib/storage/index.js';
import { indexCodeFile } from '../commands/index-code.js';
import {
  DOC_EXTENSIONS,
  shouldIgnorePath,
  getFileType,
} from '../lib/patterns.js';

// Re-export for backwards compatibility
export { CODE_EXTENSIONS, DOC_EXTENSIONS } from '../lib/patterns.js';

// ============================================================================
// Types
// ============================================================================

export interface WatcherState {
  active: boolean;
  patterns: string[];
  includeCode: boolean;
  watchedFiles: Set<string>;
  lastChange: number;
  subscription: AsyncSubscription | null;
  pending: Map<string, NodeJS.Timeout>;
  debounceMs: number;
  // Batch processing state
  pendingBatch: Map<string, { event: Event; fileType: 'code' | 'doc'; relativePath: string }>;
  batchTimer: NodeJS.Timeout | null;
}

export interface WatcherConfig {
  patterns?: string[];
  includeCode?: boolean;
  debounceMs?: number;
}

// ============================================================================
// Watcher State
// ============================================================================

let watcherState: WatcherState | null = null;

// ============================================================================
// Helper Functions
// ============================================================================

function computeHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Check if file matches watch patterns
 */
function matchesPatterns(relativePath: string, patterns: string[], includeCode: boolean): boolean {
  const ext = path.extname(relativePath).toLowerCase();
  const fileType = getFileType(relativePath);

  if (!fileType) return false;

  // If it's code and code watching is disabled, skip
  if (fileType === 'code' && !includeCode) return false;

  // If it's code and code watching is enabled, accept all code files
  if (fileType === 'code' && includeCode) return true;

  // For doc files, check if extension matches patterns
  if (fileType === 'doc') {
    // Default patterns include *.md, so check for doc extensions
    if (DOC_EXTENSIONS.has(ext)) return true;
  }

  return false;
}

// ============================================================================
// File Indexing (from watch.ts logic)
// ============================================================================

/**
 * Index a single document file with lock protection
 */
async function indexDocFile(
  filePath: string,
  relativePath: string,
  log: (msg: string) => void
): Promise<void> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const hash = computeHash(content);

  // Check hash (fast path)
  const existingHash = await getFileHash(relativePath);
  if (existingHash === hash) {
    return;
  }

  const { frontmatter, body } = extractFrontmatter(content);

  // Skip if marked as no-index
  if (frontmatter['succ-ignore']) {
    log(`  Skipping ${relativePath} (succ-ignore)`);
    return;
  }

  // Chunk text
  const chunks = chunkText(body, relativePath);
  if (chunks.length === 0) return;

  // Get embeddings
  const texts = chunks.map((c) => c.content);
  const embeddings = await getEmbeddings(texts);

  // Prepare documents
  const documents = chunks.map((chunk, i) => ({
    filePath: relativePath,
    chunkIndex: i,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    embedding: embeddings[i],
  }));

  // Database operations with lock protection
  await withLock('watch-index', async () => {
    const currentHash = await getFileHash(relativePath);
    if (currentHash === hash) {
      return;
    }

    await deleteDocumentsByPath(relativePath);
    await upsertDocumentsBatch(documents);
    await setFileHash(relativePath, hash);
  });

  log(`  Indexed: ${relativePath} (${chunks.length} chunks)`);
}

/**
 * Index a single code file with lock protection
 */
async function indexCode(
  filePath: string,
  relativePath: string,
  log: (msg: string) => void
): Promise<void> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const hash = computeHash(content);

  const existingHash = await getFileHash(`code:${relativePath}`);
  if (existingHash === hash) {
    return;
  }

  await withLock('watch-code', async () => {
    const result = await indexCodeFile(filePath, { force: true });
    if (result.success && result.chunks && result.chunks > 0) {
      await setFileHash(`code:${relativePath}`, hash);
      log(`  Indexed code: ${relativePath} (${result.chunks} chunks)`);
    }
  });
}

/**
 * Remove a document file from index
 */
async function removeDocFile(
  relativePath: string,
  log: (msg: string) => void
): Promise<void> {
  await withLock('watch-remove', async () => {
    await deleteDocumentsByPath(relativePath);
    await deleteFileHash(relativePath);
  });
  log(`  Removed: ${relativePath}`);
}

/**
 * Remove a code file from index
 */
async function removeCodeFile(
  relativePath: string,
  log: (msg: string) => void
): Promise<void> {
  await withLock('watch-remove-code', async () => {
    await deleteDocumentsByPath(relativePath);
    await deleteFileHash(`code:${relativePath}`);
  });
  log(`  Removed code: ${relativePath}`);
}

// ============================================================================
// Watch Service API
// ============================================================================

/**
 * Start the watch service
 */
export async function startWatcher(
  config: WatcherConfig,
  log: (msg: string) => void
): Promise<WatcherState> {
  if (watcherState?.active) {
    log('[watch] Already running');
    return watcherState;
  }

  const projectRoot = getProjectRoot();

  const patterns = config.patterns || ['**/*.md'];
  const includeCode = config.includeCode ?? false;
  const debounceMs = config.debounceMs ?? 5000; // 5 seconds debounce per file

  const pending = new Map<string, NodeJS.Timeout>();
  const pendingBatch = new Map<string, { event: Event; fileType: 'code' | 'doc'; relativePath: string }>();
  let batchTimer: NodeJS.Timeout | null = null;
  const BATCH_FLUSH_MS = 2000; // Collect events for 2s before processing batch

  // Process batch of files in parallel
  const flushBatch = async () => {
    batchTimer = null;
    if (pendingBatch.size === 0) return;

    const batch = Array.from(pendingBatch.values());
    pendingBatch.clear();

    // Filter out files that no longer exist
    const validFiles = batch.filter(f => fs.existsSync(f.event.path));
    if (validFiles.length === 0) return;

    log(`[watch] Processing batch of ${validFiles.length} files`);

    // Group by type for efficient processing
    const codeFiles = validFiles.filter(f => f.fileType === 'code');
    const docFiles = validFiles.filter(f => f.fileType === 'doc');

    // Process all files in parallel
    const results = await Promise.allSettled([
      ...codeFiles.map(async f => {
        const action = f.event.type === 'create' ? '+' : '~';
        log(`[watch] [${action}] ${f.relativePath}`);
        watcherState!.lastChange = Date.now();
        watcherState!.watchedFiles.add(f.relativePath);
        await indexCode(f.event.path, f.relativePath, log);
      }),
      ...docFiles.map(async f => {
        const action = f.event.type === 'create' ? '+' : '~';
        log(`[watch] [${action}] ${f.relativePath}`);
        watcherState!.lastChange = Date.now();
        watcherState!.watchedFiles.add(f.relativePath);
        await indexDocFile(f.event.path, f.relativePath, log);
      }),
    ]);

    // Log any errors
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const file = i < codeFiles.length ? codeFiles[i] : docFiles[i - codeFiles.length];
        log(`[watch] Error indexing ${file.relativePath}: ${result.reason}`);
      }
    }
  };

  // Handle file events - collect into batch
  const handleEvent = async (event: Event) => {
    const relativePath = path.relative(projectRoot, event.path);

    // Skip ignored paths
    if (shouldIgnorePath(relativePath, path.sep)) {
      return;
    }

    // Skip if doesn't match patterns
    if (!matchesPatterns(relativePath, patterns, includeCode)) {
      return;
    }

    const fileType = getFileType(relativePath);
    if (!fileType) return;

    // Debounce per-file (for rapid saves of same file)
    if (pending.has(relativePath)) {
      clearTimeout(pending.get(relativePath));
    }

    if (event.type === 'delete') {
      // Handle deletion immediately (don't batch)
      log(`[watch] [-] ${relativePath}`);
      watcherState!.watchedFiles.delete(relativePath);
      pendingBatch.delete(relativePath); // Remove from pending batch if was there

      try {
        if (fileType === 'code') {
          await removeCodeFile(relativePath, log);
        } else {
          await removeDocFile(relativePath, log);
        }
      } catch (error) {
        log(`[watch] Error removing ${relativePath}: ${error}`);
      }
      return;
    }

    // For create/update, add to batch with debounce
    pending.set(
      relativePath,
      setTimeout(() => {
        pending.delete(relativePath);
        if (!fs.existsSync(event.path)) {
          return;
        }

        // Add to pending batch
        pendingBatch.set(relativePath, { event, fileType, relativePath });

        // Schedule batch flush if not already scheduled
        if (!batchTimer) {
          batchTimer = setTimeout(flushBatch, BATCH_FLUSH_MS);
        }
      }, debounceMs)
    );
  };

  // Subscribe to file system events
  log(`[watch] Starting @parcel/watcher on ${projectRoot}`);
  log(`[watch] Patterns: ${patterns.join(', ')}`);
  if (includeCode) {
    log(`[watch] Code files: enabled`);
  }

  const subscription = await watcher.subscribe(
    projectRoot,
    async (err, events) => {
      if (err) {
        log(`[watch] Error: ${err}`);
        return;
      }

      for (const event of events) {
        try {
          await handleEvent(event);
        } catch (error) {
          log(`[watch] Event handler error: ${error}`);
        }
      }
    },
    {
      // @parcel/watcher specific options
      ignore: [
        // Basic ignore patterns
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/.succ/.tmp/**',
        '**/.succ/succ.db*',
      ],
    }
  );

  watcherState = {
    active: true,
    patterns,
    includeCode,
    watchedFiles: new Set(),
    lastChange: 0,
    subscription,
    pending,
    debounceMs,
    pendingBatch,
    batchTimer,
  };

  log(`[watch] Started watching ${projectRoot}`);

  return watcherState;
}

/**
 * Stop the watch service
 */
export async function stopWatcher(log: (msg: string) => void): Promise<void> {
  if (!watcherState?.active) {
    return;
  }

  // Clear pending timeouts
  for (const timeout of watcherState.pending.values()) {
    clearTimeout(timeout);
  }
  watcherState.pending.clear();

  // Clear batch timer
  if (watcherState.batchTimer) {
    clearTimeout(watcherState.batchTimer);
    watcherState.batchTimer = null;
  }
  watcherState.pendingBatch.clear();

  // Unsubscribe from watcher
  if (watcherState.subscription) {
    await watcherState.subscription.unsubscribe();
  }

  watcherState.active = false;
  watcherState.subscription = null;

  log('[watch] Stopped');
}

/**
 * Get watch service status
 */
export function getWatcherStatus(): {
  active: boolean;
  patterns: string[];
  includeCode: boolean;
  watchedFiles: number;
  lastChange: number;
} {
  if (!watcherState) {
    return {
      active: false,
      patterns: [],
      includeCode: false,
      watchedFiles: 0,
      lastChange: 0,
    };
  }

  return {
    active: watcherState.active,
    patterns: watcherState.patterns,
    includeCode: watcherState.includeCode,
    watchedFiles: watcherState.watchedFiles.size,
    lastChange: watcherState.lastChange,
  };
}

/**
 * Index a specific file on demand
 */
export async function indexFileOnDemand(
  filePath: string,
  log: (msg: string) => void
): Promise<void> {
  const projectRoot = getProjectRoot();
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectRoot, filePath);
  const relativePath = path.relative(projectRoot, absolutePath);

  if (!fs.existsSync(absolutePath)) {
    throw new NotFoundError(`File not found: ${filePath}`);
  }

  const fileType = getFileType(filePath);
  if (!fileType) {
    throw new ValidationError(`Unknown file type: ${filePath}`);
  }

  if (fileType === 'code') {
    await indexCode(absolutePath, relativePath, log);
  } else {
    await indexDocFile(absolutePath, relativePath, log);
  }
}
