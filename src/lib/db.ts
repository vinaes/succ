import Database from 'better-sqlite3';
import { getDbPath, getGlobalDbPath, getConfig } from './config.js';
import { cosineSimilarity, getModelDimension } from './embeddings.js';
import * as bm25 from './bm25.js';

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
    // WAL mode for better concurrent access from multiple MCP processes
    globalDb.pragma('journal_mode = WAL');
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

    CREATE TABLE IF NOT EXISTS token_frequencies (
      token TEXT PRIMARY KEY,
      frequency INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_token_freq ON token_frequencies(frequency DESC);

    CREATE TABLE IF NOT EXISTS token_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      query TEXT,
      returned_tokens INTEGER NOT NULL DEFAULT 0,
      full_source_tokens INTEGER NOT NULL DEFAULT 0,
      savings_tokens INTEGER NOT NULL DEFAULT 0,
      files_count INTEGER,
      chunks_count INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_token_stats_type ON token_stats(event_type);
    CREATE INDEX IF NOT EXISTS idx_token_stats_created ON token_stats(created_at);
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

  // Migration: add access_count and last_accessed columns for retention decay
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN access_count REAL DEFAULT 0`).run();
  } catch {
    // Column already exists, ignore
  }
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN last_accessed TEXT`).run();
  } catch {
    // Column already exists, ignore
  }

  // Migration: add valid_from and valid_until columns for temporal awareness
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN valid_from TEXT`).run();
  } catch {
    // Column already exists, ignore
  }
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN valid_until TEXT`).run();
  } catch {
    // Column already exists, ignore
  }

  // Migration: add temporal fields to memory_links
  try {
    database.prepare(`ALTER TABLE memory_links ADD COLUMN valid_from TEXT`).run();
  } catch {
    // Column already exists, ignore
  }
  try {
    database.prepare(`ALTER TABLE memory_links ADD COLUMN valid_until TEXT`).run();
  } catch {
    // Column already exists, ignore
  }

  // Migration: add model and estimated_cost columns to token_stats
  try {
    database.prepare(`ALTER TABLE token_stats ADD COLUMN model TEXT`).run();
  } catch {
    // Column already exists, ignore
  }
  try {
    database.prepare(`ALTER TABLE token_stats ADD COLUMN estimated_cost REAL DEFAULT 0`).run();
  } catch {
    // Column already exists, ignore
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

  // Migration: add access_count and last_accessed columns for retention decay
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN access_count REAL DEFAULT 0`).run();
  } catch {
    // Column already exists, ignore
  }
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN last_accessed TEXT`).run();
  } catch {
    // Column already exists, ignore
  }

  // Migration: add valid_from and valid_until columns for temporal awareness
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN valid_from TEXT`).run();
  } catch {
    // Column already exists, ignore
  }
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN valid_until TEXT`).run();
  } catch {
    // Column already exists, ignore
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

// ============================================================================
// BM25 Index Management
// ============================================================================

let codeBm25Index: bm25.BM25Index | null = null;

/**
 * Get or build BM25 index for code search
 */
function getCodeBm25Index(): bm25.BM25Index {
  if (codeBm25Index) return codeBm25Index;

  const database = getDb();

  // Try to load from metadata
  const stored = database.prepare("SELECT value FROM metadata WHERE key = 'bm25_code_index'").get() as
    | { value: string }
    | undefined;

  if (stored) {
    try {
      codeBm25Index = bm25.deserializeIndex(stored.value);
      return codeBm25Index;
    } catch {
      // Invalid stored index, rebuild
    }
  }

  // Build from documents
  const rows = database.prepare("SELECT id, content FROM documents WHERE file_path LIKE 'code:%'").all() as Array<{
    id: number;
    content: string;
  }>;

  codeBm25Index = bm25.buildIndex(rows, 'code');

  // Store for future use
  saveCodeBm25Index();

  return codeBm25Index;
}

/**
 * Save BM25 index to metadata
 */
function saveCodeBm25Index(): void {
  if (!codeBm25Index) return;
  const database = getDb();
  const serialized = bm25.serializeIndex(codeBm25Index);
  database.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('bm25_code_index', ?)").run(serialized);
}

/**
 * Invalidate BM25 index (call when documents change)
 */
export function invalidateCodeBm25Index(): void {
  codeBm25Index = null;
  const database = getDb();
  database.prepare("DELETE FROM metadata WHERE key = 'bm25_code_index'").run();
}

/**
 * Update BM25 index when a document is added/updated
 */
export function updateCodeBm25Index(docId: number, content: string): void {
  const index = getCodeBm25Index();
  // Remove old entry if exists
  bm25.removeFromIndex(index, docId);
  // Add new entry
  bm25.addToIndex(index, { id: docId, content }, 'code');
  saveCodeBm25Index();
}

// ============================================================================
// Hybrid Search (BM25 + Vector)
// ============================================================================

export interface HybridSearchResult extends SearchResult {
  bm25Score?: number;
  vectorScore?: number;
}

/**
 * Hybrid search combining BM25 and vector similarity
 *
 * @param query - Search query string
 * @param queryEmbedding - Query embedding vector
 * @param limit - Max results
 * @param threshold - Min similarity threshold
 * @param alpha - Weight: 0=pure BM25, 1=pure vector, 0.5=equal (default: 0.5)
 */
export function hybridSearchCode(
  query: string,
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.25,
  alpha: number = 0.5
): HybridSearchResult[] {
  const database = getDb();

  // Get all code documents
  const rows = database.prepare("SELECT id, file_path, content, start_line, end_line, embedding FROM documents WHERE file_path LIKE 'code:%'").all() as Array<{
    id: number;
    file_path: string;
    content: string;
    start_line: number;
    end_line: number;
    embedding: Buffer;
  }>;

  if (rows.length === 0) return [];

  // 1. BM25 search with Ronin-style segmentation for flatcase queries
  const bm25Index = getCodeBm25Index();

  // Enhance query with segmented tokens if it looks like flatcase
  let enhancedQuery = query;
  const totalTokens = getTotalTokenCount();
  if (totalTokens > 0) {
    const tokens = bm25.tokenizeCodeWithSegmentation(
      query,
      (token) => getTokenFrequency(token),
      totalTokens
    );
    // If segmentation produced more tokens, use them
    if (tokens.length > query.split(/\s+/).length) {
      enhancedQuery = tokens.join(' ');
    }
  }

  const bm25Results = bm25.search(enhancedQuery, bm25Index, 'code', limit * 3);

  // 2. Vector search
  const vectorResults: { docId: number; score: number }[] = [];
  for (const row of rows) {
    const embedding = bufferToFloatArray(row.embedding);
    const similarity = cosineSimilarity(queryEmbedding, embedding);
    if (similarity >= threshold) {
      vectorResults.push({ docId: row.id, score: similarity });
    }
  }
  vectorResults.sort((a, b) => b.score - a.score);
  const topVectorResults = vectorResults.slice(0, limit * 3);

  // 3. Combine using RRF
  const combined = bm25.reciprocalRankFusion(bm25Results, topVectorResults, alpha, limit);

  // 4. Map back to full results
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const bm25Map = new Map(bm25Results.map((r) => [r.docId, r.score]));
  const vectorMap = new Map(vectorResults.map((r) => [r.docId, r.score]));

  const results: HybridSearchResult[] = [];
  for (const c of combined) {
    const row = rowMap.get(c.docId);
    if (!row) continue;
    results.push({
      file_path: row.file_path,
      content: row.content,
      start_line: row.start_line,
      end_line: row.end_line,
      similarity: c.score,
      bm25Score: bm25Map.get(c.docId),
      vectorScore: vectorMap.get(c.docId),
    });
  }
  return results;
}

// ============================================================================
// BM25 Index for Docs (brain/ markdown files)
// ============================================================================

let docsBm25Index: bm25.BM25Index | null = null;

/**
 * Get or build BM25 index for docs search (brain/ files)
 */
function getDocsBm25Index(): bm25.BM25Index {
  if (docsBm25Index) return docsBm25Index;

  const database = getDb();

  // Try to load from metadata
  const stored = database.prepare("SELECT value FROM metadata WHERE key = 'bm25_docs_index'").get() as
    | { value: string }
    | undefined;

  if (stored) {
    try {
      docsBm25Index = bm25.deserializeIndex(stored.value);
      return docsBm25Index;
    } catch {
      // Invalid stored index, rebuild
    }
  }

  // Build from documents (exclude code: prefix)
  const rows = database.prepare("SELECT id, content FROM documents WHERE file_path NOT LIKE 'code:%'").all() as Array<{
    id: number;
    content: string;
  }>;

  docsBm25Index = bm25.buildIndex(rows, 'docs');

  // Store for future use
  saveDocsBm25Index();

  return docsBm25Index;
}

/**
 * Save docs BM25 index to metadata
 */
function saveDocsBm25Index(): void {
  if (!docsBm25Index) return;
  const database = getDb();
  const serialized = bm25.serializeIndex(docsBm25Index);
  database.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('bm25_docs_index', ?)").run(serialized);
}

/**
 * Invalidate docs BM25 index
 */
export function invalidateDocsBm25Index(): void {
  docsBm25Index = null;
  const database = getDb();
  database.prepare("DELETE FROM metadata WHERE key = 'bm25_docs_index'").run();
}

/**
 * Hybrid search for docs (brain/ markdown files)
 */
export function hybridSearchDocs(
  query: string,
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.2,
  alpha: number = 0.5
): HybridSearchResult[] {
  const database = getDb();

  // Get all docs (exclude code: prefix)
  const rows = database.prepare("SELECT id, file_path, content, start_line, end_line, embedding FROM documents WHERE file_path NOT LIKE 'code:%'").all() as Array<{
    id: number;
    file_path: string;
    content: string;
    start_line: number;
    end_line: number;
    embedding: Buffer;
  }>;

  if (rows.length === 0) return [];

  // 1. BM25 search with docs tokenizer (stemming)
  const bm25Index = getDocsBm25Index();
  const bm25Results = bm25.search(query, bm25Index, 'docs', limit * 3);

  // 2. Vector search
  const vectorResults: { docId: number; score: number }[] = [];
  for (const row of rows) {
    const embedding = bufferToFloatArray(row.embedding);
    const similarity = cosineSimilarity(queryEmbedding, embedding);
    if (similarity >= threshold) {
      vectorResults.push({ docId: row.id, score: similarity });
    }
  }
  vectorResults.sort((a, b) => b.score - a.score);
  const topVectorResults = vectorResults.slice(0, limit * 3);

  // 3. Combine using RRF
  const combined = bm25.reciprocalRankFusion(bm25Results, topVectorResults, alpha, limit);

  // 4. Map back to full results
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const bm25Map = new Map(bm25Results.map((r) => [r.docId, r.score]));
  const vectorMap = new Map(vectorResults.map((r) => [r.docId, r.score]));

  const results: HybridSearchResult[] = [];
  for (const c of combined) {
    const row = rowMap.get(c.docId);
    if (!row) continue;
    results.push({
      file_path: row.file_path,
      content: row.content,
      start_line: row.start_line,
      end_line: row.end_line,
      similarity: c.score,
      bm25Score: bm25Map.get(c.docId),
      vectorScore: vectorMap.get(c.docId),
    });
  }
  return results;
}

// ============================================================================
// BM25 Index for Memories
// ============================================================================

let memoriesBm25Index: bm25.BM25Index | null = null;

/**
 * Get or build BM25 index for memories
 */
function getMemoriesBm25Index(): bm25.BM25Index {
  if (memoriesBm25Index) return memoriesBm25Index;

  const database = getDb();

  // Try to load from metadata
  const stored = database.prepare("SELECT value FROM metadata WHERE key = 'bm25_memories_index'").get() as
    | { value: string }
    | undefined;

  if (stored) {
    try {
      memoriesBm25Index = bm25.deserializeIndex(stored.value);
      return memoriesBm25Index;
    } catch {
      // Invalid stored index, rebuild
    }
  }

  // Build from memories
  const rows = database.prepare('SELECT id, content FROM memories').all() as Array<{
    id: number;
    content: string;
  }>;

  memoriesBm25Index = bm25.buildIndex(rows, 'docs'); // Use docs tokenizer with stemming

  // Store for future use
  saveMemoriesBm25Index();

  return memoriesBm25Index;
}

/**
 * Save memories BM25 index to metadata
 */
function saveMemoriesBm25Index(): void {
  if (!memoriesBm25Index) return;
  const database = getDb();
  const serialized = bm25.serializeIndex(memoriesBm25Index);
  database.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('bm25_memories_index', ?)").run(serialized);
}

/**
 * Invalidate memories BM25 index
 */
export function invalidateMemoriesBm25Index(): void {
  memoriesBm25Index = null;
  const database = getDb();
  database.prepare("DELETE FROM metadata WHERE key = 'bm25_memories_index'").run();
}

/**
 * Update memories BM25 index when a memory is added
 */
export function updateMemoriesBm25Index(memoryId: number, content: string): void {
  const index = getMemoriesBm25Index();
  bm25.removeFromIndex(index, memoryId);
  bm25.addToIndex(index, { id: memoryId, content }, 'docs');
  saveMemoriesBm25Index();
}

export interface HybridMemoryResult {
  id: number;
  content: string;
  tags: string | null;
  source: string | null;
  type: string | null;
  created_at: string;
  similarity: number;
  bm25Score?: number;
  vectorScore?: number;
  // Temporal fields
  last_accessed?: string | null;
  access_count?: number;
  valid_from?: string | null;
  valid_until?: string | null;
}

/**
 * Hybrid search for memories
 */
export function hybridSearchMemories(
  query: string,
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.3,
  alpha: number = 0.5
): HybridMemoryResult[] {
  const database = getDb();

  const rows = database.prepare(`
    SELECT id, content, tags, source, type, created_at, embedding,
           last_accessed, access_count, valid_from, valid_until
    FROM memories WHERE embedding IS NOT NULL
  `).all() as Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    type: string | null;
    created_at: string;
    embedding: Buffer;
    last_accessed: string | null;
    access_count: number;
    valid_from: string | null;
    valid_until: string | null;
  }>;

  if (rows.length === 0) return [];

  // 1. BM25 search
  const bm25Index = getMemoriesBm25Index();
  const bm25Results = bm25.search(query, bm25Index, 'docs', limit * 3);

  // 2. Vector search
  const vectorResults: { docId: number; score: number }[] = [];
  for (const row of rows) {
    const embedding = bufferToFloatArray(row.embedding);
    const similarity = cosineSimilarity(queryEmbedding, embedding);
    if (similarity >= threshold) {
      vectorResults.push({ docId: row.id, score: similarity });
    }
  }
  vectorResults.sort((a, b) => b.score - a.score);
  const topVectorResults = vectorResults.slice(0, limit * 3);

  // 3. Combine using RRF
  const combined = bm25.reciprocalRankFusion(bm25Results, topVectorResults, alpha, limit);

  // 4. Map back to full results
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const bm25Map = new Map(bm25Results.map((r) => [r.docId, r.score]));
  const vectorMap = new Map(vectorResults.map((r) => [r.docId, r.score]));

  const results: HybridMemoryResult[] = [];
  for (const c of combined) {
    const row = rowMap.get(c.docId);
    if (!row) continue;
    results.push({
      id: row.id,
      content: row.content,
      tags: row.tags,
      source: row.source,
      type: row.type,
      created_at: row.created_at,
      similarity: c.score,
      bm25Score: bm25Map.get(c.docId),
      vectorScore: vectorMap.get(c.docId),
      last_accessed: row.last_accessed,
      access_count: row.access_count,
      valid_from: row.valid_from,
      valid_until: row.valid_until,
    });
  }
  return results;
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
  access_count: number;
  last_accessed: string | null;
  // Temporal validity
  valid_from: string | null;  // When fact became valid (null = always valid)
  valid_until: string | null; // When fact expires (null = never expires)
  created_at: string;
}

export interface MemorySearchResult {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  quality_score: number | null;
  quality_factors: Record<string, number> | null;
  access_count: number;
  last_accessed: string | null;
  valid_from: string | null;
  valid_until: string | null;
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
 * Save a new memory with optional deduplication, type, quality score, auto-linking, and validity period
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
    // Temporal validity
    validFrom?: string | Date;
    validUntil?: string | Date;
  } = {}
): SaveMemoryResult & { linksCreated?: number } {
  const { deduplicate = true, type = 'observation', autoLink = true, linkThreshold = 0.7, qualityScore, validFrom, validUntil } = options;

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

  // Convert Date objects to ISO strings
  const validFromStr = validFrom ? (validFrom instanceof Date ? validFrom.toISOString() : validFrom) : null;
  const validUntilStr = validUntil ? (validUntil instanceof Date ? validUntil.toISOString() : validUntil) : null;

  const result = database
    .prepare(`
      INSERT INTO memories (content, tags, source, type, quality_score, quality_factors, valid_from, valid_until, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      content,
      tagsJson,
      source ?? null,
      type,
      qualityScore?.score ?? null,
      qualityFactorsJson,
      validFromStr,
      validUntilStr,
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
 * Search memories by semantic similarity with temporal awareness
 */
export function searchMemories(
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.3,
  tags?: string[],
  since?: Date,
  options?: {
    includeExpired?: boolean;  // Include expired memories (default: false)
    asOfDate?: Date;  // Point-in-time query (default: now)
  }
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
    access_count: number | null;
    last_accessed: string | null;
    valid_from: string | null;
    valid_until: string | null;
    embedding: Buffer;
    created_at: string;
  }>;

  const results: MemorySearchResult[] = [];
  const now = options?.asOfDate?.getTime() ?? Date.now();
  const includeExpired = options?.includeExpired ?? false;

  for (const row of rows) {
    // Check validity period
    if (!includeExpired) {
      if (row.valid_from) {
        const validFrom = new Date(row.valid_from).getTime();
        if (now < validFrom) continue; // Not yet valid
      }
      if (row.valid_until) {
        const validUntil = new Date(row.valid_until).getTime();
        if (now > validUntil) continue; // Expired
      }
    }

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
        access_count: row.access_count ?? 0,
        last_accessed: row.last_accessed,
        valid_from: row.valid_from,
        valid_until: row.valid_until,
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
      SELECT id, content, tags, source, quality_score, quality_factors, access_count, last_accessed, valid_from, valid_until, created_at
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
      access_count: number | null;
      last_accessed: string | null;
      valid_from: string | null;
      valid_until: string | null;
      created_at: string;
    }>;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source: row.source,
    quality_score: row.quality_score,
    quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
    access_count: row.access_count ?? 0,
    last_accessed: row.last_accessed,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
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
    .prepare('SELECT id, content, tags, source, quality_score, quality_factors, access_count, last_accessed, valid_from, valid_until, created_at FROM memories WHERE id = ?')
    .get(id) as {
      id: number;
      content: string;
      tags: string | null;
      source: string | null;
      quality_score: number | null;
      quality_factors: string | null;
      access_count: number | null;
      last_accessed: string | null;
      valid_from: string | null;
      valid_until: string | null;
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
    access_count: row.access_count ?? 0,
    last_accessed: row.last_accessed,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
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

  const memoryId = result.lastInsertRowid as number;

  // Update BM25 index
  updateGlobalMemoriesBm25Index(memoryId, content);

  return { id: memoryId, isDuplicate: false };
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

// ============================================================================
// BM25 Index for Global Memories
// ============================================================================

let globalMemoriesBm25Index: bm25.BM25Index | null = null;

/**
 * Get or build BM25 index for global memories
 */
function getGlobalMemoriesBm25Index(): bm25.BM25Index {
  if (globalMemoriesBm25Index) return globalMemoriesBm25Index;

  const database = getGlobalDb();

  // Try to load from metadata
  const stored = database.prepare("SELECT value FROM metadata WHERE key = 'bm25_memories_index'").get() as
    | { value: string }
    | undefined;

  if (stored) {
    try {
      globalMemoriesBm25Index = bm25.deserializeIndex(stored.value);
      return globalMemoriesBm25Index;
    } catch {
      // Invalid stored index, rebuild
    }
  }

  // Build from memories
  const rows = database.prepare('SELECT id, content FROM memories').all() as Array<{
    id: number;
    content: string;
  }>;

  globalMemoriesBm25Index = bm25.buildIndex(rows, 'docs'); // Use docs tokenizer with stemming

  // Store for future use
  saveGlobalMemoriesBm25Index();

  return globalMemoriesBm25Index;
}

/**
 * Save global memories BM25 index to metadata
 */
function saveGlobalMemoriesBm25Index(): void {
  if (!globalMemoriesBm25Index) return;
  const database = getGlobalDb();
  database.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('bm25_memories_index', ?)").run(
    bm25.serializeIndex(globalMemoriesBm25Index)
  );
}

/**
 * Invalidate global memories BM25 index
 */
export function invalidateGlobalMemoriesBm25Index(): void {
  globalMemoriesBm25Index = null;
  try {
    const database = getGlobalDb();
    database.prepare("DELETE FROM metadata WHERE key = 'bm25_memories_index'").run();
  } catch {
    // DB not initialized yet
  }
}

/**
 * Update global memories BM25 index when a memory is added
 */
export function updateGlobalMemoriesBm25Index(memoryId: number, content: string): void {
  const index = getGlobalMemoriesBm25Index();
  bm25.removeFromIndex(index, memoryId);
  bm25.addToIndex(index, { id: memoryId, content }, 'docs');
  saveGlobalMemoriesBm25Index();
}

export interface HybridGlobalMemoryResult {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  project: string | null;
  created_at: string;
  similarity: number;
  bm25Score?: number;
  vectorScore?: number;
  isGlobal: true;
}

/**
 * Hybrid search for global memories (BM25 + vector with RRF fusion)
 */
export function hybridSearchGlobalMemories(
  query: string,
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.3,
  alpha: number = 0.5,
  tags?: string[],
  since?: Date
): HybridGlobalMemoryResult[] {
  const database = getGlobalDb();

  let sqlQuery = 'SELECT id, content, tags, source, project, embedding, created_at FROM memories WHERE embedding IS NOT NULL';
  const params: any[] = [];

  if (since) {
    sqlQuery += ' AND created_at >= ?';
    params.push(since.toISOString());
  }

  const rows = database.prepare(sqlQuery).all(...params) as Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    project: string | null;
    embedding: Buffer;
    created_at: string;
  }>;

  if (rows.length === 0) return [];

  // 1. BM25 search
  const bm25Index = getGlobalMemoriesBm25Index();
  const bm25Results = bm25.search(query, bm25Index, 'docs', limit * 3);

  // 2. Vector search
  const vectorResults: { docId: number; score: number }[] = [];
  for (const row of rows) {
    const embedding = bufferToFloatArray(row.embedding);
    const similarity = cosineSimilarity(queryEmbedding, embedding);
    if (similarity >= threshold) {
      vectorResults.push({ docId: row.id, score: similarity });
    }
  }
  vectorResults.sort((a, b) => b.score - a.score);
  const topVectorResults = vectorResults.slice(0, limit * 3);

  // 3. Combine using RRF
  const combined = bm25.reciprocalRankFusion(bm25Results, topVectorResults, alpha, limit);

  // 4. Map back to full results
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const bm25Map = new Map(bm25Results.map((r) => [r.docId, r.score]));
  const vectorMap = new Map(vectorResults.map((r) => [r.docId, r.score]));

  const results: HybridGlobalMemoryResult[] = [];
  for (const c of combined) {
    const row = rowMap.get(c.docId);
    if (!row) continue;

    // Parse and filter by tags if specified
    const rowTags: string[] = row.tags ? JSON.parse(row.tags) : [];
    if (tags && tags.length > 0) {
      const hasMatchingTag = tags.some((t) =>
        rowTags.some((rt) => rt.toLowerCase().includes(t.toLowerCase()))
      );
      if (!hasMatchingTag) continue;
    }

    results.push({
      id: row.id,
      content: row.content,
      tags: rowTags,
      source: row.source,
      project: row.project,
      created_at: row.created_at,
      similarity: c.score,
      bm25Score: bm25Map.get(c.docId),
      vectorScore: vectorMap.get(c.docId),
      isGlobal: true,
    });
  }

  return results;
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
  // Temporal validity
  valid_from: string | null;  // When relationship became valid
  valid_until: string | null; // When relationship expired/was invalidated
  created_at: string;
}

export interface MemoryWithLinks extends Memory {
  outgoing_links: Array<{ target_id: number; relation: LinkRelation; weight: number; valid_from: string | null; valid_until: string | null }>;
  incoming_links: Array<{ source_id: number; relation: LinkRelation; weight: number; valid_from: string | null; valid_until: string | null }>;
}

/**
 * Create a link between two memories with optional temporal validity
 */
export function createMemoryLink(
  sourceId: number,
  targetId: number,
  relation: LinkRelation = 'related',
  weight: number = 1.0,
  options?: {
    validFrom?: string | Date;
    validUntil?: string | Date;
  }
): { id: number; created: boolean } {
  const database = getDb();

  // Convert Date objects to ISO strings
  const validFromStr = options?.validFrom
    ? (options.validFrom instanceof Date ? options.validFrom.toISOString() : options.validFrom)
    : null;
  const validUntilStr = options?.validUntil
    ? (options.validUntil instanceof Date ? options.validUntil.toISOString() : options.validUntil)
    : null;

  try {
    const result = database
      .prepare(`
        INSERT INTO memory_links (source_id, target_id, relation, weight, valid_from, valid_until)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(sourceId, targetId, relation, weight, validFromStr, validUntilStr);

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
 * Get memory with its links (optionally filtered by validity at a point in time)
 */
export function getMemoryWithLinks(
  memoryId: number,
  options?: { asOfDate?: Date; includeExpired?: boolean }
): MemoryWithLinks | null {
  const memory = getMemoryById(memoryId);
  if (!memory) return null;

  const links = getMemoryLinks(memoryId);
  const now = options?.asOfDate?.getTime() ?? Date.now();
  const includeExpired = options?.includeExpired ?? false;

  // Filter links by validity period
  const filterLink = (link: MemoryLink) => {
    if (includeExpired) return true;
    if (link.valid_from) {
      const validFrom = new Date(link.valid_from).getTime();
      if (now < validFrom) return false;
    }
    if (link.valid_until) {
      const validUntil = new Date(link.valid_until).getTime();
      if (now > validUntil) return false;
    }
    return true;
  };

  return {
    ...memory,
    outgoing_links: links.outgoing.filter(filterLink).map(l => ({
      target_id: l.target_id,
      relation: l.relation as LinkRelation,
      weight: l.weight,
      valid_from: l.valid_from,
      valid_until: l.valid_until,
    })),
    incoming_links: links.incoming.filter(filterLink).map(l => ({
      source_id: l.source_id,
      relation: l.relation as LinkRelation,
      weight: l.weight,
      valid_from: l.valid_from,
      valid_until: l.valid_until,
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

/**
 * Invalidate a memory link by setting valid_until to now.
 * This is the "soft delete" approach for temporal graphs - we keep the link
 * for historical queries but it won't appear in current-time queries.
 */
export function invalidateMemoryLink(
  sourceId: number,
  targetId: number,
  relation?: LinkRelation
): boolean {
  const database = getDb();
  const now = new Date().toISOString();

  if (relation) {
    const result = database
      .prepare('UPDATE memory_links SET valid_until = ? WHERE source_id = ? AND target_id = ? AND relation = ? AND valid_until IS NULL')
      .run(now, sourceId, targetId, relation);
    return result.changes > 0;
  } else {
    const result = database
      .prepare('UPDATE memory_links SET valid_until = ? WHERE source_id = ? AND target_id = ? AND valid_until IS NULL')
      .run(now, sourceId, targetId);
    return result.changes > 0;
  }
}

/**
 * Get graph snapshot at a specific point in time.
 * This is the core of temporal knowledge graphs - ability to query historical state.
 *
 * @param asOfDate - The point in time to query
 * @returns Graph stats at that point in time
 */
export function getGraphStatsAsOf(asOfDate: Date): {
  total_memories: number;
  total_links: number;
  avg_links_per_memory: number;
  relations: Record<string, number>;
} {
  const database = getDb();
  const asOfStr = asOfDate.toISOString();

  // Count memories that existed at that time
  const totalMemories = (database
    .prepare('SELECT COUNT(*) as count FROM memories WHERE created_at <= ?')
    .get(asOfStr) as { count: number }).count;

  // Count links that were valid at that time
  const totalLinks = (database
    .prepare(`
      SELECT COUNT(*) as count FROM memory_links
      WHERE created_at <= ?
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (valid_until IS NULL OR valid_until > ?)
    `)
    .get(asOfStr, asOfStr, asOfStr) as { count: number }).count;

  // Count by relation type at that time
  const relationCounts = database
    .prepare(`
      SELECT relation, COUNT(*) as count FROM memory_links
      WHERE created_at <= ?
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (valid_until IS NULL OR valid_until > ?)
      GROUP BY relation
    `)
    .all(asOfStr, asOfStr, asOfStr) as Array<{ relation: string; count: number }>;

  const relations: Record<string, number> = {};
  for (const row of relationCounts) {
    relations[row.relation] = row.count;
  }

  return {
    total_memories: totalMemories,
    total_links: totalLinks,
    avg_links_per_memory: totalMemories > 0 ? totalLinks / totalMemories : 0,
    relations,
  };
}

/**
 * Search memories as they existed at a specific point in time.
 * Core function for point-in-time queries.
 */
export function searchMemoriesAsOf(
  queryEmbedding: number[],
  asOfDate: Date,
  limit: number = 5,
  threshold: number = 0.3
): MemorySearchResult[] {
  const database = getDb();
  const asOfStr = asOfDate.toISOString();
  const asOfTime = asOfDate.getTime();

  // Get memories that existed at that time
  const rows = database.prepare(`
    SELECT * FROM memories
    WHERE created_at <= ?
  `).all(asOfStr) as Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    quality_score: number | null;
    quality_factors: string | null;
    access_count: number | null;
    last_accessed: string | null;
    valid_from: string | null;
    valid_until: string | null;
    embedding: Buffer;
    created_at: string;
  }>;

  const results: MemorySearchResult[] = [];

  for (const row of rows) {
    // Check validity period at asOfDate
    if (row.valid_from) {
      const validFrom = new Date(row.valid_from).getTime();
      if (asOfTime < validFrom) continue;
    }
    if (row.valid_until) {
      const validUntil = new Date(row.valid_until).getTime();
      if (asOfTime > validUntil) continue;
    }

    const embedding = bufferToFloatArray(row.embedding);
    const similarity = cosineSimilarity(queryEmbedding, embedding);

    if (similarity >= threshold) {
      results.push({
        id: row.id,
        content: row.content,
        tags: row.tags ? JSON.parse(row.tags) : [],
        source: row.source,
        quality_score: row.quality_score,
        quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
        access_count: row.access_count ?? 0,
        last_accessed: row.last_accessed,
        valid_from: row.valid_from,
        valid_until: row.valid_until,
        created_at: row.created_at,
        similarity,
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

// ============================================================================
// Token Frequencies (for Ronin-style segmentation)
// ============================================================================

/**
 * Update token frequencies from a list of tokens.
 * Called during indexing to build frequency table.
 */
export function updateTokenFrequencies(tokens: string[]): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO token_frequencies (token, frequency, updated_at)
    VALUES (?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(token) DO UPDATE SET
      frequency = frequency + 1,
      updated_at = CURRENT_TIMESTAMP
  `);

  const updateMany = database.transaction((tokens: string[]) => {
    for (const token of tokens) {
      if (token.length >= 2) {
        stmt.run(token);
      }
    }
  });

  updateMany(tokens);
}

/**
 * Get token frequency from the database.
 * Returns 0 if token not found.
 */
export function getTokenFrequency(token: string): number {
  const database = getDb();
  const row = database
    .prepare('SELECT frequency FROM token_frequencies WHERE token = ?')
    .get(token) as { frequency: number } | undefined;
  return row?.frequency ?? 0;
}

/**
 * Get multiple token frequencies at once (more efficient for DP).
 */
export function getTokenFrequencies(tokens: string[]): Map<string, number> {
  const database = getDb();
  const result = new Map<string, number>();

  if (tokens.length === 0) return result;

  // Batch query for efficiency
  const placeholders = tokens.map(() => '?').join(',');
  const rows = database
    .prepare(`SELECT token, frequency FROM token_frequencies WHERE token IN (${placeholders})`)
    .all(...tokens) as Array<{ token: string; frequency: number }>;

  for (const row of rows) {
    result.set(row.token, row.frequency);
  }

  return result;
}

/**
 * Get total token count for probability calculation.
 */
export function getTotalTokenCount(): number {
  const database = getDb();
  const row = database
    .prepare('SELECT SUM(frequency) as total FROM token_frequencies')
    .get() as { total: number | null };
  return row?.total ?? 0;
}

/**
 * Get top N most frequent tokens (for debugging/stats).
 */
export function getTopTokens(limit: number = 100): Array<{ token: string; frequency: number }> {
  const database = getDb();
  return database
    .prepare('SELECT token, frequency FROM token_frequencies ORDER BY frequency DESC LIMIT ?')
    .all(limit) as Array<{ token: string; frequency: number }>;
}

/**
 * Clear all token frequencies (for reindexing).
 */
export function clearTokenFrequencies(): void {
  const database = getDb();
  database.prepare('DELETE FROM token_frequencies').run();
}

/**
 * Get token frequency stats.
 */
export function getTokenFrequencyStats(): {
  unique_tokens: number;
  total_occurrences: number;
  avg_frequency: number;
} {
  const database = getDb();
  const row = database
    .prepare(`
      SELECT
        COUNT(*) as unique_tokens,
        COALESCE(SUM(frequency), 0) as total_occurrences
      FROM token_frequencies
    `)
    .get() as { unique_tokens: number; total_occurrences: number };

  return {
    unique_tokens: row.unique_tokens,
    total_occurrences: row.total_occurrences,
    avg_frequency: row.unique_tokens > 0 ? row.total_occurrences / row.unique_tokens : 0,
  };
}

// ============================================================================
// Token Stats (for tracking token savings)
// ============================================================================

export type TokenEventType = 'recall' | 'search' | 'search_code' | 'session_summary';

export interface TokenStatRecord {
  event_type: TokenEventType;
  query?: string;
  returned_tokens: number;
  full_source_tokens: number;
  savings_tokens: number;
  files_count?: number;
  chunks_count?: number;
  model?: string;
  estimated_cost?: number;
}

/**
 * Record a token saving event.
 */
export function recordTokenStat(record: TokenStatRecord): void {
  const database = getDb();
  database
    .prepare(
      `
    INSERT INTO token_stats (event_type, query, returned_tokens, full_source_tokens, savings_tokens, files_count, chunks_count, model, estimated_cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      record.event_type,
      record.query ?? null,
      record.returned_tokens,
      record.full_source_tokens,
      record.savings_tokens,
      record.files_count ?? null,
      record.chunks_count ?? null,
      record.model ?? null,
      record.estimated_cost ?? 0
    );
}

export interface TokenStatsAggregated {
  event_type: TokenEventType;
  query_count: number;
  total_returned_tokens: number;
  total_full_source_tokens: number;
  total_savings_tokens: number;
  total_estimated_cost: number;
}

/**
 * Get aggregated token stats by event type.
 */
export function getTokenStatsAggregated(): TokenStatsAggregated[] {
  const database = getDb();
  return database
    .prepare(
      `
    SELECT
      event_type,
      COUNT(*) as query_count,
      SUM(returned_tokens) as total_returned_tokens,
      SUM(full_source_tokens) as total_full_source_tokens,
      SUM(savings_tokens) as total_savings_tokens,
      COALESCE(SUM(estimated_cost), 0) as total_estimated_cost
    FROM token_stats
    GROUP BY event_type
    ORDER BY event_type
  `
    )
    .all() as TokenStatsAggregated[];
}

/**
 * Get total token savings summary.
 */
export function getTokenStatsSummary(): {
  total_queries: number;
  total_returned_tokens: number;
  total_full_source_tokens: number;
  total_savings_tokens: number;
  total_estimated_cost: number;
} {
  const database = getDb();
  const row = database
    .prepare(
      `
    SELECT
      COUNT(*) as total_queries,
      COALESCE(SUM(returned_tokens), 0) as total_returned_tokens,
      COALESCE(SUM(full_source_tokens), 0) as total_full_source_tokens,
      COALESCE(SUM(savings_tokens), 0) as total_savings_tokens,
      COALESCE(SUM(estimated_cost), 0) as total_estimated_cost
    FROM token_stats
  `
    )
    .get() as {
    total_queries: number;
    total_returned_tokens: number;
    total_full_source_tokens: number;
    total_savings_tokens: number;
    total_estimated_cost: number;
  };

  return row;
}

/**
 * Clear all token stats.
 */
export function clearTokenStats(): void {
  const database = getDb();
  database.prepare('DELETE FROM token_stats').run();
}

// ============================================================================
// Memory Access Tracking (for retention decay)
// ============================================================================

/**
 * Increment access count for a memory.
 * @param memoryId - The memory ID
 * @param weight - Weight of the access (1.0 for exact match, 0.5 for similarity hit)
 */
export function incrementMemoryAccess(memoryId: number, weight: number = 1.0): void {
  const database = getDb();
  database
    .prepare(`
      UPDATE memories
      SET access_count = COALESCE(access_count, 0) + ?,
          last_accessed = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .run(weight, memoryId);
}

/**
 * Batch increment access counts for multiple memories.
 * @param accesses - Array of { memoryId, weight } objects
 */
export function incrementMemoryAccessBatch(accesses: Array<{ memoryId: number; weight: number }>): void {
  if (accesses.length === 0) return;

  const database = getDb();
  const stmt = database.prepare(`
    UPDATE memories
    SET access_count = COALESCE(access_count, 0) + ?,
        last_accessed = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  const transaction = database.transaction((items: Array<{ memoryId: number; weight: number }>) => {
    for (const { memoryId, weight } of items) {
      stmt.run(weight, memoryId);
    }
  });

  transaction(accesses);
}

/**
 * Memory data for retention calculations
 */
export interface MemoryForRetention {
  id: number;
  content: string;
  quality_score: number | null;
  access_count: number;
  created_at: string;
  last_accessed: string | null;
}

/**
 * Get all memories with retention-relevant fields.
 */
export function getAllMemoriesForRetention(): MemoryForRetention[] {
  const database = getDb();
  const rows = database
    .prepare(`
      SELECT id, content, quality_score, access_count, created_at, last_accessed
      FROM memories
      ORDER BY created_at ASC
    `)
    .all() as Array<{
      id: number;
      content: string;
      quality_score: number | null;
      access_count: number | null;
      created_at: string;
      last_accessed: string | null;
    }>;

  return rows.map(row => ({
    id: row.id,
    content: row.content,
    quality_score: row.quality_score,
    access_count: row.access_count ?? 0,
    created_at: row.created_at,
    last_accessed: row.last_accessed,
  }));
}

/**
 * Delete memories by IDs (batch operation for retention cleanup).
 */
export function deleteMemoriesByIds(ids: number[]): number {
  if (ids.length === 0) return 0;

  const database = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const result = database
    .prepare(`DELETE FROM memories WHERE id IN (${placeholders})`)
    .run(...ids);

  // Invalidate BM25 index since memories changed
  invalidateMemoriesBm25Index();

  return result.changes;
}
