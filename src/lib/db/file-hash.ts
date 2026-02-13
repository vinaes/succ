import { getDb } from './connection.js';

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
    .prepare(
      `
      INSERT INTO file_hashes (file_path, content_hash, indexed_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(file_path) DO UPDATE SET
        content_hash = excluded.content_hash,
        indexed_at = CURRENT_TIMESTAMP
    `
    )
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
  const rows = database.prepare('SELECT file_path, content_hash FROM file_hashes').all() as Array<{
    file_path: string;
    content_hash: string;
  }>;

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.file_path, row.content_hash);
  }
  return map;
}

/**
 * Get all stored file hashes with indexed_at timestamps.
 * Used for freshness checks — compare file mtime against indexed_at.
 */
export function getAllFileHashesWithTimestamps(): Array<{
  file_path: string;
  content_hash: string;
  indexed_at: string;
}> {
  const database = getDb();
  return database
    .prepare('SELECT file_path, content_hash, indexed_at FROM file_hashes')
    .all() as Array<{ file_path: string; content_hash: string; indexed_at: string }>;
}
