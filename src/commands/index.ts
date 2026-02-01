import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { getClaudeDir, getProjectRoot, getConfig } from '../lib/config.js';
import { chunkText, extractFrontmatter } from '../lib/chunker.js';
import { runIndexer, printResults } from '../lib/indexer.js';
import { getStoredEmbeddingDimension, clearDocuments } from '../lib/db.js';
import { getEmbedding } from '../lib/embeddings.js';

interface IndexOptions {
  recursive?: boolean;
  pattern?: string;
  force?: boolean;
}

export async function index(
  targetPath?: string,
  options: IndexOptions = {}
): Promise<void> {
  let { pattern = '**/*.md', force = false } = options;
  const projectRoot = getProjectRoot();
  const claudeDir = getClaudeDir();

  // Default to brain directory
  const searchPath = targetPath
    ? path.resolve(targetPath)
    : path.join(claudeDir, 'brain');

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

      const { action } = await inquirer.prompt([
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

      if (action === 'cancel') {
        console.log('Indexing cancelled.');
        return;
      }

      if (action === 'reindex') {
        console.log('\nClearing old index...');
        clearDocuments();
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
