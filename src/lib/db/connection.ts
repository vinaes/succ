import Database from 'better-sqlite3';
import { getDbPath, getGlobalDbPath } from '../config.js';
import { initDb, initGlobalDb, loadSqliteVec } from './schema.js';

let db: Database.Database | null = null;
let globalDb: Database.Database | null = null;

// Callbacks invoked when DB is swapped via setDb(). Avoids circular imports.
const onDbChangeCallbacks: Array<() => void> = [];

// ---------- Prepared statement cache ----------

// Per-database statement caches. Keyed by SQL string.
const stmtCacheLocal = new Map<string, Database.Statement>();
const stmtCacheGlobal = new Map<string, Database.Statement>();

/**
 * Get a cached prepared statement for the local DB.
 * Avoids re-preparing the same SQL on every function call.
 * Cache is auto-cleared when setDb()/closeDb() is called.
 */
export function cachedPrepare(sql: string): Database.Statement {
  let stmt = stmtCacheLocal.get(sql);
  if (!stmt) {
    stmt = getDb().prepare(sql);
    stmtCacheLocal.set(sql, stmt);
  }
  return stmt;
}

/**
 * Get a cached prepared statement for the global DB.
 * Cache is auto-cleared when closeGlobalDb() is called.
 */
export function cachedPrepareGlobal(sql: string): Database.Statement {
  let stmt = stmtCacheGlobal.get(sql);
  if (!stmt) {
    stmt = getGlobalDb().prepare(sql);
    stmtCacheGlobal.set(sql, stmt);
  }
  return stmt;
}

/**
 * Register a callback to run when setDb() swaps the database.
 * Used by bm25-indexes.ts to flush cached indexes.
 */
export function onDbChange(callback: () => void): void {
  onDbChangeCallbacks.push(callback);
}
/**
 * Apply SQLite performance tuning PRAGMAs.
 * Safe with WAL mode; optimizes for read-heavy workloads.
 */
export function applySqliteTuning(database: Database.Database): void {
  database.pragma('busy_timeout = 5000');
  database.pragma('cache_size = -16000');    // 16MB cache (default ~2MB)
  database.pragma('mmap_size = 67108864');   // 64MB memory-mapped I/O
  database.pragma('synchronous = NORMAL');   // Safe with WAL, skip fsync wait
  database.pragma('temp_store = MEMORY');    // Temp tables in RAM
}

/**
 * Get the local database instance (synchronous, lazy initialization).
 * Safe for Node.js single-threaded model - no async race conditions possible.
 */
export function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath());
    db.pragma('journal_mode = WAL');
    applySqliteTuning(db);
    loadSqliteVec(db);
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
    globalDb.pragma('journal_mode = WAL');
    applySqliteTuning(globalDb);
    loadSqliteVec(globalDb);
    initGlobalDb(globalDb);
  }
  return globalDb;
}

/**
 * Override the local database singleton with an external instance.
 * Used by benchmarks, tests, and any code that needs an isolated DB.
 * Flushes cached BM25 indexes since they reference the old DB.
 * Call closeDb() to revert to default lazy-init behavior.
 */
export function setDb(database: Database.Database): void {
  db = database;
  stmtCacheLocal.clear();
  for (const cb of onDbChangeCallbacks) cb();
}

/**
 * Close the local database connection
 */
export function closeDb(): void {
  stmtCacheLocal.clear();
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Close the global database connection
 */
export function closeGlobalDb(): void {
  stmtCacheGlobal.clear();
  if (globalDb) {
    globalDb.close();
    globalDb = null;
  }
}
