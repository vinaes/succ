import Database from 'better-sqlite3';
import { getDbPath } from './config.js';
import { cosineSimilarity } from './embeddings.js';

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

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath());
    initDb(db);
  }
  return db;
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
    const embedding = Array.from(new Float32Array(row.embedding.buffer));
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
