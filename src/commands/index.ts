import fs from 'fs';
import path from 'path';
import { getClaudeDir, getProjectRoot } from '../lib/config.js';
import { chunkText, extractFrontmatter } from '../lib/chunker.js';
import { runIndexer, printResults } from '../lib/indexer.js';

interface IndexOptions {
  recursive?: boolean;
  pattern?: string;
  force?: boolean;
}

export async function index(
  targetPath?: string,
  options: IndexOptions = {}
): Promise<void> {
  const { pattern = '**/*.md', force = false } = options;
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
