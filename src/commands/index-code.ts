import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { getProjectRoot, getConfig } from '../lib/config.js';
import { chunkCode } from '../lib/chunker.js';
import { runIndexer, printResults } from '../lib/indexer.js';
import { getStoredEmbeddingDimension, clearCodeDocuments } from '../lib/db.js';
import { getEmbedding } from '../lib/embeddings.js';

// Default patterns for common code files
const DEFAULT_CODE_PATTERNS = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.py',
  '**/*.go',
  '**/*.rs',
  '**/*.java',
  '**/*.kt',
];

// Default ignore patterns
const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/target/**',
  '**/__pycache__/**',
  '**/venv/**',
  '**/.venv/**',
  '**/vendor/**',
  '**/*.min.js',
  '**/*.bundle.js',
  '**/coverage/**',
  '**/.claude/**',
  '**/.succ/**',
];

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
}
