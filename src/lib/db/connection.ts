import Database from 'better-sqlite3';
import { getDbPath, getGlobalDbPath } from '../config.js';
import { initDb, initGlobalDb, loadSqliteVec } from './schema.js';

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
    // WAL mode for better concurrent access from multiple MCP processes
    globalDb.pragma('journal_mode = WAL');
    globalDb.pragma('busy_timeout = 5000'); // 5 second timeout for locked database
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
