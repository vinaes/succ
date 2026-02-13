import { getDb, getGlobalDb, onDbChange } from './connection.js';
import * as bm25 from '../bm25.js';
import { logWarn } from '../fault-logger.js';

// Batch size for paginated index rebuilds — limits peak memory during full rebuild.
const REBUILD_BATCH_SIZE = 5000;

// ============================================================================
// BM25 Index Management for Code
// ============================================================================

let codeBm25Index: bm25.BM25Index | null = null;

/**
 * Get or build BM25 index for code search
 */
function getCodeBm25Index(): bm25.BM25Index {
  if (codeBm25Index) return codeBm25Index;

  const database = getDb();

  // Try to load from metadata
  const stored = database
    .prepare("SELECT value FROM metadata WHERE key = 'bm25_code_index'")
    .get() as { value: string } | undefined;

  if (stored) {
    try {
      codeBm25Index = bm25.deserializeIndex(stored.value);
      return codeBm25Index;
    } catch {
      // Invalid stored index, rebuild
    }
  }

  // Build from documents in batches to limit peak memory
  codeBm25Index = bm25.createEmptyIndex();
  const stmt = database.prepare(
    "SELECT id, content, symbol_name, signature FROM documents WHERE file_path LIKE 'code:%' ORDER BY id LIMIT ? OFFSET ?"
  );
  let offset = 0;
  for (;;) {
    const rows = stmt.all(REBUILD_BATCH_SIZE, offset) as Array<{
      id: number;
      content: string;
      symbol_name: string | null;
      signature: string | null;
    }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      bm25.addToIndex(
        codeBm25Index,
        {
          id: row.id,
          content: row.content,
          symbolName: row.symbol_name ?? undefined,
          signature: row.signature ?? undefined,
        },
        'code'
      );
    }
    offset += rows.length;
    if (rows.length < REBUILD_BATCH_SIZE) break;
  }

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
  database
    .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('bm25_code_index', ?)")
    .run(serialized);
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
export function updateCodeBm25Index(
  docId: number,
  content: string,
  symbolName?: string,
  signature?: string
): void {
  const index = getCodeBm25Index();
  // Remove old entry if exists
  bm25.removeFromIndex(index, docId);
  // Pass AST metadata for tokenizeCodeWithAST boost
  bm25.addToIndex(index, { id: docId, content, symbolName, signature }, 'code');
  saveCodeBm25Index();
}

// Export getter for use in hybrid search
export { getCodeBm25Index };

// ============================================================================
// BM25 Index Management for Docs (brain/ markdown files)
// ============================================================================

let docsBm25Index: bm25.BM25Index | null = null;

/**
 * Get or build BM25 index for docs search (brain/ files)
 */
function getDocsBm25Index(): bm25.BM25Index {
  if (docsBm25Index) return docsBm25Index;

  const database = getDb();

  // Try to load from metadata
  const stored = database
    .prepare("SELECT value FROM metadata WHERE key = 'bm25_docs_index'")
    .get() as { value: string } | undefined;

  if (stored) {
    try {
      docsBm25Index = bm25.deserializeIndex(stored.value);
      return docsBm25Index;
    } catch {
      // Invalid stored index, rebuild
    }
  }

  // Build from documents in batches to limit peak memory
  docsBm25Index = bm25.createEmptyIndex();
  const stmt = database.prepare(
    "SELECT id, content FROM documents WHERE file_path NOT LIKE 'code:%' ORDER BY id LIMIT ? OFFSET ?"
  );
  let offset = 0;
  for (;;) {
    const rows = stmt.all(REBUILD_BATCH_SIZE, offset) as Array<{ id: number; content: string }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      bm25.addToIndex(docsBm25Index, row, 'docs');
    }
    offset += rows.length;
    if (rows.length < REBUILD_BATCH_SIZE) break;
  }

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
  database
    .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('bm25_docs_index', ?)")
    .run(serialized);
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
 * Update docs BM25 index when a document is added/updated
 */
export function updateDocsBm25Index(docId: number, content: string): void {
  const index = getDocsBm25Index();
  bm25.removeFromIndex(index, docId);
  bm25.addToIndex(index, { id: docId, content }, 'docs');
  saveDocsBm25Index();
}

// Export getter for use in hybrid search
export { getDocsBm25Index };

// ============================================================================
// BM25 Index Management for Memories
// ============================================================================

let memoriesBm25Index: bm25.BM25Index | null = null;

/**
 * Get or build BM25 index for memories
 */
function getMemoriesBm25Index(): bm25.BM25Index {
  if (memoriesBm25Index) return memoriesBm25Index;

  const database = getDb();

  // Try to load from metadata
  const stored = database
    .prepare("SELECT value FROM metadata WHERE key = 'bm25_memories_index'")
    .get() as { value: string } | undefined;

  if (stored) {
    try {
      memoriesBm25Index = bm25.deserializeIndex(stored.value);
      return memoriesBm25Index;
    } catch {
      // Invalid stored index, rebuild
    }
  }

  // Build from memories in batches to limit peak memory
  memoriesBm25Index = bm25.createEmptyIndex();
  {
    const stmt = database.prepare('SELECT id, content FROM memories ORDER BY id LIMIT ? OFFSET ?');
    let offset = 0;
    for (;;) {
      const rows = stmt.all(REBUILD_BATCH_SIZE, offset) as Array<{ id: number; content: string }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        bm25.addToIndex(memoriesBm25Index, row, 'docs');
      }
      offset += rows.length;
      if (rows.length < REBUILD_BATCH_SIZE) break;
    }
  }

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
  database
    .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('bm25_memories_index', ?)")
    .run(serialized);
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

// Export getter for use in hybrid search
export { getMemoriesBm25Index };

// ============================================================================
// BM25 Index Management for Global Memories
// ============================================================================

let globalMemoriesBm25Index: bm25.BM25Index | null = null;

/**
 * Get or build BM25 index for global memories
 */
function getGlobalMemoriesBm25Index(): bm25.BM25Index {
  if (globalMemoriesBm25Index) return globalMemoriesBm25Index;

  const database = getGlobalDb();

  // Try to load from metadata
  const stored = database
    .prepare("SELECT value FROM metadata WHERE key = 'bm25_memories_index'")
    .get() as { value: string } | undefined;

  if (stored) {
    try {
      globalMemoriesBm25Index = bm25.deserializeIndex(stored.value);
      return globalMemoriesBm25Index;
    } catch {
      // Invalid stored index, rebuild
    }
  }

  // Build from memories in batches to limit peak memory
  globalMemoriesBm25Index = bm25.createEmptyIndex();
  {
    const stmt = database.prepare('SELECT id, content FROM memories ORDER BY id LIMIT ? OFFSET ?');
    let offset = 0;
    for (;;) {
      const rows = stmt.all(REBUILD_BATCH_SIZE, offset) as Array<{ id: number; content: string }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        bm25.addToIndex(globalMemoriesBm25Index, row, 'docs');
      }
      offset += rows.length;
      if (rows.length < REBUILD_BATCH_SIZE) break;
    }
  }

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
  database
    .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('bm25_memories_index', ?)")
    .run(bm25.serializeIndex(globalMemoriesBm25Index));
}

/**
 * Invalidate global memories BM25 index
 */
export function invalidateGlobalMemoriesBm25Index(): void {
  globalMemoriesBm25Index = null;
  try {
    const database = getGlobalDb();
    database.prepare("DELETE FROM metadata WHERE key = 'bm25_memories_index'").run();
  } catch (err) {
    logWarn('bm25', 'Failed to invalidate BM25 index', {
      error: err instanceof Error ? err.message : String(err),
    });
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

// Export getter for use in hybrid search
export { getGlobalMemoriesBm25Index };

// ============================================================================
// Invalidate All BM25 Indexes
// ============================================================================

/**
 * Invalidate all BM25 indexes (useful for full rebuild)
 */
export function invalidateBM25Index(): void {
  invalidateCodeBm25Index();
  invalidateDocsBm25Index();
  invalidateMemoriesBm25Index();
  invalidateGlobalMemoriesBm25Index();
}

// Auto-flush BM25 caches when DB is swapped via setDb()
onDbChange(invalidateBM25Index);
