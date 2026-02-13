import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import inquirer from 'inquirer';
import { getClaudeDir, getProjectRoot } from '../lib/config.js';
import { chunkText, extractFrontmatter } from '../lib/chunker.js';
import { runIndexer, printResults } from '../lib/indexer.js';
import { getStoredEmbeddingDimension, clearDocuments, getFileHash, upsertDocumentsBatchWithHashes,
  updateMemoryEmbeddingsBatch, getMemoriesNeedingReembedding, getMemoryCount, getMemoryEmbeddingCount,
  initStorageDispatcher } from '../lib/storage/index.js';
import { getEmbedding, getEmbeddings, getEmbeddingInfo } from '../lib/embeddings.js';
import { logError, logWarn } from '../lib/fault-logger.js';

interface IndexOptions {
  recursive?: boolean;
  pattern?: string;
  force?: boolean;
  memories?: boolean; // Re-embed all memories
  autoReindex?: boolean; // Auto-reindex on dimension mismatch (for non-interactive mode)
}

export async function index(
  targetPath?: string,
  options: IndexOptions = {}
): Promise<void> {
  let { pattern = '**/*.md', force = false, autoReindex = false, memories = false } = options;

  // --memories: re-embed all memories with current embedding model
  if (memories) {
    await reembedMemories();
    return;
  }
  const projectRoot = getProjectRoot();
  const claudeDir = getClaudeDir();

  // Default to brain directory
  const searchPath = targetPath
    ? path.resolve(targetPath)
    : path.join(claudeDir, 'brain');

  if (!fs.existsSync(searchPath)) {
    logError('index', `Path not found: ${searchPath}`);

    console.error(`Path not found: ${searchPath}`);
    process.exit(1);
  }

  // Check for dimension mismatch before indexing
  const storedDimension = await getStoredEmbeddingDimension();
  if (storedDimension !== null && !force) {
    // Get a test embedding to check current dimension
    const testEmbedding = await getEmbedding('test');
    const currentDimension = testEmbedding.length;

    if (storedDimension !== currentDimension) {
      const { getLLMTaskConfig } = await import('../lib/config.js');
      const embModel = getLLMTaskConfig('embeddings').model;
      console.log(`\n⚠️  Embedding dimension mismatch detected!`);
      console.log(`   Stored embeddings: ${storedDimension} dimensions`);
      console.log(`   Current model (${embModel}): ${currentDimension} dimensions\n`);

      // Determine mode: interactive (TTY), explicit auto-reindex, or non-interactive
      const isInteractive = process.stdout.isTTY && !autoReindex;

      let action: string;
      if (isInteractive) {
        const response = await inquirer.prompt([
          {
            type: 'list',
            name: 'action',
            message: 'What would you like to do?',
            choices: [
              { name: 'Clear old index and reindex with current model', value: 'reindex' },
              { name: 'Cancel', value: 'cancel' },
            ],
          },
        ]);
        action = response.action;
      } else if (autoReindex) {
        // Explicitly requested auto-reindex (e.g. --auto-reindex flag)
        console.log('Auto-reindex requested: clearing and reindexing...');
        action = 'reindex';
      } else {
        // Non-interactive without explicit auto-reindex (MCP, daemon, scripts)
        // DO NOT auto-clear — this destroys data silently
        logWarn('index', 'Dimension mismatch detected in non-interactive mode');
        console.warn('Dimension mismatch detected in non-interactive mode.');
        logWarn('index', 'Skipping auto-clear to prevent data loss');
        console.warn('Skipping auto-clear to prevent data loss.');
        logWarn('index', 'Run "succ index --force" interactively to reindex');
        console.warn('Run "succ index --force" interactively to reindex.');
        return;
      }

      if (action === 'cancel') {
        console.log('Indexing cancelled.');
        return;
      }

      if (action === 'reindex') {
        console.log('\nClearing old index...');
        await clearDocuments();
        force = true; // Force reindex all files
      }
    }
  }

  console.log(`Indexing ${path.relative(projectRoot, searchPath) || searchPath}`);
  console.log(`Pattern: ${pattern}`);
  console.log(`Mode: ${force ? 'Force reindex all files' : 'Incremental (skip unchanged files)'}`);

  const result = await runIndexer({
    searchPath,
    projectRoot,
    patterns: [pattern],
    ignore: ['**/node_modules/**', '**/.git/**', '**/.obsidian/**'],
    force,
    batchSize: 10,
    chunker: chunkText,
    contentProcessor: (content) => {
      const { frontmatter, body } = extractFrontmatter(content);
      return {
        content: body,
        skip: !!frontmatter['succ-ignore'],
      };
    },
    // Only clean up non-code files
    cleanupFilter: (filePath) => !filePath.startsWith('code:'),
  });

  printResults(result);
}

/**
 * Compute content hash for a file
 */
function computeHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

export interface IndexDocFileResult {
  success: boolean;
  chunks?: number;
  error?: string;
  skipped?: boolean;
  reason?: string;
}

/**
 * Index a single documentation file
 */
export async function indexDocFile(filePath: string, options: { force?: boolean } = {}): Promise<IndexDocFileResult> {
  const { force = false } = options;
  const projectRoot = getProjectRoot();
  const absolutePath = path.resolve(filePath);

  // Check file exists
  if (!fs.existsSync(absolutePath)) {
    return { success: false, error: `File not found: ${filePath}` };
  }

  // Check it's a file, not directory
  const stats = fs.statSync(absolutePath);
  if (!stats.isFile()) {
    return { success: false, error: `Not a file: ${filePath}` };
  }

  // Check it's a markdown file
  if (!absolutePath.endsWith('.md')) {
    return { success: false, error: `Not a markdown file: ${filePath}` };
  }

  // Read file content
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const contentHash = computeHash(content);

  // Get relative path for storage — always relative to project root
  // (must match runIndexer and getStaleFiles which resolve from projectRoot)
  const relativePath = path.relative(projectRoot, absolutePath);

  // Check if file already indexed with same hash
  if (!force) {
    const existingHash = await getFileHash(relativePath);
    if (existingHash === contentHash) {
      return { success: true, skipped: true, reason: 'File unchanged (same hash)' };
    }
  }

  // Process content (extract frontmatter, check for succ-ignore)
  const { frontmatter, body } = extractFrontmatter(content);
  if (frontmatter['succ-ignore']) {
    return { success: true, skipped: true, reason: 'File has succ-ignore frontmatter' };
  }

  // Chunk the text
  const chunks = chunkText(body, absolutePath);
  if (chunks.length === 0) {
    return { success: true, skipped: true, reason: 'No chunks generated (file too small or empty)' };
  }

  // Generate embeddings
  const texts = chunks.map(c => c.content);
  const embeddings = await getEmbeddings(texts);

  // Prepare documents for upsert (with hash for each document)
  const documents = chunks.map((chunk, i) => ({
    filePath: relativePath,
    chunkIndex: i,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    embedding: embeddings[i],
    hash: contentHash,
  }));

  // Upsert to database
  await upsertDocumentsBatchWithHashes(documents);

  return { success: true, chunks: chunks.length };
}

/**
 * Re-embed all memories with the current embedding model.
 * Processes in batches, showing progress.
 */
async function reembedMemories(): Promise<void> {
  await initStorageDispatcher();

  const info = getEmbeddingInfo();
  const total = await getMemoryCount();
  const withEmb = await getMemoryEmbeddingCount();

  console.log(`Re-embedding memories with ${info.model} (${info.dimensions ?? '?'} dims)`);
  console.log(`Total memories: ${total}, with embeddings: ${withEmb}\n`);

  if (total === 0) {
    console.log('No memories to re-embed.');
    return;
  }

  const BATCH = 50;
  let processed = 0;
  let afterId = 0;

  while (processed < total) {
    const batch = await getMemoriesNeedingReembedding(BATCH, afterId);
    if (batch.length === 0) break;

    const texts = batch.map(m => m.content.slice(0, 2000));

    try {
      const embeddings = await getEmbeddings(texts);
      const updates = batch.map((m, i) => ({ id: m.id, embedding: embeddings[i] }));
      await updateMemoryEmbeddingsBatch(updates);

      processed += batch.length;
      afterId = batch[batch.length - 1].id;
      const pct = Math.min(100, (processed / total) * 100).toFixed(1);
      process.stdout.write(`\r  [${pct}%] ${processed}/${total}`);
    } catch (err) {
      logError('index', `Failed to re-embed batch after id ${afterId}: ${(err as Error).message}`);
      console.error(`\nError after id ${afterId}: ${(err as Error).message}`);
      break;
    }
  }

  console.log(`\nDone! Re-embedded ${processed} memories.`);
}
