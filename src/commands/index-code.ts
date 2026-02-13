import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import inquirer from 'inquirer';
import { getProjectRoot, getConfig } from '../lib/config.js';
import { chunkCodeAsync, enrichForEmbedding, getChunkingStats, resetChunkingStats } from '../lib/chunker.js';
import { runIndexer, printResults } from '../lib/indexer.js';
import { getStoredEmbeddingDimension, clearCodeDocuments, upsertDocumentsBatchWithHashes, getFileHash, updateTokenFrequencies } from '../lib/storage/index.js';
import { tokenizeCode, tokenizeCodeWithAST } from '../lib/bm25.js';
import { getEmbedding, getEmbeddings } from '../lib/embeddings.js';
import { needsBPERetrain, trainBPEFromDatabase } from '../lib/bpe.js';
import { DEFAULT_CODE_PATTERNS, DEFAULT_IGNORE_PATTERNS } from '../lib/patterns.js';
import { logError, logWarn } from '../lib/fault-logger.js';

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
  const {
    patterns = DEFAULT_CODE_PATTERNS,
    ignore = DEFAULT_IGNORE,
    maxFileSize = 500, // 500KB default
    autoReindex = false,
  } = options;
  let { force = false } = options;

  const projectRoot = getProjectRoot();
  const searchPath = targetPath ? path.resolve(targetPath) : projectRoot;

  if (!fs.existsSync(searchPath)) {
    logError('index-code', `Path not found: ${searchPath}`);

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
              { name: 'Clear old code index and reindex with current model', value: 'reindex' },
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
        logWarn('index-code', 'Dimension mismatch detected in non-interactive mode');
        console.warn('Dimension mismatch detected in non-interactive mode.');
        logWarn('index-code', 'Skipping auto-clear to prevent data loss');
        console.warn('Skipping auto-clear to prevent data loss.');
        logWarn('index-code', 'Run "succ index-code --force" interactively to reindex');
        console.warn('Run "succ index-code --force" interactively to reindex.');
        return;
      }

      if (action === 'cancel') {
        console.log('Indexing cancelled.');
        return;
      }

      if (action === 'reindex') {
        console.log('\nClearing old code index...');
        await clearCodeDocuments();
        force = true; // Force reindex all files
      }
    }
  }

  // Check if using non-default patterns (partial indexing)
  // In this case, skip cleanup to avoid deleting files not matching current patterns
  const isDefaultPatterns = JSON.stringify(patterns.sort()) === JSON.stringify(DEFAULT_CODE_PATTERNS.sort());
  const isFullIndex = searchPath === projectRoot && isDefaultPatterns;

  console.log(`Indexing code in ${path.relative(projectRoot, searchPath) || searchPath}`);
  console.log(`Patterns: ${patterns.join(', ')}`);
  console.log(`Mode: ${force ? 'Force reindex all files' : 'Incremental (skip unchanged files)'}`);

  resetChunkingStats();

  const result = await runIndexer({
    searchPath,
    projectRoot,
    patterns,
    ignore,
    force,
    batchSize: 5, // Smaller batches for code (larger chunks)
    maxFileSize,
    pathPrefix: 'code:', // Distinguish from brain docs
    chunker: chunkCodeAsync,
    // Only clean up code files
    cleanupFilter: (filePath) => filePath.startsWith('code:'),
    // Skip cleanup for partial indexing (custom patterns or subdirectory)
    skipCleanup: !isFullIndex,
  });

  printResults(result, 'code ');

  // Show AST vs regex chunking breakdown
  const chunkStats = getChunkingStats();
  if (chunkStats.astFiles > 0 || chunkStats.regexFiles > 0) {
    console.log(`  AST chunks:    ${chunkStats.astFiles} files (tree-sitter)`);
    if (chunkStats.regexFiles > 0) {
      console.log(`  Regex chunks:  ${chunkStats.regexFiles} files (fallback)`);
    }
  }

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
    const existingHash = await getFileHash(storedPath);
    if (existingHash === contentHash) {
      return { success: true, skipped: true, reason: 'File unchanged (same hash)' };
    }
  }

  // Chunk the code (tree-sitter with fallback to regex)
  const chunks = await chunkCodeAsync(content, absolutePath);
  if (chunks.length === 0) {
    return { success: true, skipped: true, reason: 'No chunks generated (file too small or empty)' };
  }

  // Generate embeddings — prepend symbol metadata for better semantic quality
  const texts = chunks.map(c => enrichForEmbedding(c));
  const embeddings = await getEmbeddings(texts);

  // Prepare documents for upsert (with hash for each document, including AST metadata)
  const documents = chunks.map((chunk, i) => ({
    filePath: storedPath,
    chunkIndex: i,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    embedding: embeddings[i],
    hash: contentHash,
    symbolName: chunk.symbolName,
    symbolType: chunk.symbolType,
    signature: chunk.signature,
  }));

  // Upsert to database
  await upsertDocumentsBatchWithHashes(documents);

  // Update token frequencies (boost AST identifiers when available)
  const allTokens: string[] = [];
  for (const chunk of chunks) {
    if (chunk.symbolName || chunk.signature) {
      const sigTokens = chunk.signature ? tokenizeCode(chunk.signature) : [];
      const tokens = tokenizeCodeWithAST(chunk.content, sigTokens, chunk.symbolName ?? undefined);
      allTokens.push(...tokens);
    } else {
      const tokens = tokenizeCode(chunk.content);
      allTokens.push(...tokens);
    }
  }
  await updateTokenFrequencies(allTokens);

  return { success: true, chunks: chunks.length };
}
