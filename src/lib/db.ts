import Database from 'better-sqlite3';
import { getDbPath, getGlobalDbPath, getConfig } from './config.js';
import { cosineSimilarity, getModelDimension } from './embeddings.js';

/**
 * Safely convert Buffer to Float32Array, handling byte offset and alignment correctly.
 * Float32Array requires 4-byte alignment, so we copy the buffer to ensure alignment.
 */
function bufferToFloatArray(buffer: Buffer): number[] {
  // Copy buffer to ensure 4-byte alignment for Float32Array
  const aligned = Buffer.from(buffer);
  const floatArray = new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    aligned.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  return Array.from(floatArray);
}

export interface Document {
  id: number;
  file_path: string;
  chunk_index: number;
  content: string;
  start_line: number;
  end_line: number;
  embedding: number[];
  created_at: string;
  updated_at: string;
}

export interface SearchResult {
  file_path: string;
  content: string;
  start_line: number;
  end_line: number;
  similarity: number;
}

let db: Database.Database | null = null;
let globalDb: Database.Database | null = null;

/**
 * Get the local database instance (synchronous, lazy initialization).
 * Safe for Node.js single-threaded model - no async race conditions possible.
 */
export function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath());
    initDb(db);
  }
  return db;
}

/**
 * Get the global database instance (synchronous, lazy initialization).
 */
export function getGlobalDb(): Database.Database {
  if (!globalDb) {
    globalDb = new Database(getGlobalDbPath());
    initGlobalDb(globalDb);
  }
  return globalDb;
}

function initDb(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(file_path, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_documents_file_path ON documents(file_path);

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_hashes (
      file_path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      indexed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      tags TEXT,
      source TEXT,
      embedding BLOB NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
  `);

  // Check if embedding model changed - warn user if reindex needed
  checkModelCompatibility(database);
}

/**
 * Check if the embedding model has changed since last index.
 * If so, warn the user that they need to reindex.
 */
function checkModelCompatibility(database: Database.Database): void {
  const config = getConfig();
  const currentModel = config.embedding_model;

  // Get stored model
  const stored = database
    .prepare('SELECT value FROM metadata WHERE key = ?')
    .get('embedding_model') as { value: string } | undefined;

  if (stored && stored.value !== currentModel) {
    const currentDim = getModelDimension(currentModel);
    const storedDim = getModelDimension(stored.value);

    // Different dimensions = incompatible, must reindex
    if (currentDim && storedDim && currentDim !== storedDim) {
      console.warn(`\n⚠️  Embedding model changed: ${stored.value} → ${currentModel}`);
      console.warn(`   Dimensions: ${storedDim} → ${currentDim} (incompatible)`);
      console.warn(`   Run 'succ index -f' to reindex all documents.\n`);
    } else if (stored.value !== currentModel) {
      // Same dimension but different model - still should reindex for accuracy
      console.warn(`\n⚠️  Embedding model changed: ${stored.value} → ${currentModel}`);
      console.warn(`   Consider running 'succ index -f' to reindex for best results.\n`);
    }
  }

  // Store current model
  database
    .prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
    .run('embedding_model', currentModel);
}

function initGlobalDb(database: Database.Database): void {
  // Global DB only has memories table (shared across projects)
  database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      tags TEXT,
      source TEXT,
      project TEXT,
      embedding BLOB NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_global_memories_created_at ON memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_global_memories_project ON memories(project);
  `);
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
}

export interface DocumentBatch {
  filePath: string;
  chunkIndex: number;
  content: string;
  startLine: number;
  endLine: number;
  embedding: number[];
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
}

export interface DocumentBatchWithHash extends DocumentBatch {
  hash: string;
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
}

export function deleteDocumentsByPath(filePath: string): void {
  const database = getDb();
  database.prepare('DELETE FROM documents WHERE file_path = ?').run(filePath);
}

export function searchDocuments(
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.5
): SearchResult[] {
  const database = getDb();
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

  // Sort by similarity descending
  results.sort((a, b) => b.similarity - a.similarity);

  return results.slice(0, limit);
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

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Get stored hash for a file
 */
export function getFileHash(filePath: string): string | null {
  const database = getDb();
  const row = database
    .prepare('SELECT content_hash FROM file_hashes WHERE file_path = ?')
    .get(filePath) as { content_hash: string } | undefined;
  return row?.content_hash ?? null;
}

/**
 * Store hash for a file
 */
export function setFileHash(filePath: string, hash: string): void {
  const database = getDb();
  database
    .prepare(`
      INSERT INTO file_hashes (file_path, content_hash, indexed_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(file_path) DO UPDATE SET
        content_hash = excluded.content_hash,
        indexed_at = CURRENT_TIMESTAMP
    `)
    .run(filePath, hash);
}

/**
 * Delete hash for a file
 */
export function deleteFileHash(filePath: string): void {
  const database = getDb();
  database.prepare('DELETE FROM file_hashes WHERE file_path = ?').run(filePath);
}

/**
 * Get all stored file hashes
 */
export function getAllFileHashes(): Map<string, string> {
  const database = getDb();
  const rows = database
    .prepare('SELECT file_path, content_hash FROM file_hashes')
    .all() as Array<{ file_path: string; content_hash: string }>;

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.file_path, row.content_hash);
  }
  return map;
}

// ============ Memory functions ============

export interface Memory {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  created_at: string;
}

export interface MemorySearchResult {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  created_at: string;
  similarity: number;
}

/**
 * Save a new memory
 */
export function saveMemory(
  content: string,
  embedding: number[],
  tags: string[] = [],
  source?: string
): number {
  const database = getDb();
  const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
  const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null;

  const result = database
    .prepare(`
      INSERT INTO memories (content, tags, source, embedding)
      VALUES (?, ?, ?, ?)
    `)
    .run(content, tagsJson, source ?? null, embeddingBlob);

  return result.lastInsertRowid as number;
}

/**
 * Search memories by semantic similarity
 */
export function searchMemories(
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.3,
  tags?: string[],
  since?: Date
): MemorySearchResult[] {
  const database = getDb();

  let query = 'SELECT * FROM memories WHERE 1=1';
  const params: any[] = [];

  // Filter by date if specified
  if (since) {
    query += ' AND created_at >= ?';
    params.push(since.toISOString());
  }

  const rows = database.prepare(query).all(...params) as Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    embedding: Buffer;
    created_at: string;
  }>;

  const results: MemorySearchResult[] = [];

  for (const row of rows) {
    // Parse tags
    const rowTags: string[] = row.tags ? JSON.parse(row.tags) : [];

    // Filter by tags if specified
    if (tags && tags.length > 0) {
      const hasMatchingTag = tags.some((t) =>
        rowTags.some((rt) => rt.toLowerCase().includes(t.toLowerCase()))
      );
      if (!hasMatchingTag) continue;
    }

    const embedding = bufferToFloatArray(row.embedding);
    const similarity = cosineSimilarity(queryEmbedding, embedding);

    if (similarity >= threshold) {
      results.push({
        id: row.id,
        content: row.content,
        tags: rowTags,
        source: row.source,
        created_at: row.created_at,
        similarity,
      });
    }
  }

  // Sort by similarity descending
  results.sort((a, b) => b.similarity - a.similarity);

  return results.slice(0, limit);
}

/**
 * Get recent memories
 */
export function getRecentMemories(limit: number = 10): Memory[] {
  const database = getDb();
  const rows = database
    .prepare(`
      SELECT id, content, tags, source, created_at
      FROM memories
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
      id: number;
      content: string;
      tags: string | null;
      source: string | null;
      created_at: string;
    }>;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source: row.source,
    created_at: row.created_at,
  }));
}

/**
 * Delete a memory by ID
 */
export function deleteMemory(id: number): boolean {
  const database = getDb();
  const result = database.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Get memory stats
 */
export function getMemoryStats(): {
  total_memories: number;
  oldest_memory: string | null;
  newest_memory: string | null;
} {
  const database = getDb();

  const total = database.prepare('SELECT COUNT(*) as count FROM memories').get() as {
    count: number;
  };
  const oldest = database
    .prepare('SELECT MIN(created_at) as oldest FROM memories')
    .get() as { oldest: string | null };
  const newest = database
    .prepare('SELECT MAX(created_at) as newest FROM memories')
    .get() as { newest: string | null };

  return {
    total_memories: total.count,
    oldest_memory: oldest.oldest,
    newest_memory: newest.newest,
  };
}

/**
 * Delete memories older than a given date
 */
export function deleteMemoriesOlderThan(date: Date): number {
  const database = getDb();
  const result = database
    .prepare('DELETE FROM memories WHERE created_at < ?')
    .run(date.toISOString());
  return result.changes;
}

/**
 * Delete memories by tag
 */
export function deleteMemoriesByTag(tag: string): number {
  const database = getDb();

  // Get all memories with tags
  const memories = database
    .prepare('SELECT id, tags FROM memories WHERE tags IS NOT NULL')
    .all() as Array<{ id: number; tags: string }>;

  const toDelete: number[] = [];

  for (const memory of memories) {
    try {
      const tags: string[] = JSON.parse(memory.tags);
      if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
        toDelete.push(memory.id);
      }
    } catch {
      // Skip invalid JSON
    }
  }

  if (toDelete.length === 0) return 0;

  const placeholders = toDelete.map(() => '?').join(',');
  const result = database.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...toDelete);

  return result.changes;
}

/**
 * Get memory by ID
 */
export function getMemoryById(id: number): Memory | null {
  const database = getDb();
  const row = database
    .prepare('SELECT id, content, tags, source, created_at FROM memories WHERE id = ?')
    .get(id) as {
      id: number;
      content: string;
      tags: string | null;
      source: string | null;
      created_at: string;
    } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source: row.source,
    created_at: row.created_at,
  };
}

// ============ Global Memory functions ============

export interface GlobalMemory extends Memory {
  project: string | null;
  isGlobal: true;
}

export interface GlobalMemorySearchResult extends MemorySearchResult {
  project: string | null;
  isGlobal: true;
}

/**
 * Save a memory to global database
 */
export function saveGlobalMemory(
  content: string,
  embedding: number[],
  tags: string[] = [],
  source?: string,
  project?: string
): number {
  const database = getGlobalDb();
  const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
  const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null;

  const result = database
    .prepare(`
      INSERT INTO memories (content, tags, source, project, embedding)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(content, tagsJson, source ?? null, project ?? null, embeddingBlob);

  return result.lastInsertRowid as number;
}

/**
 * Search global memories by semantic similarity
 */
export function searchGlobalMemories(
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.3,
  tags?: string[],
  since?: Date
): GlobalMemorySearchResult[] {
  const database = getGlobalDb();

  let query = 'SELECT * FROM memories WHERE 1=1';
  const params: any[] = [];

  if (since) {
    query += ' AND created_at >= ?';
    params.push(since.toISOString());
  }

  const rows = database.prepare(query).all(...params) as Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    project: string | null;
    embedding: Buffer;
    created_at: string;
  }>;

  const results: GlobalMemorySearchResult[] = [];

  for (const row of rows) {
    const rowTags: string[] = row.tags ? JSON.parse(row.tags) : [];

    if (tags && tags.length > 0) {
      const hasMatchingTag = tags.some((t) =>
        rowTags.some((rt) => rt.toLowerCase().includes(t.toLowerCase()))
      );
      if (!hasMatchingTag) continue;
    }

    const embedding = bufferToFloatArray(row.embedding);
    const similarity = cosineSimilarity(queryEmbedding, embedding);

    if (similarity >= threshold) {
      results.push({
        id: row.id,
        content: row.content,
        tags: rowTags,
        source: row.source,
        project: row.project,
        created_at: row.created_at,
        similarity,
        isGlobal: true,
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

/**
 * Get recent global memories
 */
export function getRecentGlobalMemories(limit: number = 10): GlobalMemory[] {
  const database = getGlobalDb();
  const rows = database
    .prepare(`
      SELECT id, content, tags, source, project, created_at
      FROM memories
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
      id: number;
      content: string;
      tags: string | null;
      source: string | null;
      project: string | null;
      created_at: string;
    }>;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source: row.source,
    project: row.project,
    created_at: row.created_at,
    isGlobal: true as const,
  }));
}

/**
 * Delete global memory by ID
 */
export function deleteGlobalMemory(id: number): boolean {
  const database = getGlobalDb();
  const result = database.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Get global memory stats
 */
export function getGlobalMemoryStats(): {
  total_memories: number;
  oldest_memory: string | null;
  newest_memory: string | null;
  projects: string[];
} {
  const database = getGlobalDb();

  const total = database.prepare('SELECT COUNT(*) as count FROM memories').get() as {
    count: number;
  };
  const oldest = database
    .prepare('SELECT MIN(created_at) as oldest FROM memories')
    .get() as { oldest: string | null };
  const newest = database
    .prepare('SELECT MAX(created_at) as newest FROM memories')
    .get() as { newest: string | null };
  const projects = database
    .prepare('SELECT DISTINCT project FROM memories WHERE project IS NOT NULL')
    .all() as Array<{ project: string }>;

  return {
    total_memories: total.count,
    oldest_memory: oldest.oldest,
    newest_memory: newest.newest,
    projects: projects.map((p) => p.project),
  };
}

/**
 * Close global database connection
 */
export function closeGlobalDb(): void {
  if (globalDb) {
    globalDb.close();
    globalDb = null;
  }
}
