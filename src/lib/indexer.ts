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
  updateTokenFrequencies,
} from './storage/index.js';
import { tokenizeCode, tokenizeCodeWithAST } from './bm25.js';
import { logError } from './fault-logger.js';

import { enrichForEmbedding, type Chunk } from './chunker.js';
export type { Chunk };

export interface IndexerOptions {
  searchPath: string;
  projectRoot: string;
  patterns: string[];
  ignore: string[];
  force: boolean;
  batchSize?: number;
  maxFileSize?: number; // in KB, optional
  pathPrefix?: string; // e.g., 'code:' for code files
  chunker: (content: string, filePath: string) => Chunk[] | Promise<Chunk[]>;
  contentProcessor?: (content: string) => { content: string; skip: boolean };
  cleanupFilter?: (filePath: string) => boolean; // Filter for cleanup phase
  skipCleanup?: boolean; // Skip cleanup phase entirely (for partial/single-file indexing)
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
    skipCleanup = false,
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
  const existingHashes = await getAllFileHashes();
  const currentFiles = new Set<string>();

  let totalChunks = 0;
  let skippedFiles = 0;
  let newFiles = 0;
  let updatedFiles = 0;
  let skippedLargeFiles = 0;

  const totalBatches = Math.ceil(uniqueFiles.length / batchSize);

  // Process files in batches with parallel file reading and single batch embedding
  for (let i = 0; i < uniqueFiles.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    const progress = Math.round((batchNum / totalBatches) * 100);
    process.stdout.write(`\r  [${progress}%] Processing batch ${batchNum}/${totalBatches}...`);

    const batch = uniqueFiles.slice(i, i + batchSize);

    // 1. Parallel file reading and chunking
    interface FileData {
      filePath: string;
      relativePath: string;
      hash: string;
      chunks: Chunk[];
      isNew: boolean;
    }

    const fileDataPromises = batch.map(async (filePath): Promise<FileData | null> => {
      // Check file size if limit specified
      if (maxFileSize) {
        const stats = await fs.promises.stat(filePath);
        if (stats.size > maxFileSize * 1024) {
          skippedLargeFiles++;
          return null;
        }
      }

      const rawContent = await fs.promises.readFile(filePath, 'utf-8');
      const relativePath = pathPrefix + path.relative(projectRoot, filePath);
      currentFiles.add(relativePath);

      // Compute content hash
      const hash = computeHash(rawContent);
      const existingHash = existingHashes.get(relativePath);

      // Skip if unchanged (unless force mode)
      if (!force && existingHash === hash) {
        skippedFiles++;
        return null;
      }

      // Process content if processor provided
      let content = rawContent;
      if (contentProcessor) {
        const processed = contentProcessor(rawContent);
        if (processed.skip) return null;
        content = processed.content;
      }

      // Track if new or updated
      const isNew = !existingHash;

      // Chunk the content (supports both sync and async chunkers)
      const chunks = await Promise.resolve(chunker(content, filePath));
      if (chunks.length === 0) return null;

      return { filePath, relativePath, hash, chunks, isNew };
    });

    const fileDataResults = await Promise.all(fileDataPromises);
    const validFiles = fileDataResults.filter((f): f is FileData => f !== null);

    if (validFiles.length === 0) continue;

    // 2. Collect all chunks from batch for single embedding call
    const allChunksWithMeta: Array<{
      fileIndex: number;
      chunkIndex: number;
      content: string;
      startLine: number;
      endLine: number;
      symbolName?: string;
      symbolType?: string;
      signature?: string;
    }> = [];

    for (let fileIdx = 0; fileIdx < validFiles.length; fileIdx++) {
      const file = validFiles[fileIdx];
      for (let chunkIdx = 0; chunkIdx < file.chunks.length; chunkIdx++) {
        const chunk = file.chunks[chunkIdx];
        allChunksWithMeta.push({
          fileIndex: fileIdx,
          chunkIndex: chunkIdx,
          content: chunk.content,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          symbolName: chunk.symbolName,
          symbolType: chunk.symbolType,
          signature: chunk.signature,
        });
      }
    }

    try {
      // 3. Single batch embedding for all chunks in batch
      // For code files, prepend symbol metadata to improve semantic embedding quality
      const embeddingTexts = pathPrefix === 'code:'
        ? allChunksWithMeta.map(c => enrichForEmbedding(c as Chunk))
        : allChunksWithMeta.map(c => c.content);
      const allEmbeddings = await getEmbeddings(embeddingTexts);

      // 4. Group by file and save
      const documentsByFile = new Map<number, Array<{
        filePath: string;
        chunkIndex: number;
        content: string;
        startLine: number;
        endLine: number;
        embedding: number[];
        hash: string;
        symbolName?: string;
        symbolType?: string;
        signature?: string;
      }>>();

      for (let i = 0; i < allChunksWithMeta.length; i++) {
        const chunkMeta = allChunksWithMeta[i];
        const file = validFiles[chunkMeta.fileIndex];

        if (!documentsByFile.has(chunkMeta.fileIndex)) {
          documentsByFile.set(chunkMeta.fileIndex, []);
        }

        documentsByFile.get(chunkMeta.fileIndex)!.push({
          filePath: file.relativePath,
          chunkIndex: chunkMeta.chunkIndex,
          content: chunkMeta.content,
          startLine: chunkMeta.startLine,
          endLine: chunkMeta.endLine,
          embedding: allEmbeddings[i],
          hash: file.hash,
          symbolName: chunkMeta.symbolName,
          symbolType: chunkMeta.symbolType,
          signature: chunkMeta.signature,
        });
      }

      // 5. Save documents and update stats
      for (const [fileIdx, documents] of documentsByFile) {
        const file = validFiles[fileIdx];

        // Track stats
        if (file.isNew) {
          newFiles++;
        } else {
          updatedFiles++;
        }

        // Delete existing chunks for this file
        await deleteDocumentsByPath(file.relativePath);

        // Save new documents
        await upsertDocumentsBatchWithHashes(documents);

        // Update token frequencies for code files (boost AST identifiers when available)
        if (pathPrefix === 'code:') {
          const allTokens: string[] = [];
          for (const doc of documents) {
            if (doc.symbolName || doc.signature) {
              // Use signature tokens as pseudo-AST identifiers for BM25 boost
              const sigTokens = doc.signature ? tokenizeCode(doc.signature) : [];
              const tokens = tokenizeCodeWithAST(doc.content, sigTokens, doc.symbolName ?? undefined);
              allTokens.push(...tokens);
            } else {
              const tokens = tokenizeCode(doc.content);
              allTokens.push(...tokens);
            }
          }
          await updateTokenFrequencies(allTokens);
        }

        totalChunks += documents.length;
      }
    } catch (error) {
      logError('indexer', `Error processing batch ${batchNum}`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  // Clear progress line
  process.stdout.write('\r' + ' '.repeat(60) + '\r');

  // Clean up deleted files (skip if partial indexing)
  let deletedFiles = 0;
  if (!skipCleanup) {
    for (const [filePath] of existingHashes) {
      // Apply cleanup filter if provided
      if (cleanupFilter && !cleanupFilter(filePath)) continue;

      if (!currentFiles.has(filePath)) {
        await deleteDocumentsByPath(filePath);
        await deleteFileHash(filePath);
        deletedFiles++;
      }
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
  console.log('');
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
