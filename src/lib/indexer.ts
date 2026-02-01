import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { glob } from 'glob';
import { getEmbeddings } from './embeddings.js';
import {
  upsertDocumentsBatchWithHashes,
  deleteDocumentsByPath,
  closeDb,
  deleteFileHash,
  getAllFileHashes,
} from './db.js';

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
}

export interface IndexerOptions {
  searchPath: string;
  projectRoot: string;
  patterns: string[];
  ignore: string[];
  force: boolean;
  batchSize?: number;
  maxFileSize?: number; // in KB, optional
  pathPrefix?: string; // e.g., 'code:' for code files
  chunker: (content: string, filePath: string) => Chunk[];
  contentProcessor?: (content: string) => { content: string; skip: boolean };
  cleanupFilter?: (filePath: string) => boolean; // Filter for cleanup phase
}

export interface IndexerResult {
  totalChunks: number;
  newFiles: number;
  updatedFiles: number;
  skippedFiles: number;
  skippedLargeFiles: number;
  deletedFiles: number;
}

/**
 * Compute content hash for a file
 */
function computeHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Generic indexer for documents and code
 */
export async function runIndexer(options: IndexerOptions): Promise<IndexerResult> {
  const {
    searchPath,
    projectRoot,
    patterns,
    ignore,
    force,
    batchSize = 10,
    maxFileSize,
    pathPrefix = '',
    chunker,
    contentProcessor,
    cleanupFilter,
  } = options;

  // Find files matching patterns
  const allFiles: string[] = [];
  for (const pattern of patterns) {
    const files = await glob(pattern, {
      cwd: searchPath,
      absolute: true,
      nodir: true,
      ignore,
    });
    allFiles.push(...files);
  }

  // Remove duplicates
  const uniqueFiles = [...new Set(allFiles)];

  if (uniqueFiles.length === 0) {
    return {
      totalChunks: 0,
      newFiles: 0,
      updatedFiles: 0,
      skippedFiles: 0,
      skippedLargeFiles: 0,
      deletedFiles: 0,
    };
  }

  console.log(`Found ${uniqueFiles.length} files`);

  // Get existing hashes for incremental indexing
  const existingHashes = getAllFileHashes();
  const currentFiles = new Set<string>();

  let totalChunks = 0;
  let skippedFiles = 0;
  let newFiles = 0;
  let updatedFiles = 0;
  let skippedLargeFiles = 0;

  const totalBatches = Math.ceil(uniqueFiles.length / batchSize);

  // Process files in batches - but embed each file individually to reduce memory
  for (let i = 0; i < uniqueFiles.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    const progress = Math.round((batchNum / totalBatches) * 100);
    process.stdout.write(`\r  [${progress}%] Processing batch ${batchNum}/${totalBatches}...`);

    const batch = uniqueFiles.slice(i, i + batchSize);

    // Process each file individually to reduce memory footprint
    for (const filePath of batch) {
      // Check file size if limit specified
      if (maxFileSize) {
        const stats = fs.statSync(filePath);
        if (stats.size > maxFileSize * 1024) {
          skippedLargeFiles++;
          continue;
        }
      }

      const rawContent = fs.readFileSync(filePath, 'utf-8');
      const relativePath = pathPrefix + path.relative(projectRoot, filePath);
      currentFiles.add(relativePath);

      // Compute content hash
      const hash = computeHash(rawContent);
      const existingHash = existingHashes.get(relativePath);

      // Skip if unchanged (unless force mode)
      if (!force && existingHash === hash) {
        skippedFiles++;
        continue;
      }

      // Process content if processor provided
      let content = rawContent;
      if (contentProcessor) {
        const processed = contentProcessor(rawContent);
        if (processed.skip) continue;
        content = processed.content;
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
      const chunks = chunker(content, filePath);
      if (chunks.length === 0) continue;

      try {
        // Embed and store this file's chunks immediately (reduces memory)
        const texts = chunks.map((c) => c.content);
        const embeddings = await getEmbeddings(texts);

        const documents = chunks.map((chunk, j) => ({
          filePath: relativePath,
          chunkIndex: j,
          content: chunk.content,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          embedding: embeddings[j],
          hash,
        }));
        upsertDocumentsBatchWithHashes(documents);

        totalChunks += chunks.length;
      } catch (error) {
        console.error(`\n  Error processing ${relativePath}:`, error);
      }
    }
  }

  // Clear progress line
  process.stdout.write('\r' + ' '.repeat(60) + '\r');

  // Clean up deleted files
  let deletedFiles = 0;
  for (const [filePath] of existingHashes) {
    // Apply cleanup filter if provided
    if (cleanupFilter && !cleanupFilter(filePath)) continue;

    if (!currentFiles.has(filePath)) {
      deleteDocumentsByPath(filePath);
      deleteFileHash(filePath);
      deletedFiles++;
    }
  }

  closeDb();

  return {
    totalChunks,
    newFiles,
    updatedFiles,
    skippedFiles,
    skippedLargeFiles,
    deletedFiles,
  };
}

/**
 * Print indexer results
 */
export function printResults(result: IndexerResult, prefix: string = ''): void {
  console.log();
  console.log(`Indexed ${result.totalChunks} ${prefix}chunks`);
  console.log(`  New files:     ${result.newFiles}`);
  console.log(`  Updated files: ${result.updatedFiles}`);
  console.log(`  Skipped:       ${result.skippedFiles} (unchanged)`);
  if (result.skippedLargeFiles > 0) {
    console.log(`  Skipped:       ${result.skippedLargeFiles} (too large)`);
  }
  if (result.deletedFiles > 0) {
    console.log(`  Removed:       ${result.deletedFiles} (deleted)`);
  }
}
