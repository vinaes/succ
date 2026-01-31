import fs from 'fs';
import path from 'path';
import { getProjectRoot } from '../lib/config.js';
import { chunkCode } from '../lib/chunker.js';
import { runIndexer, printResults } from '../lib/indexer.js';

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
];

interface IndexCodeOptions {
  patterns?: string[];
  ignore?: string[];
  force?: boolean;
  maxFileSize?: number; // in KB
}

export async function indexCode(
  targetPath?: string,
  options: IndexCodeOptions = {}
): Promise<void> {
  const {
    patterns = DEFAULT_CODE_PATTERNS,
    ignore = DEFAULT_IGNORE,
    force = false,
    maxFileSize = 500, // 500KB default
  } = options;

  const projectRoot = getProjectRoot();
  const searchPath = targetPath ? path.resolve(targetPath) : projectRoot;

  if (!fs.existsSync(searchPath)) {
    console.error(`Path not found: ${searchPath}`);
    process.exit(1);
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
