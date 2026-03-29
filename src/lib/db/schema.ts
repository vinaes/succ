import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { getConfig, getLLMTaskConfig } from '../config.js';
import { logWarn } from '../fault-logger.js';
import { getErrorMessage } from '../errors.js';
import { getModelDimension } from '../embeddings.js';

// Flag to track if sqlite-vec is available
export let sqliteVecAvailable = true;

/**
 * Run a migration SQL statement, ignoring expected "already exists" errors.
 * Any unexpected error is logged via logWarn.
 */
function safeMigrate(database: Database.Database, sql: string, description: string): void {
  try {
    database.prepare(sql).run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('duplicate column name')) {
      return;
    }
    logWarn('schema', `Migration failed (${description})`, { error: msg, sql });
    throw err;
  }
}

/**
 * Load sqlite-vec extension into database
 */
export function loadSqliteVec(database: Database.Database): boolean {
  if (!sqliteVecAvailable) return false;
  try {
    sqliteVec.load(database);
    return true;
  } catch (error) {
    logWarn('schema', 'sqlite-vec extension load failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    sqliteVecAvailable = false;
    return false;
  }
}

// Valid memory types
export const MEMORY_TYPES = [
  'observation',
  'decision',
  'learning',
  'error',
  'pattern',
  'dead_end',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const SOURCE_TYPES = [
  'human',
  'agent',
  'canonical_doc',
  'imported',
  'auto_extracted',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

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
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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
      name TEXT NOT NULL,
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
      project_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
    CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
  `);

  // Migration: add type column if missing (for existing databases)
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN type TEXT DEFAULT 'observation'`,
    'memories.type'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`,
    'idx_memories_type'
  );

  // Migration: add quality_score and quality_factors columns
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN quality_score REAL`,
    'memories.quality_score'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN quality_factors TEXT`,
    'memories.quality_factors'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_quality ON memories(quality_score)`,
    'idx_memories_quality'
  );

  // Migration: add access_count and last_accessed columns for retention decay
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN access_count REAL DEFAULT 0`,
    'memories.access_count'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN last_accessed TEXT`,
    'memories.last_accessed'
  );

  // Migration: add valid_from and valid_until columns for temporal awareness
  safeMigrate(database, `ALTER TABLE memories ADD COLUMN valid_from TEXT`, 'memories.valid_from');
  safeMigrate(database, `ALTER TABLE memories ADD COLUMN valid_until TEXT`, 'memories.valid_until');

  // Migration: add temporal fields to memory_links
  safeMigrate(
    database,
    `ALTER TABLE memory_links ADD COLUMN valid_from TEXT`,
    'memory_links.valid_from'
  );
  safeMigrate(
    database,
    `ALTER TABLE memory_links ADD COLUMN valid_until TEXT`,
    'memory_links.valid_until'
  );

  // Migration: add model and estimated_cost columns to token_stats
  safeMigrate(database, `ALTER TABLE token_stats ADD COLUMN model TEXT`, 'token_stats.model');
  safeMigrate(
    database,
    `ALTER TABLE token_stats ADD COLUMN estimated_cost REAL DEFAULT 0`,
    'token_stats.estimated_cost'
  );

  // Migration: rebuild skills table with UNIQUE(project_id, name) for project scoping.
  // SQLite doesn't support ALTER CONSTRAINT, so we rebuild for existing databases.
  // Fresh databases already have the correct schema from CREATE TABLE above.
  try {
    const hasProjectId = database
      .prepare(`PRAGMA table_info(skills)`)
      .all()
      .some((col) => (col as { name: string }).name === 'project_id');
    if (!hasProjectId) {
      database
        .prepare(
          `CREATE TABLE skills_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
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
        project_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, name)
      )`
        )
        .run();
      database.prepare(`INSERT INTO skills_new SELECT *, NULL FROM skills`).run();
      database.prepare(`DROP TABLE skills`).run();
      database.prepare(`ALTER TABLE skills_new RENAME TO skills`).run();
      database.prepare(`CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name)`).run();
      database.prepare(`CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source)`).run();
    }
  } catch (err) {
    logWarn('schema', 'Skills table rebuild migration failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_skills_project_id ON skills(project_id)`,
    'idx_skills_project_id'
  );

  // Migration: add invalidated_by column for soft-delete during consolidation
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN invalidated_by INTEGER`,
    'memories.invalidated_by'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_invalidated_by ON memories(invalidated_by)`,
    'idx_memories_invalidated_by'
  );

  // Migration: add correction_count and is_invariant columns for working memory pins
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN correction_count INTEGER DEFAULT 0`,
    'memories.correction_count'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN is_invariant INTEGER DEFAULT 0`,
    'memories.is_invariant'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(correction_count, is_invariant)`,
    'idx_memories_pinned'
  );

  // Migration: add priority_score column for working memory ranking
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN priority_score REAL DEFAULT NULL`,
    'memories.priority_score'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(priority_score DESC)`,
    'idx_memories_priority'
  );

  // Migration: add memory versioning columns
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN version INTEGER DEFAULT 1`,
    'memories.version'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN parent_memory_id INTEGER DEFAULT NULL`,
    'memories.parent_memory_id'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN root_memory_id INTEGER DEFAULT NULL`,
    'memories.root_memory_id'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN is_latest INTEGER DEFAULT 1`,
    'memories.is_latest'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_is_latest ON memories(is_latest)`,
    'idx_memories_is_latest'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_root ON memories(root_memory_id)`,
    'idx_memories_root'
  );

  // Migration: add AST metadata columns to documents table (tree-sitter integration)
  for (const col of ['symbol_name TEXT', 'symbol_type TEXT', 'signature TEXT']) {
    safeMigrate(
      database,
      `ALTER TABLE documents ADD COLUMN ${col}`,
      `documents.${col.split(' ')[0]}`
    );
  }
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_documents_symbol_type ON documents(symbol_type)`,
    'idx_documents_symbol_type'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_documents_symbol_name ON documents(symbol_name)`,
    'idx_documents_symbol_name'
  );

  // Migration: add performance indexes for common query patterns
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source)`,
    'idx_memories_source'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_valid_from ON memories(valid_from)`,
    'idx_memories_valid_from'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_valid_until ON memories(valid_until)`,
    'idx_memories_valid_until'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at)`,
    'idx_documents_updated_at'
  );

  // Migration: add bi-temporal columns to documents
  safeMigrate(
    database,
    `ALTER TABLE documents ADD COLUMN superseded_at TEXT DEFAULT NULL`,
    'documents.superseded_at'
  );
  safeMigrate(
    database,
    `ALTER TABLE documents ADD COLUMN git_commit_date TEXT DEFAULT NULL`,
    'documents.git_commit_date'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_documents_superseded ON documents(superseded_at)`,
    'idx_documents_superseded'
  );
  // Migration: drop legacy global UNIQUE(file_path, chunk_index) constraint from existing databases.
  // SQLite requires table recreation to remove a table-level constraint.
  // The partial unique index idx_documents_chunk_current replaces it (uniqueness only for current rows).
  safeMigrate(
    database,
    `CREATE TABLE IF NOT EXISTS _documents_migration_check (done INTEGER)`,
    'documents_unique_drop_check'
  );
  const migrationDone = database
    .prepare(`SELECT done FROM _documents_migration_check LIMIT 1`)
    .get() as { done: number } | undefined;
  if (!migrationDone) {
    // Check if the legacy constraint exists by inspecting the table SQL
    const tableInfo = database
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'`)
      .get() as { sql: string } | undefined;
    if (tableInfo?.sql && /UNIQUE\s*\(\s*file_path\s*,\s*chunk_index\s*\)/i.test(tableInfo.sql)) {
      logWarn('schema', 'Dropping legacy UNIQUE(file_path, chunk_index) from documents table');
      // Wrap the entire rebuild in a transaction so partial failure cannot leave
      // documents_new half-built or the original documents table already dropped.
      const rebuildDocuments = database.transaction(() => {
        database.exec(`
          CREATE TABLE documents_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            embedding BLOB NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            symbol_name TEXT,
            symbol_type TEXT,
            signature TEXT,
            superseded_at TEXT DEFAULT NULL,
            git_commit_date TEXT DEFAULT NULL
          );
          INSERT INTO documents_new SELECT
            id, file_path, chunk_index, content, start_line, end_line, embedding,
            created_at, updated_at, symbol_name, symbol_type, signature,
            superseded_at, git_commit_date
          FROM documents;
          DROP TABLE documents;
          ALTER TABLE documents_new RENAME TO documents;
          CREATE INDEX IF NOT EXISTS idx_documents_file_path ON documents(file_path);
          CREATE INDEX IF NOT EXISTS idx_documents_symbol_type ON documents(symbol_type);
          CREATE INDEX IF NOT EXISTS idx_documents_symbol_name ON documents(symbol_name);
          CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at);
          CREATE INDEX IF NOT EXISTS idx_documents_superseded ON documents(superseded_at);
        `);
        database.exec(`INSERT INTO _documents_migration_check (done) VALUES (1)`);
      });
      rebuildDocuments();
    } else {
      database.exec(`INSERT INTO _documents_migration_check (done) VALUES (1)`);
    }
  }

  // Partial unique index: only current (non-superseded) rows must be unique per path+chunk.
  // This allows superseded rows to coexist with new versions of the same chunk.
  safeMigrate(
    database,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_chunk_current ON documents(file_path, chunk_index) WHERE superseded_at IS NULL`,
    'idx_documents_chunk_current'
  );

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

  // Migration: add confidence and source_type columns for memory provenance
  // confidence: extraction correctness for auto-extracted memories (0.5 default, promoted to 0.7 on use). Distinct from quality_score (LLM content quality assessment).
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN confidence REAL DEFAULT 0.5`,
    'memories.confidence'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN source_type TEXT DEFAULT 'human'`,
    'memories.source_type'
  );

  // Migration: add forget_after column for automatic memory forgetting
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN forget_after TEXT DEFAULT NULL`,
    'memories.forget_after'
  );

  // Backfill forget_after for existing auto-extracted memories.
  // Idempotent: the WHERE clause includes `forget_after IS NULL`, so rows that
  // have already been backfilled (or had forget_after set at INSERT time) are
  // skipped on subsequent startups. No migration marker needed.
  // High-confidence (promoted) memories keep NULL forget_after (= permanent).
  try {
    database.exec(`
      UPDATE memories
      SET forget_after = datetime(created_at, '+90 days')
      WHERE source_type = 'auto_extracted'
        AND forget_after IS NULL
        AND (confidence IS NULL OR confidence < 0.7)
    `);
  } catch (backfillErr) {
    logWarn('schema', `forget_after backfill skipped: ${getErrorMessage(backfillErr)}`);
  }

  // Migration: add llm_enriched column to memory_links (for LLM relation extraction)
  safeMigrate(
    database,
    `ALTER TABLE memory_links ADD COLUMN llm_enriched INTEGER DEFAULT 0`,
    'memory_links.llm_enriched'
  );

  // Migration: add metadata JSON column to memory_links (for bridge edges)
  safeMigrate(
    database,
    `ALTER TABLE memory_links ADD COLUMN metadata TEXT`,
    'memory_links.metadata'
  );

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

  // Retrieval feedback table — tracks whether recalled memories were useful
  database.exec(`
    CREATE TABLE IF NOT EXISTS recall_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      was_used INTEGER NOT NULL DEFAULT 0,
      rank_position INTEGER,
      similarity_score REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_recall_events_memory ON recall_events(memory_id);
    CREATE INDEX IF NOT EXISTS idx_recall_events_created ON recall_events(created_at);
  `);

  // ========================================================================
  // Area 9: Composite indexes for frequent query patterns
  // ========================================================================

  // Composite index for memory type + source_type filtering (common in recall queries)
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_type_source_type ON memories(type, source_type)`,
    'idx_memories_type_source_type'
  );

  // Composite index for active memories ordered by creation (most common list query)
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_active_created ON memories(invalidated_by, created_at DESC)`,
    'idx_memories_active_created'
  );

  // Composite index for temporal validity filtering
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_temporal ON memories(valid_from, valid_until)`,
    'idx_memories_temporal'
  );

  // Composite index for document file_path + updated_at (deletion and staleness queries)
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_documents_filepath_updated ON documents(file_path, updated_at)`,
    'idx_documents_filepath_updated'
  );

  // ========================================================================
  // Area 10: Memory mutation audit trail
  // ========================================================================
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      old_content TEXT,
      new_content TEXT,
      changed_by TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_memory_audit_memory_id ON memory_audit(memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_audit_event_type ON memory_audit(event_type);
    CREATE INDEX IF NOT EXISTS idx_memory_audit_created_at ON memory_audit(created_at);
  `);

  // Migration: add source_context column for memory-then-chunk retrieval
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN source_context TEXT DEFAULT NULL`,
    'memories.source_context'
  );

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
  getConfig();
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
      logWarn(
        'db-schema',
        `Embedding model changed: ${stored.value} (dim=${storedDim}) -> ${currentModel} (dim=${currentDim})`
      );
      logWarn(
        'db-schema',
        'Dimensions are incompatible — existing embeddings will not work correctly'
      );
      logWarn('db-schema', 'Run "succ reindex" to regenerate all embeddings with the new model');
    } else if (stored.value !== currentModel) {
      // Same dimension but different model - still should reindex for accuracy
      logWarn(
        'db-schema',
        `Embedding model changed: ${stored.value} -> ${currentModel} (same dimension=${currentDim})`
      );
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

  // Check if migration is needed:
  // 1. Table empty but memories exist (initial migration)
  // 2. Dimensions changed since last migration
  let needsMemoriesMigration = false;
  let memoriesDimChange = false; // true = old embeddings are wrong dims, skip re-insertion
  if (vecMemoriesExists) {
    if (vecMemoriesMigrated && Number(vecMemoriesMigrated.value) !== dims) {
      // Dimensions changed — recreate vec table (old embeddings are incompatible)
      logWarn(
        'sqlite-vec',
        `vec_memories dimension change: ${vecMemoriesMigrated.value} -> ${dims}. Recreating. Re-indexing required.`
      );
      needsMemoriesMigration = true;
      memoriesDimChange = true;
    } else if (!vecMemoriesMigrated) {
      // Legacy table: created before migration-flag mechanism was added.
      // Recreate with current dimensions — old embeddings are likely wrong dims.
      logWarn('sqlite-vec', `vec_memories missing migration flag — recreating with ${dims} dims`);
      needsMemoriesMigration = true;
      memoriesDimChange = true;
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
      database
        .prepare(
          `
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          embedding float[${dims}] distance_metric=cosine
        )
      `
        )
        .run();

      // Create mapping table: vec rowid -> memory id
      database
        .prepare(
          `
        CREATE TABLE IF NOT EXISTS vec_memories_map (
          vec_rowid INTEGER PRIMARY KEY,
          memory_id INTEGER NOT NULL UNIQUE
        )
      `
        )
        .run();

      // Migrate existing embeddings (only if same dimensions — skip on dim change)
      if (!memoriesDimChange) {
        const memories = database
          .prepare('SELECT id, embedding FROM memories WHERE embedding IS NOT NULL ORDER BY id')
          .all() as Array<{ id: number; embedding: Buffer }>;

        if (memories.length > 0) {
          const insertVec = database.prepare('INSERT INTO vec_memories(embedding) VALUES (?)');
          const insertMap = database.prepare(
            'INSERT INTO vec_memories_map(vec_rowid, memory_id) VALUES (?, ?)'
          );

          const migrate = database.transaction(() => {
            for (const mem of memories) {
              const result = insertVec.run(mem.embedding);
              insertMap.run(result.lastInsertRowid, mem.id);
            }
          });
          migrate();
        }
      }

      // Store persistent migration flag to prevent re-running
      database
        .prepare(
          "INSERT OR REPLACE INTO metadata (key, value) VALUES ('vec_memories_migrated_dims', ?)"
        )
        .run(String(dims));
    } catch (err) {
      logWarn('schema', 'vec_memories table creation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
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

  // Check if migration is needed for documents:
  // 1. Table empty but documents exist (initial migration)
  // 2. Dimensions changed since last migration
  let needsDocumentsMigration = false;
  let documentsDimChange = false;
  if (vecDocumentsExists && sqliteVecAvailable) {
    if (vecDocumentsMigrated && Number(vecDocumentsMigrated.value) !== dims) {
      logWarn(
        'sqlite-vec',
        `vec_documents dimension change: ${vecDocumentsMigrated.value} -> ${dims}. Recreating. Re-indexing required.`
      );
      needsDocumentsMigration = true;
      documentsDimChange = true;
    } else if (!vecDocumentsMigrated) {
      // Legacy table: created before migration-flag mechanism was added.
      // Recreate with current dimensions — old embeddings are likely wrong dims.
      logWarn('sqlite-vec', `vec_documents missing migration flag — recreating with ${dims} dims`);
      needsDocumentsMigration = true;
      documentsDimChange = true;
    }
  }

  if ((!vecDocumentsExists || needsDocumentsMigration) && sqliteVecAvailable) {
    try {
      if (needsDocumentsMigration) {
        database.prepare('DROP TABLE IF EXISTS vec_documents').run();
        database.prepare('DROP TABLE IF EXISTS vec_documents_map').run();
      }

      // Create vec0 virtual table for documents
      database
        .prepare(
          `
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_documents USING vec0(
          embedding float[${dims}] distance_metric=cosine
        )
      `
        )
        .run();

      // Create mapping table: vec rowid -> document id
      database
        .prepare(
          `
        CREATE TABLE IF NOT EXISTS vec_documents_map (
          vec_rowid INTEGER PRIMARY KEY,
          doc_id INTEGER NOT NULL UNIQUE
        )
      `
        )
        .run();

      // Migrate existing embeddings (only if same dimensions — skip on dim change)
      if (!documentsDimChange) {
        const docs = database
          .prepare(
            'SELECT id, embedding FROM documents WHERE embedding IS NOT NULL AND superseded_at IS NULL ORDER BY id'
          )
          .all() as Array<{ id: number; embedding: Buffer }>;

        if (docs.length > 0) {
          const insertVec = database.prepare('INSERT INTO vec_documents(embedding) VALUES (?)');
          const insertMap = database.prepare(
            'INSERT INTO vec_documents_map(vec_rowid, doc_id) VALUES (?, ?)'
          );

          const migrate = database.transaction(() => {
            for (const doc of docs) {
              const result = insertVec.run(doc.embedding);
              insertMap.run(result.lastInsertRowid, doc.id);
            }
          });
          migrate();
        }
      }

      // Store persistent migration flag to prevent re-running
      database
        .prepare(
          "INSERT OR REPLACE INTO metadata (key, value) VALUES ('vec_documents_migrated_dims', ?)"
        )
        .run(String(dims));
    } catch (err) {
      logWarn('schema', 'vec_documents table creation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
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
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN type TEXT DEFAULT 'observation'`,
    'global memories.type'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_global_memories_type ON memories(type)`,
    'idx_global_memories_type'
  );

  // Migration: add quality_score and quality_factors columns
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN quality_score REAL`,
    'global memories.quality_score'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN quality_factors TEXT`,
    'global memories.quality_factors'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_global_memories_quality ON memories(quality_score)`,
    'idx_global_memories_quality'
  );

  // Migration: add access_count and last_accessed columns for retention decay
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN access_count REAL DEFAULT 0`,
    'global memories.access_count'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN last_accessed TEXT`,
    'global memories.last_accessed'
  );

  // Migration: add valid_from and valid_until columns for temporal awareness
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN valid_from TEXT`,
    'global memories.valid_from'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN valid_until TEXT`,
    'global memories.valid_until'
  );

  // Migration: add provenance columns to global memories
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN confidence REAL DEFAULT 0.5`,
    'global memories.confidence'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN source_type TEXT DEFAULT 'human'`,
    'global memories.source_type'
  );

  // Migration: add invalidated_by column for soft-delete during consolidation
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN invalidated_by INTEGER`,
    'global memories.invalidated_by'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_global_memories_invalidated_by ON memories(invalidated_by)`,
    'idx_global_memories_invalidated_by'
  );

  // Migration: add forget_after column for automatic memory forgetting
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN forget_after TEXT DEFAULT NULL`,
    'global memories.forget_after'
  );

  // Backfill forget_after for existing auto-extracted global memories.
  // Idempotent: `forget_after IS NULL` skips already-backfilled rows.
  // High-confidence (promoted) memories keep NULL forget_after (= permanent).
  try {
    database.exec(`
      UPDATE memories
      SET forget_after = datetime(created_at, '+90 days')
      WHERE source_type = 'auto_extracted'
        AND forget_after IS NULL
        AND (confidence IS NULL OR confidence < 0.7)
    `);
  } catch (backfillErr) {
    logWarn('schema', `global forget_after backfill skipped: ${getErrorMessage(backfillErr)}`);
  }

  // Migration: add correction_count and is_invariant columns for working memory pins
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN correction_count INTEGER DEFAULT 0`,
    'global memories.correction_count'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN is_invariant INTEGER DEFAULT 0`,
    'global memories.is_invariant'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(correction_count, is_invariant)`,
    'idx_global_memories_pinned'
  );

  // Migration: add priority_score column for working memory ranking
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN priority_score REAL DEFAULT NULL`,
    'global memories.priority_score'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(priority_score DESC)`,
    'idx_global_memories_priority'
  );

  // ========================================================================
  // Area 9: Composite indexes for frequent query patterns (global DB)
  // ========================================================================

  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_global_memories_type_source_type ON memories(type, source_type)`,
    'idx_global_memories_type_source_type'
  );

  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_global_memories_active_created ON memories(invalidated_by, created_at DESC)`,
    'idx_global_memories_active_created'
  );

  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_global_memories_temporal ON memories(valid_from, valid_until)`,
    'idx_global_memories_temporal'
  );

  // Area 10: Memory mutation audit trail (must mirror initDb)
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      old_content TEXT,
      new_content TEXT,
      changed_by TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_memory_audit_memory_id ON memory_audit(memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_audit_event_type ON memory_audit(event_type);
    CREATE INDEX IF NOT EXISTS idx_memory_audit_created_at ON memory_audit(created_at);
  `);

  // Migration: add source_context column for memory-then-chunk retrieval
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN source_context TEXT DEFAULT NULL`,
    'global memories.source_context'
  );

  // Migration: add memory versioning columns
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN version INTEGER DEFAULT 1`,
    'global memories.version'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN parent_memory_id INTEGER DEFAULT NULL`,
    'global memories.parent_memory_id'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN root_memory_id INTEGER DEFAULT NULL`,
    'global memories.root_memory_id'
  );
  safeMigrate(
    database,
    `ALTER TABLE memories ADD COLUMN is_latest INTEGER DEFAULT 1`,
    'global memories.is_latest'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_is_latest ON memories(is_latest)`,
    'idx_global_memories_is_latest'
  );
  safeMigrate(
    database,
    `CREATE INDEX IF NOT EXISTS idx_memories_root ON memories(root_memory_id)`,
    'idx_global_memories_root'
  );

  // Migration: create sqlite-vec virtual table for global memories
  initGlobalVecTable(database);
}

/**
 * Initialize sqlite-vec virtual table for global memories
 */
export function initGlobalVecTable(database: Database.Database): void {
  if (!sqliteVecAvailable) return;

  const configDims = getConfig().llm?.embeddings?.dimensions;
  const dims = configDims ?? getModelDimension(getLLMTaskConfig('embeddings').model) ?? 384;

  const vecMemoriesExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_memories'")
    .get();

  // Check persistent migration flag
  const vecMigrated = database
    .prepare("SELECT value FROM metadata WHERE key = 'vec_memories_migrated_dims'")
    .get() as { value: string } | undefined;

  // Check if migration is needed — skip if persistent flag matches current dims
  let needsMigration = false;
  let dimChange = false;
  if (vecMemoriesExists) {
    if (vecMigrated && Number(vecMigrated.value) !== dims) {
      logWarn(
        'sqlite-vec',
        `global vec_memories dimension change: ${vecMigrated.value} -> ${dims}. Recreating.`
      );
      needsMigration = true;
      dimChange = true;
    } else if (!vecMigrated) {
      // Legacy table: recreate with current dimensions
      logWarn(
        'sqlite-vec',
        `global vec_memories missing migration flag — recreating with ${dims} dims`
      );
      needsMigration = true;
      dimChange = true;
    }
  }

  if (!vecMemoriesExists || needsMigration) {
    try {
      if (needsMigration) {
        database.prepare('DROP TABLE IF EXISTS vec_memories').run();
        database.prepare('DROP TABLE IF EXISTS vec_memories_map').run();
      }

      // Create vec0 virtual table (simple schema)
      database
        .prepare(
          `
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          embedding float[${dims}] distance_metric=cosine
        )
      `
        )
        .run();

      // Create mapping table
      database
        .prepare(
          `
        CREATE TABLE IF NOT EXISTS vec_memories_map (
          vec_rowid INTEGER PRIMARY KEY,
          memory_id INTEGER NOT NULL UNIQUE
        )
      `
        )
        .run();

      // Migrate existing embeddings (skip on dim change — old embeddings are incompatible)
      if (!dimChange) {
        const memories = database
          .prepare('SELECT id, embedding FROM memories WHERE embedding IS NOT NULL ORDER BY id')
          .all() as Array<{ id: number; embedding: Buffer }>;

        if (memories.length > 0) {
          const insertVec = database.prepare('INSERT INTO vec_memories(embedding) VALUES (?)');
          const insertMap = database.prepare(
            'INSERT INTO vec_memories_map(vec_rowid, memory_id) VALUES (?, ?)'
          );

          const migrate = database.transaction(() => {
            for (const mem of memories) {
              const result = insertVec.run(mem.embedding);
              insertMap.run(result.lastInsertRowid, mem.id);
            }
          });
          migrate();
        }
      }

      // Store persistent migration flag
      database
        .prepare(
          "INSERT OR REPLACE INTO metadata (key, value) VALUES ('vec_memories_migrated_dims', ?)"
        )
        .run(String(dims));
    } catch (err) {
      logWarn('schema', 'global vec_memories table creation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
