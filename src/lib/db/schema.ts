import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { getConfig, getLLMTaskConfig } from '../config.js';
import { logWarn } from '../fault-logger.js';
import { getModelDimension } from '../embeddings.js';
import { bufferToFloatArray } from './helpers.js';

// Flag to track if sqlite-vec is available
export let sqliteVecAvailable = true;

/**
 * Load sqlite-vec extension into database
 */
export function loadSqliteVec(database: Database.Database): boolean {
  if (!sqliteVecAvailable) return false;
  try {
    sqliteVec.load(database);
    return true;
  } catch {
    sqliteVecAvailable = false;
    return false;
  }
}

// Valid memory types
export const MEMORY_TYPES = ['observation', 'decision', 'learning', 'error', 'pattern', 'dead_end'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * Initialize local database schema
 */
export function initDb(database: Database.Database): void {
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

    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL,
      source TEXT NOT NULL,
      path TEXT,
      content TEXT,
      embedding BLOB,
      skyll_id TEXT,
      usage_count INTEGER DEFAULT 0,
      last_used TEXT,
      cached_at TEXT,
      cache_expires TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
    CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
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

  // Migration: add project_id column to skills table for project scoping
  try {
    database.prepare(`ALTER TABLE skills ADD COLUMN project_id TEXT`).run();
    // Note: SQLite doesn't support dropping and recreating unique constraints easily.
    // For existing databases, the old UNIQUE(name) constraint remains.
    // The code handles this by using ON CONFLICT with name only for SQLite.
  } catch {
    // Column already exists, ignore
  }
  try {
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_skills_project_id ON skills(project_id)`).run();
  } catch {
    // Index already exists, ignore
  }

  // Migration: add invalidated_by column for soft-delete during consolidation
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN invalidated_by INTEGER`).run();
  } catch {
    // Column already exists, ignore
  }
  try {
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_memories_invalidated_by ON memories(invalidated_by)`).run();
  } catch {
    // Index already exists, ignore
  }

  // Migration: add AST metadata columns to documents table (tree-sitter integration)
  for (const col of ['symbol_name TEXT', 'symbol_type TEXT', 'signature TEXT']) {
    try {
      database.prepare(`ALTER TABLE documents ADD COLUMN ${col}`).run();
    } catch {
      // Column already exists, ignore
    }
  }
  try {
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_symbol_type ON documents(symbol_type)`).run();
  } catch {
    // Index already exists, ignore
  }
  try {
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_symbol_name ON documents(symbol_name)`).run();
  } catch {
    // Index already exists, ignore
  }

  // Migration: create learning_deltas table for session progress tracking
  database.exec(`
    CREATE TABLE IF NOT EXISTS learning_deltas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL,
      memories_before INTEGER NOT NULL DEFAULT 0,
      memories_after INTEGER NOT NULL DEFAULT 0,
      new_memories INTEGER NOT NULL DEFAULT 0,
      types_added TEXT,
      avg_quality REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_learning_deltas_timestamp ON learning_deltas(timestamp);
    CREATE INDEX IF NOT EXISTS idx_learning_deltas_source ON learning_deltas(source);
  `);

  // Migration: add llm_enriched column to memory_links (for LLM relation extraction)
  try {
    database.prepare(`ALTER TABLE memory_links ADD COLUMN llm_enriched INTEGER DEFAULT 0`).run();
  } catch {
    // Column already exists, ignore
  }

  // Migration: create memory_centrality cache table
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_centrality (
      memory_id INTEGER PRIMARY KEY,
      degree REAL DEFAULT 0,
      normalized_degree REAL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Web search history table
  database.exec(`
    CREATE TABLE IF NOT EXISTS web_search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      model TEXT NOT NULL,
      query TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      citations_count INTEGER NOT NULL DEFAULT 0,
      has_reasoning INTEGER NOT NULL DEFAULT 0,
      response_length_chars INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_wsh_created ON web_search_history(created_at);
    CREATE INDEX IF NOT EXISTS idx_wsh_tool ON web_search_history(tool_name);
  `);

  // Check if embedding model changed - warn user if reindex needed
  checkModelCompatibility(database);

  // Migration: create sqlite-vec virtual tables for fast vector search
  initVecTables(database);
}

/**
 * Check if the embedding model has changed since last index.
 * If so, warn the user that they need to reindex.
 */
function checkModelCompatibility(database: Database.Database): void {
  const config = getConfig();
  const currentModel = getLLMTaskConfig('embeddings').model;

  // Get stored model
  const stored = database
    .prepare('SELECT value FROM metadata WHERE key = ?')
    .get('embedding_model') as { value: string } | undefined;

  if (stored && stored.value !== currentModel) {
    const currentDim = getModelDimension(currentModel);
    const storedDim = getModelDimension(stored.value);

    // Different dimensions = incompatible, must reindex
    if (currentDim && storedDim && currentDim !== storedDim) {
      logWarn('db-schema', `Embedding model changed: ${stored.value} (dim=${storedDim}) -> ${currentModel} (dim=${currentDim})`);
      logWarn('db-schema', 'Dimensions are incompatible — existing embeddings will not work correctly');
      logWarn('db-schema', 'Run "succ reindex" to regenerate all embeddings with the new model');
    } else if (stored.value !== currentModel) {
      // Same dimension but different model - still should reindex for accuracy
      logWarn('db-schema', `Embedding model changed: ${stored.value} -> ${currentModel} (same dimension=${currentDim})`);
      logWarn('db-schema', 'Run "succ reindex" to regenerate embeddings for best accuracy');
    }
  }

  // Store current model
  database
    .prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
    .run('embedding_model', currentModel);
}

/**
 * Initialize sqlite-vec virtual tables for fast KNN search.
 * Creates vec_memories and vec_documents tables, migrates existing data.
 *
 * Note: sqlite-vec doesn't support custom primary keys well, so we use a mapping table
 * that maps vec rowid -> memory/document id.
 */
export function initVecTables(database: Database.Database): void {
  if (!sqliteVecAvailable) return;

  const config = getConfig();
  const configDims = getConfig().llm?.embeddings?.dimensions;
  const dims = configDims ?? getModelDimension(getLLMTaskConfig('embeddings').model) ?? 384;

  // Check if vec tables already exist
  const vecMemoriesExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_memories'")
    .get();

  // Check persistent migration flag to avoid re-running migrations
  const vecMemoriesMigrated = database
    .prepare("SELECT value FROM metadata WHERE key = 'vec_memories_migrated_dims'")
    .get() as { value: string } | undefined;

  // Check if migration is needed (table empty but memories exist)
  // ONLY migrate if no persistent flag exists — prevents repeated DROP+CREATE
  let needsMemoriesMigration = false;
  if (vecMemoriesExists && !vecMemoriesMigrated) {
    try {
      const vecCount = database.prepare('SELECT COUNT(*) as cnt FROM vec_memories').get() as { cnt: number };
      const memCount = database.prepare('SELECT COUNT(*) as cnt FROM memories WHERE embedding IS NOT NULL').get() as { cnt: number };
      needsMemoriesMigration = vecCount.cnt === 0 && memCount.cnt > 0;
    } catch {
      // Table might be corrupted, recreate it
      needsMemoriesMigration = false;
    }
  }

  if (!vecMemoriesExists || needsMemoriesMigration) {
    try {
      if (needsMemoriesMigration) {
        // Drop old table with wrong schema
        database.prepare('DROP TABLE IF EXISTS vec_memories').run();
        database.prepare('DROP TABLE IF EXISTS vec_memories_map').run();
      }

      // Create vec0 virtual table for memories (simple schema, rowid auto-assigned)
      database.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          embedding float[${dims}] distance_metric=cosine
        )
      `).run();

      // Create mapping table: vec rowid -> memory id
      database.prepare(`
        CREATE TABLE IF NOT EXISTS vec_memories_map (
          vec_rowid INTEGER PRIMARY KEY,
          memory_id INTEGER NOT NULL UNIQUE
        )
      `).run();

      // Migrate existing embeddings
      const memories = database
        .prepare('SELECT id, embedding FROM memories WHERE embedding IS NOT NULL ORDER BY id')
        .all() as Array<{ id: number; embedding: Buffer }>;

      if (memories.length > 0) {
        const insertVec = database.prepare('INSERT INTO vec_memories(embedding) VALUES (?)');
        const insertMap = database.prepare('INSERT INTO vec_memories_map(vec_rowid, memory_id) VALUES (?, ?)');

        const migrate = database.transaction(() => {
          for (const mem of memories) {
            const result = insertVec.run(mem.embedding);
            insertMap.run(result.lastInsertRowid, mem.id);
          }
        });
        migrate();
      }

      // Store persistent migration flag to prevent re-running
      database
        .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('vec_memories_migrated_dims', ?)")
        .run(String(dims));
    } catch {
      // sqlite-vec may not support this syntax or other error
      sqliteVecAvailable = false;
    }
  }

  const vecDocumentsExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_documents'")
    .get();

  // Check persistent migration flag for documents
  const vecDocumentsMigrated = database
    .prepare("SELECT value FROM metadata WHERE key = 'vec_documents_migrated_dims'")
    .get() as { value: string } | undefined;

  // Check if migration is needed for documents
  // ONLY migrate if no persistent flag exists — prevents repeated DROP+CREATE
  let needsDocumentsMigration = false;
  if (vecDocumentsExists && sqliteVecAvailable && !vecDocumentsMigrated) {
    try {
      const vecCount = database.prepare('SELECT COUNT(*) as cnt FROM vec_documents').get() as { cnt: number };
      const docCount = database.prepare('SELECT COUNT(*) as cnt FROM documents WHERE embedding IS NOT NULL').get() as { cnt: number };
      needsDocumentsMigration = vecCount.cnt === 0 && docCount.cnt > 0;
    } catch {
      needsDocumentsMigration = false;
    }
  }

  if ((!vecDocumentsExists || needsDocumentsMigration) && sqliteVecAvailable) {
    try {
      if (needsDocumentsMigration) {
        database.prepare('DROP TABLE IF EXISTS vec_documents').run();
        database.prepare('DROP TABLE IF EXISTS vec_documents_map').run();
      }

      // Create vec0 virtual table for documents
      database.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_documents USING vec0(
          embedding float[${dims}] distance_metric=cosine
        )
      `).run();

      // Create mapping table: vec rowid -> document id
      database.prepare(`
        CREATE TABLE IF NOT EXISTS vec_documents_map (
          vec_rowid INTEGER PRIMARY KEY,
          doc_id INTEGER NOT NULL UNIQUE
        )
      `).run();

      // Migrate existing embeddings
      const docs = database
        .prepare('SELECT id, embedding FROM documents WHERE embedding IS NOT NULL ORDER BY id')
        .all() as Array<{ id: number; embedding: Buffer }>;

      if (docs.length > 0) {
        const insertVec = database.prepare('INSERT INTO vec_documents(embedding) VALUES (?)');
        const insertMap = database.prepare('INSERT INTO vec_documents_map(vec_rowid, doc_id) VALUES (?, ?)');

        const migrate = database.transaction(() => {
          for (const doc of docs) {
            const result = insertVec.run(doc.embedding);
            insertMap.run(result.lastInsertRowid, doc.id);
          }
        });
        migrate();
      }

      // Store persistent migration flag to prevent re-running
      database
        .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('vec_documents_migrated_dims', ?)")
        .run(String(dims));
    } catch {
      // Ignore errors for documents table
    }
  }
}

/**
 * Initialize global database schema
 */
export function initGlobalDb(database: Database.Database): void {
  // Global DB has memories table (shared across projects) and metadata for BM25 index
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

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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

  // Migration: add invalidated_by column for soft-delete during consolidation
  try {
    database.prepare(`ALTER TABLE memories ADD COLUMN invalidated_by INTEGER`).run();
  } catch {
    // Column already exists, ignore
  }
  try {
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_global_memories_invalidated_by ON memories(invalidated_by)`).run();
  } catch {
    // Index already exists, ignore
  }

  // Migration: create sqlite-vec virtual table for global memories
  initGlobalVecTable(database);
}

/**
 * Initialize sqlite-vec virtual table for global memories
 */
export function initGlobalVecTable(database: Database.Database): void {
  if (!sqliteVecAvailable) return;

  const config = getConfig();
  const configDims = getConfig().llm?.embeddings?.dimensions;
  const dims = configDims ?? getModelDimension(getLLMTaskConfig('embeddings').model) ?? 384;

  const vecMemoriesExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_memories'")
    .get();

  // Check persistent migration flag
  const vecMigrated = database
    .prepare("SELECT value FROM metadata WHERE key = 'vec_memories_migrated_dims'")
    .get() as { value: string } | undefined;

  // Check if migration is needed — skip if persistent flag exists
  let needsMigration = false;
  if (vecMemoriesExists && !vecMigrated) {
    try {
      const vecCount = database.prepare('SELECT COUNT(*) as cnt FROM vec_memories').get() as { cnt: number };
      const memCount = database.prepare('SELECT COUNT(*) as cnt FROM memories WHERE embedding IS NOT NULL').get() as { cnt: number };
      needsMigration = vecCount.cnt === 0 && memCount.cnt > 0;
    } catch {
      needsMigration = false;
    }
  }

  if (!vecMemoriesExists || needsMigration) {
    try {
      if (needsMigration) {
        database.prepare('DROP TABLE IF EXISTS vec_memories').run();
        database.prepare('DROP TABLE IF EXISTS vec_memories_map').run();
      }

      // Create vec0 virtual table (simple schema)
      database.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          embedding float[${dims}] distance_metric=cosine
        )
      `).run();

      // Create mapping table
      database.prepare(`
        CREATE TABLE IF NOT EXISTS vec_memories_map (
          vec_rowid INTEGER PRIMARY KEY,
          memory_id INTEGER NOT NULL UNIQUE
        )
      `).run();

      // Migrate existing embeddings
      const memories = database
        .prepare('SELECT id, embedding FROM memories WHERE embedding IS NOT NULL ORDER BY id')
        .all() as Array<{ id: number; embedding: Buffer }>;

      if (memories.length > 0) {
        const insertVec = database.prepare('INSERT INTO vec_memories(embedding) VALUES (?)');
        const insertMap = database.prepare('INSERT INTO vec_memories_map(vec_rowid, memory_id) VALUES (?, ?)');

        const migrate = database.transaction(() => {
          for (const mem of memories) {
            const result = insertVec.run(mem.embedding);
            insertMap.run(result.lastInsertRowid, mem.id);
          }
        });
        migrate();
      }

      // Store persistent migration flag
      database
        .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('vec_memories_migrated_dims', ?)")
        .run(String(dims));
    } catch {
      // sqlite-vec may not be available for global db
    }
  }
}
