import Database from 'better-sqlite3';
import { getDbPath, getGlobalDbPath } from '../config.js';
import { initDb, initGlobalDb, loadSqliteVec } from './schema.js';

let db: Database.Database | null = null;
let globalDb: Database.Database | null = null;
/**
 * Apply SQLite performance tuning PRAGMAs.
 * Safe with WAL mode; optimizes for read-heavy workloads.
 */
function applySqliteTuning(database: Database.Database): void {
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
 * Close the local database connection
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Close the global database connection
 */
export function closeGlobalDb(): void {
  if (globalDb) {
    globalDb.close();
    globalDb = null;
  }
}
