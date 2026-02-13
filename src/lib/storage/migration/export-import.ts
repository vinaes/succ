/**
 * Data export/import utilities for storage migration.
 *
 * Supports:
 * - JSON export of all data (documents, memories, links, etc.)
 * - JSON import to restore data
 * - Migration between backends (SQLite -> PostgreSQL, etc.)
 */

import fs from 'fs';
import { getDb, getGlobalDb } from '../../db/connection.js';
/**
 * Export format version for compatibility checking
 */
const EXPORT_VERSION = '1.0';

/**
 * Full export data structure
 */
export interface ExportData {
  version: string;
  exportedAt: string;
  metadata: {
    backend: string;
    embeddingModel?: string;
  };
  documents: Array<{
    id: number;
    file_path: string;
    chunk_index: number;
    content: string;
    start_line: number;
    end_line: number;
    embedding: number[];
    created_at: string;
    updated_at: string;
  }>;
  fileHashes: Array<{
    file_path: string;
    content_hash: string;
    indexed_at: string;
  }>;
  memories: Array<{
    id: number;
    content: string;
    tags: string[] | null;
    source: string | null;
    type: string | null;
    quality_score: number | null;
    quality_factors: Record<string, number> | null;
    embedding: number[];
    access_count: number;
    last_accessed: string | null;
    valid_from: string | null;
    valid_until: string | null;
    created_at: string;
  }>;
  memoryLinks: Array<{
    id: number;
    source_id: number;
    target_id: number;
    relation: string;
    weight: number;
    valid_from: string | null;
    valid_until: string | null;
    created_at: string;
  }>;
  globalMemories: Array<{
    id: number;
    content: string;
    tags: string[] | null;
    source: string | null;
    project: string | null;
    type: string | null;
    quality_score: number | null;
    quality_factors: Record<string, number> | null;
    embedding: number[];
    created_at: string;
  }>;
  tokenFrequencies: Array<{
    token: string;
    frequency: number;
  }>;
  tokenStats: Array<{
    event_type: string;
    query: string | null;
    returned_tokens: number;
    full_source_tokens: number;
    savings_tokens: number;
    files_count: number | null;
    chunks_count: number | null;
    model: string | null;
    estimated_cost: number;
    created_at: string;
  }>;
}

/**
 * Convert Buffer to number[] for JSON export
 */
function bufferToArray(buffer: Buffer): number[] {
  const aligned = Buffer.from(buffer);
  const floatArray = new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    aligned.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  return Array.from(floatArray);
}

/**
 * Export all data from the current storage backend.
 */
export function exportData(): ExportData {
  const db = getDb();
  let globalDb;
  try {
    globalDb = getGlobalDb();
  } catch {
    // Global DB might not exist
    globalDb = null;
  }

  // Get embedding model from metadata
  const embeddingModelRow = db
    .prepare("SELECT value FROM metadata WHERE key = 'embedding_model'")
    .get() as { value: string } | undefined;

  // Export documents
  const documents = db
    .prepare(
      `
    SELECT id, file_path, chunk_index, content, start_line, end_line, embedding, created_at, updated_at
    FROM documents
  `
    )
    .all() as Array<{
    id: number;
    file_path: string;
    chunk_index: number;
    content: string;
    start_line: number;
    end_line: number;
    embedding: Buffer;
    created_at: string;
    updated_at: string;
  }>;

  // Export file hashes
  const fileHashes = db
    .prepare(
      `
    SELECT file_path, content_hash, indexed_at
    FROM file_hashes
  `
    )
    .all() as Array<{
    file_path: string;
    content_hash: string;
    indexed_at: string;
  }>;

  // Export memories
  const memories = db
    .prepare(
      `
    SELECT id, content, tags, source, type, quality_score, quality_factors, embedding,
           access_count, last_accessed, valid_from, valid_until, created_at
    FROM memories
  `
    )
    .all() as Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    type: string | null;
    quality_score: number | null;
    quality_factors: string | null;
    embedding: Buffer;
    access_count: number | null;
    last_accessed: string | null;
    valid_from: string | null;
    valid_until: string | null;
    created_at: string;
  }>;

  // Export memory links
  const memoryLinks = db
    .prepare(
      `
    SELECT id, source_id, target_id, relation, weight, valid_from, valid_until, created_at
    FROM memory_links
  `
    )
    .all() as Array<{
    id: number;
    source_id: number;
    target_id: number;
    relation: string;
    weight: number;
    valid_from: string | null;
    valid_until: string | null;
    created_at: string;
  }>;

  // Export global memories
  let globalMemories: Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    project: string | null;
    type: string | null;
    quality_score: number | null;
    quality_factors: string | null;
    embedding: Buffer;
    created_at: string;
  }> = [];

  if (globalDb) {
    globalMemories = globalDb
      .prepare(
        `
      SELECT id, content, tags, source, project, type, quality_score, quality_factors, embedding, created_at
      FROM memories
    `
      )
      .all() as typeof globalMemories;
  }

  // Export token frequencies
  const tokenFrequencies = db
    .prepare(
      `
    SELECT token, frequency
    FROM token_frequencies
  `
    )
    .all() as Array<{
    token: string;
    frequency: number;
  }>;

  // Export token stats
  const tokenStats = db
    .prepare(
      `
    SELECT event_type, query, returned_tokens, full_source_tokens, savings_tokens,
           files_count, chunks_count, model, estimated_cost, created_at
    FROM token_stats
  `
    )
    .all() as Array<{
    event_type: string;
    query: string | null;
    returned_tokens: number;
    full_source_tokens: number;
    savings_tokens: number;
    files_count: number | null;
    chunks_count: number | null;
    model: string | null;
    estimated_cost: number;
    created_at: string;
  }>;

  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    metadata: {
      backend: 'sqlite',
      embeddingModel: embeddingModelRow?.value,
    },
    documents: documents.map((d) => ({
      ...d,
      embedding: bufferToArray(d.embedding),
    })),
    fileHashes,
    memories: memories.map((m) => ({
      ...m,
      tags: m.tags ? JSON.parse(m.tags) : null,
      quality_factors: m.quality_factors ? JSON.parse(m.quality_factors) : null,
      embedding: bufferToArray(m.embedding),
      access_count: m.access_count ?? 0,
    })),
    memoryLinks,
    globalMemories: globalMemories.map((m) => ({
      ...m,
      tags: m.tags ? JSON.parse(m.tags) : null,
      quality_factors: m.quality_factors ? JSON.parse(m.quality_factors) : null,
      embedding: bufferToArray(m.embedding),
    })),
    tokenFrequencies,
    tokenStats,
  };
}

/**
 * Export data to a JSON file.
 */
export function exportToFile(filePath: string): void {
  const data = exportData();
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, json, 'utf-8');
}

/**
 * Import data from export format.
 * This is a destructive operation that replaces existing data.
 */
export function importData(data: ExportData): {
  documents: number;
  memories: number;
  memoryLinks: number;
  globalMemories: number;
} {
  if (data.version !== EXPORT_VERSION) {
    throw new Error(`Unsupported export version: ${data.version}. Expected: ${EXPORT_VERSION}`);
  }

  const db = getDb();
  let globalDb;
  try {
    globalDb = getGlobalDb();
  } catch {
    globalDb = null;
  }

  // Clear existing data (using database.exec with explicit SQL statements)
  const clearStmts = [
    'DELETE FROM memory_links',
    'DELETE FROM memories',
    'DELETE FROM documents',
    'DELETE FROM file_hashes',
    'DELETE FROM token_frequencies',
    'DELETE FROM token_stats',
  ];

  for (const stmt of clearStmts) {
    db.prepare(stmt).run();
  }

  // Import documents
  const docStmt = db.prepare(`
    INSERT INTO documents (id, file_path, chunk_index, content, start_line, end_line, embedding, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const doc of data.documents) {
    const embeddingBlob = Buffer.from(new Float32Array(doc.embedding).buffer);
    docStmt.run(
      doc.id,
      doc.file_path,
      doc.chunk_index,
      doc.content,
      doc.start_line,
      doc.end_line,
      embeddingBlob,
      doc.created_at,
      doc.updated_at
    );
  }

  // Import file hashes
  const hashStmt = db.prepare(`
    INSERT INTO file_hashes (file_path, content_hash, indexed_at)
    VALUES (?, ?, ?)
  `);

  for (const hash of data.fileHashes) {
    hashStmt.run(hash.file_path, hash.content_hash, hash.indexed_at);
  }

  // Import memories
  const memStmt = db.prepare(`
    INSERT INTO memories (id, content, tags, source, type, quality_score, quality_factors, embedding, access_count, last_accessed, valid_from, valid_until, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const mem of data.memories) {
    const embeddingBlob = Buffer.from(new Float32Array(mem.embedding).buffer);
    memStmt.run(
      mem.id,
      mem.content,
      mem.tags ? JSON.stringify(mem.tags) : null,
      mem.source,
      mem.type,
      mem.quality_score,
      mem.quality_factors ? JSON.stringify(mem.quality_factors) : null,
      embeddingBlob,
      mem.access_count,
      mem.last_accessed,
      mem.valid_from,
      mem.valid_until,
      mem.created_at
    );
  }

  // Import memory links
  const linkStmt = db.prepare(`
    INSERT INTO memory_links (id, source_id, target_id, relation, weight, valid_from, valid_until, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const link of data.memoryLinks) {
    linkStmt.run(
      link.id,
      link.source_id,
      link.target_id,
      link.relation,
      link.weight,
      link.valid_from,
      link.valid_until,
      link.created_at
    );
  }

  // Import global memories
  let globalMemoriesImported = 0;
  if (globalDb && data.globalMemories.length > 0) {
    globalDb.prepare('DELETE FROM memories').run();

    const globalMemStmt = globalDb.prepare(`
      INSERT INTO memories (id, content, tags, source, project, type, quality_score, quality_factors, embedding, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const mem of data.globalMemories) {
      const embeddingBlob = Buffer.from(new Float32Array(mem.embedding).buffer);
      globalMemStmt.run(
        mem.id,
        mem.content,
        mem.tags ? JSON.stringify(mem.tags) : null,
        mem.source,
        mem.project,
        mem.type,
        mem.quality_score,
        mem.quality_factors ? JSON.stringify(mem.quality_factors) : null,
        embeddingBlob,
        mem.created_at
      );
      globalMemoriesImported++;
    }
  }

  // Import token frequencies
  const freqStmt = db.prepare(`
    INSERT INTO token_frequencies (token, frequency)
    VALUES (?, ?)
  `);

  for (const freq of data.tokenFrequencies) {
    freqStmt.run(freq.token, freq.frequency);
  }

  // Import token stats
  const statsStmt = db.prepare(`
    INSERT INTO token_stats (event_type, query, returned_tokens, full_source_tokens, savings_tokens, files_count, chunks_count, model, estimated_cost, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const stat of data.tokenStats) {
    statsStmt.run(
      stat.event_type,
      stat.query,
      stat.returned_tokens,
      stat.full_source_tokens,
      stat.savings_tokens,
      stat.files_count,
      stat.chunks_count,
      stat.model,
      stat.estimated_cost,
      stat.created_at
    );
  }

  // Update embedding model metadata
  if (data.metadata.embeddingModel) {
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('embedding_model', ?)").run(
      data.metadata.embeddingModel
    );
  }

  return {
    documents: data.documents.length,
    memories: data.memories.length,
    memoryLinks: data.memoryLinks.length,
    globalMemories: globalMemoriesImported,
  };
}

/**
 * Import data from a JSON file.
 */
export function importFromFile(filePath: string): {
  documents: number;
  memories: number;
  memoryLinks: number;
  globalMemories: number;
} {
  const json = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(json) as ExportData;
  return importData(data);
}

/**
 * Get export file stats without importing.
 */
export function getExportStats(filePath: string): {
  version: string;
  exportedAt: string;
  backend: string;
  embeddingModel?: string;
  counts: {
    documents: number;
    memories: number;
    memoryLinks: number;
    globalMemories: number;
    tokenFrequencies: number;
    tokenStats: number;
  };
} {
  const json = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(json) as ExportData;

  return {
    version: data.version,
    exportedAt: data.exportedAt,
    backend: data.metadata.backend,
    embeddingModel: data.metadata.embeddingModel,
    counts: {
      documents: data.documents.length,
      memories: data.memories.length,
      memoryLinks: data.memoryLinks.length,
      globalMemories: data.globalMemories.length,
      tokenFrequencies: data.tokenFrequencies.length,
      tokenStats: data.tokenStats.length,
    },
  };
}
