import Database from 'better-sqlite3';
import { getDbPath, getGlobalDbPath, getConfig } from './config.js';
import { cosineSimilarity, getModelDimension } from './embeddings.js';

// Lazy import to avoid circular dependency
let scheduleAutoExport: (() => void) | null = null;
async function triggerAutoExport(): Promise<void> {
  if (!scheduleAutoExport) {
    try {
      const module = await import('./graph-export.js');
      scheduleAutoExport = module.scheduleAutoExport;
    } catch {
      // Graph export not available, ignore
      return;
    }
  }
  scheduleAutoExport?.();
}

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
    db.pragma('busy_timeout = 5000'); // 5 second timeout for locked database
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
    globalDb.pragma('busy_timeout = 5000'); // 5 second timeout for locked database
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
      type TEXT DEFAULT 'observation',
      quality_score REAL,
      quality_factors TEXT,
      embedding BLOB NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_quality ON memories(quality_score);

    CREATE TABLE IF NOT EXISTS memory_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      relation TEXT NOT NULL DEFAULT 'related',
      weight REAL DEFAULT 1.0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE,
      UNIQUE(source_id, target_id, relation)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_id);
    CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_id);
  `);

  // Migration: add type column if missing (for existing databases)
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN type TEXT DEFAULT 'observation'`).run();
  } catch {
    // Column already exists, ignore
  }

  // Create index on type after migration
  try {
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`).run();
  } catch {
    // Index may already exist
  }

  // Migration: add quality_score and quality_factors columns
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN quality_score REAL`).run();
  } catch {
    // Column already exists, ignore
  }
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN quality_factors TEXT`).run();
  } catch {
    // Column already exists, ignore
  }
  try {
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_memories_quality ON memories(quality_score)`).run();
  } catch {
    // Index may already exist
  }

  // Check if embedding model changed - warn user if reindex needed
  checkModelCompatibility(database);
}

// Valid memory types
export const MEMORY_TYPES = ['observation', 'decision', 'learning', 'error', 'pattern'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

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
      type TEXT DEFAULT 'observation',
      quality_score REAL,
      quality_factors TEXT,
      embedding BLOB NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_global_memories_created_at ON memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_global_memories_project ON memories(project);
    CREATE INDEX IF NOT EXISTS idx_global_memories_quality ON memories(quality_score);
  `);

  // Migration: add type column if missing
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN type TEXT DEFAULT 'observation'`).run();
  } catch {
    // Column already exists, ignore
  }

  // Create index on type after migration
  try {
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_global_memories_type ON memories(type)`).run();
  } catch {
    // Index may already exist
  }

  // Migration: add quality_score and quality_factors columns
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN quality_score REAL`).run();
  } catch {
    // Column already exists, ignore
  }
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN quality_factors TEXT`).run();
  } catch {
    // Column already exists, ignore
  }
  try {
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_global_memories_quality ON memories(quality_score)`).run();
  } catch {
    // Index may already exist
  }
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
}

/**
 * Clear only code documents from the index (keeps brain docs).
 * Used for reindexing code after embedding model change.
 */
export function clearCodeDocuments(): void {
  const database = getDb();
  database.prepare("DELETE FROM documents WHERE file_path LIKE 'code:%'").run();
  database.prepare("DELETE FROM file_hashes WHERE file_path LIKE 'code:%'").run();
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
  quality_score: number | null;
  quality_factors: Record<string, number> | null;
  created_at: string;
}

export interface MemorySearchResult {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  quality_score: number | null;
  quality_factors: Record<string, number> | null;
  created_at: string;
  similarity: number;
}

/**
 * Check if a similar memory already exists (semantic deduplication)
 * Returns the existing memory ID if found, null otherwise
 */
export function findSimilarMemory(
  embedding: number[],
  threshold: number = 0.92 // High threshold for near-duplicates
): { id: number; content: string; similarity: number } | null {
  const database = getDb();

  const rows = database.prepare('SELECT id, content, embedding FROM memories').all() as Array<{
    id: number;
    content: string;
    embedding: Buffer;
  }>;

  for (const row of rows) {
    const existingEmbedding = bufferToFloatArray(row.embedding);
    const similarity = cosineSimilarity(embedding, existingEmbedding);

    if (similarity >= threshold) {
      return { id: row.id, content: row.content, similarity };
    }
  }

  return null;
}

export interface SaveMemoryResult {
  id: number;
  isDuplicate: boolean;
  similarity?: number;
}

export interface QualityScoreData {
  score: number;
  factors: Record<string, number>;
}

/**
 * Save a new memory with optional deduplication, type, quality score, and auto-linking
 * Returns { id, isDuplicate, similarity?, linksCreated? }
 */
export function saveMemory(
  content: string,
  embedding: number[],
  tags: string[] = [],
  source?: string,
  options: {
    deduplicate?: boolean;
    type?: MemoryType;
    autoLink?: boolean;
    linkThreshold?: number;
    qualityScore?: QualityScoreData;
  } = {}
): SaveMemoryResult & { linksCreated?: number } {
  const { deduplicate = true, type = 'observation', autoLink = true, linkThreshold = 0.7, qualityScore } = options;

  // Check for duplicates if enabled
  if (deduplicate) {
    const existing = findSimilarMemory(embedding);
    if (existing) {
      return { id: existing.id, isDuplicate: true, similarity: existing.similarity };
    }
  }

  const database = getDb();
  const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
  const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null;
  const qualityFactorsJson = qualityScore?.factors ? JSON.stringify(qualityScore.factors) : null;

  const result = database
    .prepare(`
      INSERT INTO memories (content, tags, source, type, quality_score, quality_factors, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      content,
      tagsJson,
      source ?? null,
      type,
      qualityScore?.score ?? null,
      qualityFactorsJson,
      embeddingBlob
    );

  const newId = result.lastInsertRowid as number;
  let linksCreated = 0;

  // Auto-link to similar existing memories
  if (autoLink) {
    linksCreated = autoLinkNewMemory(newId, embedding, linkThreshold);
  }

  // Schedule auto-export if enabled (async, non-blocking)
  if (linksCreated > 0) {
    triggerAutoExport().catch(() => {});
  }

  return { id: newId, isDuplicate: false, linksCreated };
}

/**
 * Auto-link a new memory to existing similar memories
 */
function autoLinkNewMemory(memoryId: number, embedding: number[], threshold: number = 0.7): number {
  const database = getDb();

  // Get all existing memories (excluding the new one)
  const memories = database
    .prepare('SELECT id, embedding FROM memories WHERE id != ?')
    .all(memoryId) as Array<{ id: number; embedding: Buffer }>;

  const similarities: Array<{ id: number; similarity: number }> = [];

  for (const mem of memories) {
    const memEmbedding = bufferToFloatArray(mem.embedding);
    const similarity = cosineSimilarity(embedding, memEmbedding);

    if (similarity >= threshold) {
      similarities.push({ id: mem.id, similarity });
    }
  }

  // Sort and take top 3
  similarities.sort((a, b) => b.similarity - a.similarity);
  const topSimilar = similarities.slice(0, 3);

  let created = 0;
  for (const { id: targetId, similarity } of topSimilar) {
    try {
      const result = createMemoryLink(memoryId, targetId, 'similar_to', similarity);
      if (result.created) created++;
    } catch {
      // Ignore link creation errors
    }
  }

  return created;
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
    quality_score: number | null;
    quality_factors: string | null;
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
        quality_score: row.quality_score,
        quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
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
      SELECT id, content, tags, source, quality_score, quality_factors, created_at
      FROM memories
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
      id: number;
      content: string;
      tags: string | null;
      source: string | null;
      quality_score: number | null;
      quality_factors: string | null;
      created_at: string;
    }>;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source: row.source,
    quality_score: row.quality_score,
    quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
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
 * Get memory stats including type breakdown
 */
export function getMemoryStats(): {
  total_memories: number;
  oldest_memory: string | null;
  newest_memory: string | null;
  by_type: Record<string, number>;
  stale_count: number; // Memories older than 30 days
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

  // Count by type
  const typeCounts = database
    .prepare('SELECT COALESCE(type, ?) as type, COUNT(*) as count FROM memories GROUP BY type')
    .all('observation') as Array<{ type: string; count: number }>;
  const by_type: Record<string, number> = {};
  for (const row of typeCounts) {
    by_type[row.type] = row.count;
  }

  // Count stale memories (older than 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const stale = database
    .prepare('SELECT COUNT(*) as count FROM memories WHERE created_at < ?')
    .get(thirtyDaysAgo) as { count: number };

  return {
    total_memories: total.count,
    oldest_memory: oldest.oldest,
    newest_memory: newest.newest,
    by_type,
    stale_count: stale.count,
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
    .prepare('SELECT id, content, tags, source, quality_score, quality_factors, created_at FROM memories WHERE id = ?')
    .get(id) as {
      id: number;
      content: string;
      tags: string | null;
      source: string | null;
      quality_score: number | null;
      quality_factors: string | null;
      created_at: string;
    } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source: row.source,
    quality_score: row.quality_score,
    quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
    created_at: row.created_at,
  };
}

// ============ Global Memory functions ============

export interface GlobalMemory {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  project: string | null;
  quality_score: number | null;
  quality_factors: Record<string, number> | null;
  created_at: string;
  isGlobal: true;
}

export interface GlobalMemorySearchResult {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  project: string | null;
  quality_score: number | null;
  quality_factors: Record<string, number> | null;
  created_at: string;
  similarity: number;
  isGlobal: true;
}

/**
 * Check if a similar global memory already exists
 */
export function findSimilarGlobalMemory(
  embedding: number[],
  threshold: number = 0.92
): { id: number; content: string; similarity: number } | null {
  const database = getGlobalDb();

  const rows = database.prepare('SELECT id, content, embedding FROM memories').all() as Array<{
    id: number;
    content: string;
    embedding: Buffer;
  }>;

  for (const row of rows) {
    const existingEmbedding = bufferToFloatArray(row.embedding);
    const similarity = cosineSimilarity(embedding, existingEmbedding);

    if (similarity >= threshold) {
      return { id: row.id, content: row.content, similarity };
    }
  }

  return null;
}

/**
 * Save a memory to global database with deduplication and type
 */
export function saveGlobalMemory(
  content: string,
  embedding: number[],
  tags: string[] = [],
  source?: string,
  project?: string,
  options: { deduplicate?: boolean; type?: MemoryType } = {}
): SaveMemoryResult {
  const { deduplicate = true, type = 'observation' } = options;

  // Check for duplicates if enabled
  if (deduplicate) {
    const existing = findSimilarGlobalMemory(embedding);
    if (existing) {
      return { id: existing.id, isDuplicate: true, similarity: existing.similarity };
    }
  }

  const database = getGlobalDb();
  const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
  const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null;

  const result = database
    .prepare(`
      INSERT INTO memories (content, tags, source, project, type, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(content, tagsJson, source ?? null, project ?? null, type, embeddingBlob);

  return { id: result.lastInsertRowid as number, isDuplicate: false };
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
    quality_score: number | null;
    quality_factors: string | null;
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
        quality_score: row.quality_score,
        quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
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
      SELECT id, content, tags, source, project, quality_score, quality_factors, created_at
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
      quality_score: number | null;
      quality_factors: string | null;
      created_at: string;
    }>;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source: row.source,
    project: row.project,
    quality_score: row.quality_score,
    quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
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

// ============ Memory Links (Knowledge Graph) ============

export const LINK_RELATIONS = [
  'related',      // Generic relation
  'caused_by',    // A was caused by B
  'leads_to',     // A leads to B
  'similar_to',   // A is similar to B
  'contradicts',  // A contradicts B
  'implements',   // A implements B (decision → code)
  'supersedes',   // A supersedes/replaces B
  'references',   // A references B
] as const;

export type LinkRelation = (typeof LINK_RELATIONS)[number];

export interface MemoryLink {
  id: number;
  source_id: number;
  target_id: number;
  relation: LinkRelation;
  weight: number;
  created_at: string;
}

export interface MemoryWithLinks extends Memory {
  outgoing_links: Array<{ target_id: number; relation: LinkRelation; weight: number }>;
  incoming_links: Array<{ source_id: number; relation: LinkRelation; weight: number }>;
}

/**
 * Create a link between two memories
 */
export function createMemoryLink(
  sourceId: number,
  targetId: number,
  relation: LinkRelation = 'related',
  weight: number = 1.0
): { id: number; created: boolean } {
  const database = getDb();

  try {
    const result = database
      .prepare(`
        INSERT INTO memory_links (source_id, target_id, relation, weight)
        VALUES (?, ?, ?, ?)
      `)
      .run(sourceId, targetId, relation, weight);

    // Schedule auto-export if enabled (async, non-blocking)
    triggerAutoExport().catch(() => {});

    return { id: result.lastInsertRowid as number, created: true };
  } catch (error: any) {
    // Link already exists (UNIQUE constraint)
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existing = database
        .prepare('SELECT id FROM memory_links WHERE source_id = ? AND target_id = ? AND relation = ?')
        .get(sourceId, targetId, relation) as { id: number };
      return { id: existing.id, created: false };
    }
    throw error;
  }
}

/**
 * Delete a link between memories
 */
export function deleteMemoryLink(sourceId: number, targetId: number, relation?: LinkRelation): boolean {
  const database = getDb();

  if (relation) {
    const result = database
      .prepare('DELETE FROM memory_links WHERE source_id = ? AND target_id = ? AND relation = ?')
      .run(sourceId, targetId, relation);
    return result.changes > 0;
  } else {
    const result = database
      .prepare('DELETE FROM memory_links WHERE source_id = ? AND target_id = ?')
      .run(sourceId, targetId);
    return result.changes > 0;
  }
}

/**
 * Get all links for a memory (both directions)
 */
export function getMemoryLinks(memoryId: number): {
  outgoing: MemoryLink[];
  incoming: MemoryLink[];
} {
  const database = getDb();

  const outgoing = database
    .prepare('SELECT * FROM memory_links WHERE source_id = ?')
    .all(memoryId) as MemoryLink[];

  const incoming = database
    .prepare('SELECT * FROM memory_links WHERE target_id = ?')
    .all(memoryId) as MemoryLink[];

  return { outgoing, incoming };
}

/**
 * Get memory with its links
 */
export function getMemoryWithLinks(memoryId: number): MemoryWithLinks | null {
  const memory = getMemoryById(memoryId);
  if (!memory) return null;

  const links = getMemoryLinks(memoryId);

  return {
    ...memory,
    outgoing_links: links.outgoing.map(l => ({
      target_id: l.target_id,
      relation: l.relation as LinkRelation,
      weight: l.weight,
    })),
    incoming_links: links.incoming.map(l => ({
      source_id: l.source_id,
      relation: l.relation as LinkRelation,
      weight: l.weight,
    })),
  };
}

/**
 * Find related memories through links (graph traversal)
 * Returns memories connected within N hops
 */
export function findConnectedMemories(
  memoryId: number,
  maxDepth: number = 2
): Array<{ memory: Memory; depth: number; path: number[] }> {
  const database = getDb();
  const visited = new Set<number>([memoryId]);
  const results: Array<{ memory: Memory; depth: number; path: number[] }> = [];

  // BFS traversal
  let currentLevel = [{ id: memoryId, path: [memoryId] }];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextLevel: Array<{ id: number; path: number[] }> = [];

    for (const { id, path } of currentLevel) {
      // Get outgoing links
      const outgoing = database
        .prepare('SELECT target_id FROM memory_links WHERE source_id = ?')
        .all(id) as Array<{ target_id: number }>;

      // Get incoming links
      const incoming = database
        .prepare('SELECT source_id FROM memory_links WHERE target_id = ?')
        .all(id) as Array<{ source_id: number }>;

      const neighbors = [
        ...outgoing.map(r => r.target_id),
        ...incoming.map(r => r.source_id),
      ];

      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          const memory = getMemoryById(neighborId);
          if (memory) {
            const newPath = [...path, neighborId];
            results.push({ memory, depth, path: newPath });
            nextLevel.push({ id: neighborId, path: newPath });
          }
        }
      }
    }

    currentLevel = nextLevel;
  }

  return results;
}

/**
 * Auto-link similar memories based on embedding similarity
 * Useful for building initial graph structure
 */
export function autoLinkSimilarMemories(
  threshold: number = 0.75,
  maxLinks: number = 3
): number {
  const database = getDb();

  const memories = database
    .prepare('SELECT id, embedding FROM memories')
    .all() as Array<{ id: number; embedding: Buffer }>;

  let linksCreated = 0;

  for (let i = 0; i < memories.length; i++) {
    const source = memories[i];
    const sourceEmbedding = bufferToFloatArray(source.embedding);

    const similarities: Array<{ id: number; similarity: number }> = [];

    for (let j = 0; j < memories.length; j++) {
      if (i === j) continue;

      const target = memories[j];
      const targetEmbedding = bufferToFloatArray(target.embedding);
      const similarity = cosineSimilarity(sourceEmbedding, targetEmbedding);

      if (similarity >= threshold) {
        similarities.push({ id: target.id, similarity });
      }
    }

    // Sort by similarity and take top N
    similarities.sort((a, b) => b.similarity - a.similarity);
    const topSimilar = similarities.slice(0, maxLinks);

    for (const { id: targetId, similarity } of topSimilar) {
      const result = createMemoryLink(source.id, targetId, 'similar_to', similarity);
      if (result.created) {
        linksCreated++;
      }
    }
  }

  return linksCreated;
}

/**
 * Get graph statistics
 */
export function getGraphStats(): {
  total_memories: number;
  total_links: number;
  avg_links_per_memory: number;
  isolated_memories: number;
  relations: Record<string, number>;
} {
  const database = getDb();

  const totalMemories = (database
    .prepare('SELECT COUNT(*) as count FROM memories')
    .get() as { count: number }).count;

  const totalLinks = (database
    .prepare('SELECT COUNT(*) as count FROM memory_links')
    .get() as { count: number }).count;

  // Count memories with no links
  const isolatedCount = (database
    .prepare(`
      SELECT COUNT(*) as count FROM memories m
      WHERE NOT EXISTS (SELECT 1 FROM memory_links WHERE source_id = m.id OR target_id = m.id)
    `)
    .get() as { count: number }).count;

  // Count by relation type
  const relationCounts = database
    .prepare('SELECT relation, COUNT(*) as count FROM memory_links GROUP BY relation')
    .all() as Array<{ relation: string; count: number }>;

  const relations: Record<string, number> = {};
  for (const row of relationCounts) {
    relations[row.relation] = row.count;
  }

  return {
    total_memories: totalMemories,
    total_links: totalLinks,
    avg_links_per_memory: totalMemories > 0 ? totalLinks / totalMemories : 0,
    isolated_memories: isolatedCount,
    relations,
  };
}
