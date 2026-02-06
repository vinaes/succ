import { getDb } from './connection.js';
import { sqliteVecAvailable } from './schema.js';
import { floatArrayToBuffer, bufferToFloatArray } from './helpers.js';
import { SearchResult } from './types.js';
import { cosineSimilarity } from '../embeddings.js';
import { invalidateCodeBm25Index, invalidateDocsBm25Index } from './bm25-indexes.js';

/** Invalidate the BM25 index appropriate for a file path */
function invalidateBm25ForPath(filePath: string): void {
  if (filePath.startsWith('code:')) {
    invalidateCodeBm25Index();
  } else {
    invalidateDocsBm25Index();
  }
}

export interface DocumentBatch {
  filePath: string;
  chunkIndex: number;
  content: string;
  startLine: number;
  endLine: number;
  embedding: number[];
}

export interface DocumentBatchWithHash extends DocumentBatch {
  hash: string;
}

export function upsertDocument(
  filePath: string,
  chunkIndex: number,
  content: string,
  startLine: number,
  endLine: number,
  embedding: number[]
): void {
  const database = getDb();
  const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);

  // Get existing doc ID if any (for vec table update)
  const existing = database
    .prepare('SELECT id FROM documents WHERE file_path = ? AND chunk_index = ?')
    .get(filePath, chunkIndex) as { id: number } | undefined;

  database
    .prepare(
      `
    INSERT INTO documents (file_path, chunk_index, content, start_line, end_line, embedding, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(file_path, chunk_index) DO UPDATE SET
      content = excluded.content,
      start_line = excluded.start_line,
      end_line = excluded.end_line,
      embedding = excluded.embedding,
      updated_at = CURRENT_TIMESTAMP
  `
    )
    .run(filePath, chunkIndex, content, startLine, endLine, embeddingBlob);

  // Update vec_documents with mapping table
  if (sqliteVecAvailable) {
    try {
      if (existing) {
        // Update existing: delete old mapping and vec entry, insert new
        const oldMapping = database.prepare('SELECT vec_rowid FROM vec_documents_map WHERE doc_id = ?').get(existing.id) as { vec_rowid: number } | undefined;
        if (oldMapping) {
          database.prepare('DELETE FROM vec_documents WHERE rowid = ?').run(oldMapping.vec_rowid);
          database.prepare('DELETE FROM vec_documents_map WHERE doc_id = ?').run(existing.id);
        }
        const vecResult = database.prepare('INSERT INTO vec_documents(embedding) VALUES (?)').run(embeddingBlob);
        database.prepare('INSERT INTO vec_documents_map(vec_rowid, doc_id) VALUES (?, ?)').run(vecResult.lastInsertRowid, existing.id);
      } else {
        // New doc - get the inserted ID
        const newDoc = database
          .prepare('SELECT id FROM documents WHERE file_path = ? AND chunk_index = ?')
          .get(filePath, chunkIndex) as { id: number };
        const vecResult = database.prepare('INSERT INTO vec_documents(embedding) VALUES (?)').run(embeddingBlob);
        database.prepare('INSERT INTO vec_documents_map(vec_rowid, doc_id) VALUES (?, ?)').run(vecResult.lastInsertRowid, newDoc.id);
      }
    } catch {
      // Ignore vec table errors
    }
  }

  invalidateBm25ForPath(filePath);
}

/**
 * Batch upsert documents in a single transaction.
 * ~100x faster than individual upserts due to single fsync.
 */
export function upsertDocumentsBatch(documents: DocumentBatch[]): void {
  if (documents.length === 0) return;

  const database = getDb();

  const stmt = database.prepare(`
    INSERT INTO documents (file_path, chunk_index, content, start_line, end_line, embedding, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(file_path, chunk_index) DO UPDATE SET
      content = excluded.content,
      start_line = excluded.start_line,
      end_line = excluded.end_line,
      embedding = excluded.embedding,
      updated_at = CURRENT_TIMESTAMP
  `);

  const transaction = database.transaction((docs: DocumentBatch[]) => {
    for (const doc of docs) {
      const embeddingBlob = Buffer.from(new Float32Array(doc.embedding).buffer);
      stmt.run(doc.filePath, doc.chunkIndex, doc.content, doc.startLine, doc.endLine, embeddingBlob);
    }
  });

  transaction(documents);

  // Rebuild vec_documents for affected files
  rebuildVecDocumentsForFiles(documents.map(d => d.filePath));

  // Auto-invalidate affected BM25 indexes
  const hasCode = documents.some(d => d.filePath.startsWith('code:'));
  const hasDocs = documents.some(d => !d.filePath.startsWith('code:'));
  if (hasCode) invalidateCodeBm25Index();
  if (hasDocs) invalidateDocsBm25Index();
}

/**
 * Rebuild vec_documents entries for specific files
 */
function rebuildVecDocumentsForFiles(filePaths: string[]): void {
  if (!sqliteVecAvailable || filePaths.length === 0) return;

  const database = getDb();
  const uniquePaths = [...new Set(filePaths)];

  try {
    const transaction = database.transaction(() => {
      for (const filePath of uniquePaths) {
        // Get all docs for this file
        const docs = database
          .prepare('SELECT id, embedding FROM documents WHERE file_path = ?')
          .all(filePath) as Array<{ id: number; embedding: Buffer }>;

        for (const doc of docs) {
          // Delete existing vec entry if any (using mapping table)
          const existing = database.prepare('SELECT vec_rowid FROM vec_documents_map WHERE doc_id = ?').get(doc.id) as { vec_rowid: number } | undefined;
          if (existing) {
            database.prepare('DELETE FROM vec_documents WHERE rowid = ?').run(existing.vec_rowid);
            database.prepare('DELETE FROM vec_documents_map WHERE doc_id = ?').run(doc.id);
          }
          // Insert new vec entry with mapping
          const vecResult = database.prepare('INSERT INTO vec_documents(embedding) VALUES (?)').run(doc.embedding);
          database.prepare('INSERT INTO vec_documents_map(vec_rowid, doc_id) VALUES (?, ?)').run(vecResult.lastInsertRowid, doc.id);
        }
      }
    });
    transaction();
  } catch {
    // Ignore vec table errors
  }
}

/**
 * Batch upsert documents AND their file hashes in a single transaction.
 * Prevents race condition where chunks are saved but hashes are not.
 */
export function upsertDocumentsBatchWithHashes(documents: DocumentBatchWithHash[]): void {
  if (documents.length === 0) return;

  const database = getDb();

  const docStmt = database.prepare(`
    INSERT INTO documents (file_path, chunk_index, content, start_line, end_line, embedding, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(file_path, chunk_index) DO UPDATE SET
      content = excluded.content,
      start_line = excluded.start_line,
      end_line = excluded.end_line,
      embedding = excluded.embedding,
      updated_at = CURRENT_TIMESTAMP
  `);

  const hashStmt = database.prepare(`
    INSERT INTO file_hashes (file_path, content_hash, indexed_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(file_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      indexed_at = CURRENT_TIMESTAMP
  `);

  const transaction = database.transaction((docs: DocumentBatchWithHash[]) => {
    const processedFiles = new Set<string>();

    for (const doc of docs) {
      // Insert document
      const embeddingBlob = Buffer.from(new Float32Array(doc.embedding).buffer);
      docStmt.run(doc.filePath, doc.chunkIndex, doc.content, doc.startLine, doc.endLine, embeddingBlob);

      // Update file hash (once per file)
      if (!processedFiles.has(doc.filePath)) {
        hashStmt.run(doc.filePath, doc.hash);
        processedFiles.add(doc.filePath);
      }
    }
  });

  transaction(documents);

  // Rebuild vec_documents for affected files
  rebuildVecDocumentsForFiles(documents.map(d => d.filePath));

  // Auto-invalidate affected BM25 indexes
  const hasCode = documents.some(d => d.filePath.startsWith('code:'));
  const hasDocs = documents.some(d => !d.filePath.startsWith('code:'));
  if (hasCode) invalidateCodeBm25Index();
  if (hasDocs) invalidateDocsBm25Index();
}

export function deleteDocumentsByPath(filePath: string): void {
  const database = getDb();

  // Also delete from vec_documents using mapping table
  if (sqliteVecAvailable) {
    try {
      const docIds = database
        .prepare('SELECT id FROM documents WHERE file_path = ?')
        .all(filePath) as Array<{ id: number }>;
      for (const { id } of docIds) {
        const mapping = database.prepare('SELECT vec_rowid FROM vec_documents_map WHERE doc_id = ?').get(id) as { vec_rowid: number } | undefined;
        if (mapping) {
          database.prepare('DELETE FROM vec_documents WHERE rowid = ?').run(mapping.vec_rowid);
          database.prepare('DELETE FROM vec_documents_map WHERE doc_id = ?').run(id);
        }
      }
    } catch {
      // Ignore vec table errors
    }
  }

  database.prepare('DELETE FROM documents WHERE file_path = ?').run(filePath);
  invalidateBm25ForPath(filePath);
}

export function searchDocuments(
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.5
): SearchResult[] {
  const database = getDb();

  // Try sqlite-vec fast path
  if (sqliteVecAvailable) {
    try {
      const candidateLimit = Math.max(limit * 3, 30);
      const queryBuffer = floatArrayToBuffer(queryEmbedding);

      const vecResults = database.prepare(`
        SELECT m.doc_id, v.distance
        FROM vec_documents v
        JOIN vec_documents_map m ON m.vec_rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND k = ?
        ORDER BY v.distance
      `).all(queryBuffer, candidateLimit) as Array<{ doc_id: number; distance: number }>;

      if (vecResults.length > 0) {
        const docIds = vecResults.map(r => r.doc_id);
        const distanceMap = new Map(vecResults.map(r => [r.doc_id, r.distance]));

        const placeholders = docIds.map(() => '?').join(',');
        const rows = database.prepare(`
          SELECT id, file_path, content, start_line, end_line
          FROM documents WHERE id IN (${placeholders})
        `).all(...docIds) as Array<{
          id: number;
          file_path: string;
          content: string;
          start_line: number;
          end_line: number;
        }>;

        const results: SearchResult[] = [];
        for (const row of rows) {
          const distance = distanceMap.get(row.id) ?? 1;
          const similarity = 1 - distance;

          if (similarity >= threshold) {
            results.push({
              file_path: row.file_path,
              content: row.content,
              start_line: row.start_line,
              end_line: row.end_line,
              similarity,
            });
          }
        }

        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, limit);
      }
    } catch {
      // Fall through to brute-force
    }
  }

  // Brute-force fallback
  const rows = database.prepare('SELECT * FROM documents').all() as Array<{
    file_path: string;
    content: string;
    start_line: number;
    end_line: number;
    embedding: Buffer;
  }>;

  const results: SearchResult[] = [];

  for (const row of rows) {
    const embedding = bufferToFloatArray(row.embedding);
    const similarity = cosineSimilarity(queryEmbedding, embedding);

    if (similarity >= threshold) {
      results.push({
        file_path: row.file_path,
        content: row.content,
        start_line: row.start_line,
        end_line: row.end_line,
        similarity,
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

/**
 * Get recent documents (for wildcard search)
 */
export function getRecentDocuments(limit: number = 10): Array<{
  file_path: string;
  content: string;
  start_line: number;
  end_line: number;
}> {
  const database = getDb();
  const rows = database
    .prepare(`
      SELECT file_path, content, start_line, end_line
      FROM documents
      WHERE file_path NOT LIKE 'code:%'
      ORDER BY rowid DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
      file_path: string;
      content: string;
      start_line: number;
      end_line: number;
    }>;

  return rows;
}

export function getStats(): {
  total_documents: number;
  total_files: number;
  last_indexed: string | null;
} {
  const database = getDb();

  const totalDocs = database.prepare('SELECT COUNT(*) as count FROM documents').get() as {
    count: number;
  };
  const totalFiles = database
    .prepare('SELECT COUNT(DISTINCT file_path) as count FROM documents')
    .get() as { count: number };
  const lastIndexed = database
    .prepare('SELECT MAX(updated_at) as last FROM documents')
    .get() as { last: string | null };

  return {
    total_documents: totalDocs.count,
    total_files: totalFiles.count,
    last_indexed: lastIndexed.last,
  };
}

/**
 * Clear all documents from the index.
 * Used for reindexing after embedding model change.
 */
export function clearDocuments(): void {
  const database = getDb();
  database.prepare('DELETE FROM documents').run();
  database.prepare('DELETE FROM file_hashes').run();
  database.prepare("DELETE FROM metadata WHERE key = 'embedding_model'").run();
  invalidateCodeBm25Index();
  invalidateDocsBm25Index();
}

/**
 * Clear only code documents from the index (keeps brain docs).
 * Used for reindexing code after embedding model change.
 */
export function clearCodeDocuments(): void {
  const database = getDb();
  database.prepare("DELETE FROM documents WHERE file_path LIKE 'code:%'").run();
  database.prepare("DELETE FROM file_hashes WHERE file_path LIKE 'code:%'").run();
  invalidateCodeBm25Index();
}

/**
 * Get the embedding dimension of stored documents.
 * Returns null if no documents exist.
 */
export function getStoredEmbeddingDimension(): number | null {
  const database = getDb();
  const row = database.prepare('SELECT embedding FROM documents LIMIT 1').get() as { embedding: Buffer } | undefined;
  if (!row) return null;
  const embedding = bufferToFloatArray(row.embedding);
  return embedding.length;
}
