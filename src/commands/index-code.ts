import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import inquirer from 'inquirer';
import { getProjectRoot, getConfig } from '../lib/config.js';
import { chunkCode } from '../lib/chunker.js';
import { runIndexer, printResults } from '../lib/indexer.js';
import { getStoredEmbeddingDimension, clearCodeDocuments, upsertDocumentsBatchWithHashes, getFileHash, updateTokenFrequencies } from '../lib/db.js';
import { tokenizeCode } from '../lib/bm25.js';
import { getEmbedding, getEmbeddings } from '../lib/embeddings.js';
import { needsBPERetrain, trainBPEFromDatabase, getLastBPETrainTime } from '../lib/bpe.js';
import { DEFAULT_CODE_PATTERNS, DEFAULT_IGNORE_PATTERNS } from '../lib/patterns.js';

// Alias for backwards compatibility
const DEFAULT_IGNORE = DEFAULT_IGNORE_PATTERNS;

interface IndexCodeOptions {
  patterns?: string[];
  ignore?: string[];
  force?: boolean;
  maxFileSize?: number; // in KB
  autoReindex?: boolean; // Auto-reindex on dimension mismatch (for non-interactive mode)
}

export async function indexCode(
  targetPath?: string,
  options: IndexCodeOptions = {}
): Promise<void> {
  let {
    patterns = DEFAULT_CODE_PATTERNS,
    ignore = DEFAULT_IGNORE,
    force = false,
    maxFileSize = 500, // 500KB default
    autoReindex = false,
  } = options;

  const projectRoot = getProjectRoot();
  const searchPath = targetPath ? path.resolve(targetPath) : projectRoot;

  if (!fs.existsSync(searchPath)) {
    console.error(`Path not found: ${searchPath}`);
    process.exit(1);
  }

  // Check for dimension mismatch before indexing
  const storedDimension = getStoredEmbeddingDimension();
  if (storedDimension !== null && !force) {
    // Get a test embedding to check current dimension
    const testEmbedding = await getEmbedding('test');
    const currentDimension = testEmbedding.length;

    if (storedDimension !== currentDimension) {
      const config = getConfig();
      console.log(`\n⚠️  Embedding dimension mismatch detected!`);
      console.log(`   Stored embeddings: ${storedDimension} dimensions`);
      console.log(`   Current model (${config.embedding_model}): ${currentDimension} dimensions\n`);

      // In non-interactive mode (no TTY or autoReindex), auto-clear and reindex
      const isInteractive = process.stdout.isTTY && !autoReindex;

      let action: string;
      if (isInteractive) {
        const response = await inquirer.prompt([
          {
            type: 'list',
            name: 'action',
            message: 'What would you like to do?',
            choices: [
              { name: 'Clear old code index and reindex with current model', value: 'reindex' },
              { name: 'Cancel', value: 'cancel' },
            ],
          },
        ]);
        action = response.action;
      } else {
        // Non-interactive: auto-reindex
        console.log('Non-interactive mode: automatically clearing and reindexing...');
        action = 'reindex';
      }

      if (action === 'cancel') {
        console.log('Indexing cancelled.');
        return;
      }

      if (action === 'reindex') {
        console.log('\nClearing old code index...');
        clearCodeDocuments();
        force = true; // Force reindex all files
      }
    }
  }

  console.log(`Indexing code in ${path.relative(projectRoot, searchPath) || searchPath}`);
  console.log(`Patterns: ${patterns.join(', ')}`);
  console.log(`Mode: ${force ? 'Force reindex all files' : 'Incremental (skip unchanged files)'}`);

  const result = await runIndexer({
    searchPath,
    projectRoot,
    patterns,
    ignore,
    force,
    batchSize: 5, // Smaller batches for code (larger chunks)
    maxFileSize,
    pathPrefix: 'code:', // Distinguish from brain docs
    chunker: chunkCode,
    // Only clean up code files
    cleanupFilter: (filePath) => filePath.startsWith('code:'),
  });

  printResults(result, 'code ');

  if (result.skippedLargeFiles > 0) {
    console.log(`  (Large files >${maxFileSize}KB were skipped)`);
  }

  // Check if BPE needs retraining after indexing
  // Only if we actually indexed new files
  if (result.newFiles > 0 || result.updatedFiles > 0) {
    const config = getConfig();
    if (config.bpe?.enabled) {
      const lastIndexTime = new Date().toISOString();
      if (needsBPERetrain(config.bpe.retrain_interval || 'hourly', lastIndexTime)) {
        console.log('\nBPE vocabulary may be stale, retraining...');
        await trainBPEFromDatabase(config.bpe.vocab_size, config.bpe.min_frequency);
      }
    }
  }
}

/**
 * Compute content hash for a file
 */
function computeHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

export interface IndexCodeFileResult {
  success: boolean;
  chunks?: number;
  error?: string;
  skipped?: boolean;
  reason?: string;
}

/**
 * Index a single code file
 */
export async function indexCodeFile(filePath: string, options: { force?: boolean } = {}): Promise<IndexCodeFileResult> {
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

  // Check file size (500KB limit)
  const maxFileSize = 500 * 1024;
  if (stats.size > maxFileSize) {
    return { success: false, skipped: true, reason: `File too large: ${(stats.size / 1024).toFixed(0)}KB > 500KB` };
  }

  // Read file content
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const contentHash = computeHash(content);

  // Get relative path for storage (with code: prefix)
  const relativePath = path.relative(projectRoot, absolutePath);
  const storedPath = `code:${relativePath}`;

  // Check if file already indexed with same hash
  if (!force) {
    const existingHash = getFileHash(storedPath);
    if (existingHash === contentHash) {
      return { success: true, skipped: true, reason: 'File unchanged (same hash)' };
    }
  }

  // Chunk the code
  const chunks = chunkCode(content, absolutePath);
  if (chunks.length === 0) {
    return { success: true, skipped: true, reason: 'No chunks generated (file too small or empty)' };
  }

  // Generate embeddings
  const texts = chunks.map(c => c.content);
  const embeddings = await getEmbeddings(texts);

  // Prepare documents for upsert (with hash for each document)
  const documents = chunks.map((chunk, i) => ({
    filePath: storedPath,
    chunkIndex: i,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    embedding: embeddings[i],
    hash: contentHash,
  }));

  // Upsert to database
  upsertDocumentsBatchWithHashes(documents);

  // Update token frequencies for Ronin-style segmentation
  const allTokens: string[] = [];
  for (const chunk of chunks) {
    const tokens = tokenizeCode(chunk.content);
    allTokens.push(...tokens);
  }
  updateTokenFrequencies(allTokens);

  return { success: true, chunks: chunks.length };
}
