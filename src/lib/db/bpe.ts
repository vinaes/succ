/**
 * BPE SQLite persistence — raw database operations for BPE vocabulary.
 *
 * BPE tables only exist in SQLite (not PostgreSQL).
 * All functions are guarded by isPostgresBackend() checks.
 */

import { getDb } from './connection.js';

export interface BPEVocabRow {
  merges: string;
  vocab: string;
  vocab_size: number;
  corpus_size: number;
  trained_at: string;
}

export function initBPESchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS bpe_vocab (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      merges TEXT NOT NULL,
      vocab TEXT NOT NULL,
      vocab_size INTEGER NOT NULL,
      corpus_size INTEGER NOT NULL,
      trained_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bpe_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function saveBPEVocabToDb(
  mergesJson: string,
  vocabJson: string,
  vocabSize: number,
  corpusSize: number,
  trainedAt: string
): void {
  initBPESchema();
  const db = getDb();

  db.prepare(
    `INSERT INTO bpe_vocab (merges, vocab, vocab_size, corpus_size, trained_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(mergesJson, vocabJson, vocabSize, corpusSize, trainedAt);

  db.prepare('INSERT OR REPLACE INTO bpe_metadata (key, value) VALUES (?, ?)').run(
    'last_trained',
    trainedAt
  );
}

export function loadBPEVocabFromDb(): BPEVocabRow | null {
  initBPESchema();
  const db = getDb();

  return db.prepare('SELECT * FROM bpe_vocab ORDER BY id DESC LIMIT 1').get() as BPEVocabRow | null;
}

export function getLastBPETrainTimeFromDb(): string | null {
  initBPESchema();
  const db = getDb();

  const row = db.prepare('SELECT value FROM bpe_metadata WHERE key = ?').get('last_trained') as {
    value: string;
  } | null;

  return row?.value ?? null;
}
