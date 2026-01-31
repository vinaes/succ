import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import chokidar from 'chokidar';
import { getClaudeDir, getProjectRoot } from '../lib/config.js';
import { getEmbeddings } from '../lib/embeddings.js';
import { chunkText, extractFrontmatter } from '../lib/chunker.js';
import {
  upsertDocumentsBatch,
  deleteDocumentsByPath,
  getFileHash,
  setFileHash,
  deleteFileHash,
  closeDb,
} from '../lib/db.js';

interface WatchOptions {
  pattern?: string;
}

function computeHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Index a single file
 */
async function indexFile(filePath: string, relativePath: string): Promise<void> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const hash = computeHash(content);
  const existingHash = getFileHash(relativePath);

  // Skip if unchanged
  if (existingHash === hash) {
    return;
  }

  const { frontmatter, body } = extractFrontmatter(content);

  // Skip if marked as no-index
  if (frontmatter['succ-ignore']) {
    console.log(`  Skipping ${relativePath} (succ-ignore)`);
    return;
  }

  // Delete existing chunks
  deleteDocumentsByPath(relativePath);

  // Chunk and embed
  const chunks = chunkText(body, relativePath);
  if (chunks.length === 0) return;

  const texts = chunks.map((c) => c.content);
  const embeddings = await getEmbeddings(texts);

  // Store (batch transaction)
  const documents = chunks.map((chunk, i) => ({
    filePath: relativePath,
    chunkIndex: i,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    embedding: embeddings[i],
  }));
  upsertDocumentsBatch(documents);

  setFileHash(relativePath, hash);
  console.log(`  Indexed: ${relativePath} (${chunks.length} chunks)`);
}

/**
 * Remove a file from index
 */
function removeFile(relativePath: string): void {
  deleteDocumentsByPath(relativePath);
  deleteFileHash(relativePath);
  console.log(`  Removed: ${relativePath}`);
}

/**
 * Watch for file changes and auto-reindex
 */
export async function watch(
  targetPath?: string,
  options: WatchOptions = {}
): Promise<void> {
  const { pattern = '**/*.md' } = options;
  const projectRoot = getProjectRoot();
  const claudeDir = getClaudeDir();

  // Default to brain directory
  const watchPath = targetPath
    ? path.resolve(targetPath)
    : path.join(claudeDir, 'brain');

  if (!fs.existsSync(watchPath)) {
    console.error(`Path not found: ${watchPath}`);
    process.exit(1);
  }

  const displayPath = path.relative(projectRoot, watchPath) || watchPath;
  console.log(`Watching ${displayPath}`);
  console.log(`Pattern: ${pattern}`);
  console.log('Press Ctrl+C to stop\n');

  // Debounce map to avoid multiple rapid triggers
  const pending = new Map<string, NodeJS.Timeout>();
  const debounceMs = 500;

  const watcher = chokidar.watch(pattern, {
    cwd: watchPath,
    ignoreInitial: true,
    ignored: ['**/node_modules/**', '**/.git/**', '**/.obsidian/**'],
    persistent: true,
  });

  watcher.on('add', (file) => {
    const absolutePath = path.join(watchPath, file);
    const relativePath = path.relative(projectRoot, absolutePath);

    // Debounce
    if (pending.has(relativePath)) {
      clearTimeout(pending.get(relativePath));
    }

    pending.set(
      relativePath,
      setTimeout(async () => {
        pending.delete(relativePath);
        console.log(`[+] ${file}`);
        try {
          await indexFile(absolutePath, relativePath);
        } catch (error) {
          console.error(`  Error indexing ${file}:`, error);
        }
      }, debounceMs)
    );
  });

  watcher.on('change', (file) => {
    const absolutePath = path.join(watchPath, file);
    const relativePath = path.relative(projectRoot, absolutePath);

    // Debounce
    if (pending.has(relativePath)) {
      clearTimeout(pending.get(relativePath));
    }

    pending.set(
      relativePath,
      setTimeout(async () => {
        pending.delete(relativePath);
        console.log(`[~] ${file}`);
        try {
          await indexFile(absolutePath, relativePath);
        } catch (error) {
          console.error(`  Error indexing ${file}:`, error);
        }
      }, debounceMs)
    );
  });

  watcher.on('unlink', (file) => {
    const absolutePath = path.join(watchPath, file);
    const relativePath = path.relative(projectRoot, absolutePath);

    console.log(`[-] ${file}`);
    removeFile(relativePath);
  });

  watcher.on('error', (error) => {
    console.error('Watcher error:', error);
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\nStopping watcher...');
    watcher.close();
    closeDb();
    process.exit(0);
  });
}
