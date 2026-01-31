import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { getClaudeDir, getProjectRoot } from '../lib/config.js';
import { getEmbeddings } from '../lib/embeddings.js';
import { chunkText, extractFrontmatter } from '../lib/chunker.js';
import { upsertDocument, deleteDocumentsByPath, closeDb } from '../lib/db.js';

interface IndexOptions {
  recursive?: boolean;
  pattern?: string;
}

export async function index(
  targetPath?: string,
  options: IndexOptions = {}
): Promise<void> {
  const { recursive = true, pattern = '**/*.md' } = options;
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

  // Find files
  const files = await glob(pattern, {
    cwd: searchPath,
    absolute: true,
    nodir: true,
    ignore: ['**/node_modules/**', '**/.git/**'],
  });

  if (files.length === 0) {
    console.log('No files found matching pattern.');
    return;
  }

  console.log(`Found ${files.length} files`);

  let totalChunks = 0;
  let totalTokens = 0;

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
    }> = [];

    // Read and chunk files
    for (const filePath of batch) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(projectRoot, filePath);

      // Extract frontmatter for metadata
      const { frontmatter, body } = extractFrontmatter(content);

      // Skip if marked as no-index
      if (frontmatter['succ-ignore']) {
        console.log(`  Skipping ${relativePath} (succ-ignore)`);
        continue;
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
        });
      }
    }

    if (allChunks.length === 0) continue;

    // Get embeddings for all chunks in batch
    console.log(`  Processing ${allChunks.length} chunks...`);

    try {
      const texts = allChunks.map((c) => c.content);
      const embeddings = await getEmbeddings(texts);

      // Store in database
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
      }

      totalChunks += allChunks.length;
      // Rough token estimate
      totalTokens += texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
    } catch (error) {
      console.error(`  Error processing batch:`, error);
    }
  }

  closeDb();

  console.log(`\nIndexed ${totalChunks} chunks from ${files.length} files`);
  console.log(`Estimated tokens used: ~${totalTokens}`);
}
