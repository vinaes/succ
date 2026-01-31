import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { glob } from 'glob';
import { getClaudeDir, getProjectRoot } from '../lib/config.js';
import { getEmbeddings } from '../lib/embeddings.js';
import { chunkText, extractFrontmatter } from '../lib/chunker.js';
import {
  upsertDocument,
  deleteDocumentsByPath,
  closeDb,
  getFileHash,
  setFileHash,
  deleteFileHash,
  getAllFileHashes,
} from '../lib/db.js';

/**
 * Compute content hash for a file
 */
function computeHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

interface IndexOptions {
  recursive?: boolean;
  pattern?: string;
  force?: boolean;  // Force reindex all files
}

export async function index(
  targetPath?: string,
  options: IndexOptions = {}
): Promise<void> {
  const { recursive = true, pattern = '**/*.md', force = false } = options;
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
  if (force) {
    console.log('Mode: Force reindex all files');
  } else {
    console.log('Mode: Incremental (skip unchanged files)');
  }

  // Find files
  const files = await glob(pattern, {
    cwd: searchPath,
    absolute: true,
    nodir: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/.obsidian/**'],
  });

  if (files.length === 0) {
    console.log('No files found matching pattern.');
    return;
  }

  console.log(`Found ${files.length} files`);

  // Get existing hashes for incremental indexing
  const existingHashes = getAllFileHashes();
  const currentFiles = new Set<string>();

  let totalChunks = 0;
  let totalTokens = 0;
  let skippedFiles = 0;
  let newFiles = 0;
  let updatedFiles = 0;

  // Process files in batches
  const batchSize = 10;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const allChunks: Array<{
      filePath: string;
      chunkIndex: number;
      content: string;
      startLine: number;
      endLine: number;
      hash: string;
    }> = [];

    // Read and chunk files
    for (const filePath of batch) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(projectRoot, filePath);
      currentFiles.add(relativePath);

      // Compute content hash
      const hash = computeHash(content);
      const existingHash = existingHashes.get(relativePath);

      // Skip if unchanged (unless force mode)
      if (!force && existingHash === hash) {
        skippedFiles++;
        continue;
      }

      // Extract frontmatter for metadata
      const { frontmatter, body } = extractFrontmatter(content);

      // Skip if marked as no-index
      if (frontmatter['succ-ignore']) {
        continue;
      }

      // Track if new or updated
      if (existingHash) {
        updatedFiles++;
      } else {
        newFiles++;
      }

      // Delete existing chunks for this file
      deleteDocumentsByPath(relativePath);

      // Chunk the content
      const chunks = chunkText(body, relativePath);

      for (let j = 0; j < chunks.length; j++) {
        allChunks.push({
          filePath: relativePath,
          chunkIndex: j,
          content: chunks[j].content,
          startLine: chunks[j].startLine,
          endLine: chunks[j].endLine,
          hash,
        });
      }
    }

    if (allChunks.length === 0) continue;

    // Get embeddings for all chunks in batch
    console.log(`  Processing ${allChunks.length} chunks...`);

    try {
      const texts = allChunks.map((c) => c.content);
      const embeddings = await getEmbeddings(texts);

      // Store in database and update hashes
      const processedFiles = new Set<string>();
      for (let j = 0; j < allChunks.length; j++) {
        const chunk = allChunks[j];
        upsertDocument(
          chunk.filePath,
          chunk.chunkIndex,
          chunk.content,
          chunk.startLine,
          chunk.endLine,
          embeddings[j]
        );

        // Update hash once per file
        if (!processedFiles.has(chunk.filePath)) {
          setFileHash(chunk.filePath, chunk.hash);
          processedFiles.add(chunk.filePath);
        }
      }

      totalChunks += allChunks.length;
      // Rough token estimate
      totalTokens += texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
    } catch (error) {
      console.error(`  Error processing batch:`, error);
    }
  }

  // Clean up deleted files
  let deletedFiles = 0;
  for (const [filePath] of existingHashes) {
    if (!currentFiles.has(filePath)) {
      deleteDocumentsByPath(filePath);
      deleteFileHash(filePath);
      deletedFiles++;
    }
  }

  closeDb();

  console.log();
  console.log(`Indexed ${totalChunks} chunks`);
  console.log(`  New files:     ${newFiles}`);
  console.log(`  Updated files: ${updatedFiles}`);
  console.log(`  Skipped:       ${skippedFiles} (unchanged)`);
  if (deletedFiles > 0) {
    console.log(`  Removed:       ${deletedFiles} (deleted)`);
  }
  if (totalTokens > 0) {
    console.log(`Estimated tokens used: ~${totalTokens}`);
  }
}
