/**
 * Export and backfill operations for StorageDispatcher.
 *
 * These are large, infrequently-used methods extracted to a separate module
 * to reduce the size of dispatcher.ts. They are loaded on-demand when needed.
 *
 * Methods:
 * - getAllMemoriesForExport()
 * - getAllDocumentsForExport()
 * - getAllMemoryLinksForExport()
 * - getAllCentralityForExport()
 * - bulkRestore()
 * - backfillQdrant() + helper methods (backfillMemories, backfillGlobalMemories, backfillDocuments)
 */

import type { StorageDispatcher } from './dispatcher.js';
import { ConfigError } from '../errors.js';

// Internal SQL query result types (mirrors dispatcher.ts)
interface SqlMemoryRow {
  id: number;
  content: string;
  tags: string | null;
  source: string | null;
  type: string | null;
  quality_score: number | null;
  quality_factors: string | null;
  access_count: number;
  last_accessed: string | null;
  valid_from: string | null;
  valid_until: string | null;
  invalidated_by: number | null;
  created_at: string;
  embedding?: Buffer | null;
}

interface SqlMemoryWithEmbedding extends SqlMemoryRow {
  embedding: Buffer;
}

interface SqlDocumentRow {
  id: number;
  file_path: string;
  content: string;
  start_line: number;
  end_line: number;
  embedding?: Buffer | null;
}

interface SqlDocumentWithEmbedding extends SqlDocumentRow {
  embedding: Buffer;
}

// Helper function to parse PG vector string '[1.0,2.0,3.0]' to number[]
function parsePgVector(str: string | null): number[] | null {
  if (!str || typeof str !== 'string') return null;
  const inner = str.slice(1, -1);
  if (!inner) return [];
  return inner.split(',').map((s) => parseFloat(s.trim()));
}

// Helper to get getSqliteFns() from dispatcher
async function getSqliteFns(d: StorageDispatcher): Promise<typeof import('../db/index.js')> {
  return (d as any).getSqliteFns();
}

// =============================================================================
// Export Methods
// =============================================================================

export async function getAllMemoriesForExportImpl(d: StorageDispatcher): Promise<
  Array<{
    id: number;
    content: string;
    tags: string[];
    source: string | null;
    embedding: number[] | null;
    type: string | null;
    quality_score: number | null;
    quality_factors: Record<string, number> | null;
    access_count: number;
    last_accessed: string | null;
    created_at: string;
    invalidated_by: number | null;
  }>
> {
  interface MemoryExportRow {
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    embedding: string | Buffer | null;
    type: string | null;
    quality_score: number | null;
    quality_factors: string | null;
    access_count: number;
    last_accessed: string | null;
    created_at: string;
    invalidated_by: number | null;
  }

  const backend = (d as any).backend as 'sqlite' | 'postgresql';
  const postgres = (d as any).postgres;

  if (backend === 'postgresql' && postgres) {
    const pool = await postgres.getPool();
    const scopeCond = postgres.getProjectId()
      ? 'WHERE LOWER(project_id) = $1 AND invalidated_by IS NULL'
      : 'WHERE project_id IS NULL AND invalidated_by IS NULL';
    const params = postgres.getProjectId() ? [postgres.getProjectId()] : [];
    const result = await pool.query(
      `SELECT id, content, tags, source, embedding::text as embedding, type,
              quality_score, quality_factors, access_count,
              last_accessed::text as last_accessed, created_at::text as created_at,
              invalidated_by
       FROM memories ${scopeCond}
       ORDER BY id ASC`,
      params
    );
    const rows = result.rows as MemoryExportRow[];
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags ?? []),
      source: r.source ?? null,
      embedding: typeof r.embedding === 'string' ? parsePgVector(r.embedding) : null,
      type: r.type ?? null,
      quality_score: r.quality_score ?? null,
      quality_factors: r.quality_factors
        ? typeof r.quality_factors === 'string'
          ? JSON.parse(r.quality_factors)
          : r.quality_factors
        : null,
      access_count: r.access_count ?? 0,
      last_accessed: r.last_accessed ?? null,
      created_at: r.created_at ?? new Date().toISOString(),
      invalidated_by: r.invalidated_by ?? null,
    }));
  }

  interface SqliteMemoryRow {
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    embedding: Buffer | null;
    type: string | null;
    quality_score: number | null;
    quality_factors: string | null;
    access_count: number;
    last_accessed: string | null;
    created_at: string;
    invalidated_by: number | null;
  }

  const sqlite = await getSqliteFns(d);
  const db = sqlite.getDb();
  const rows = db
    .prepare(
      `SELECT id, content, tags, source, embedding, type,
            quality_score, quality_factors, access_count, last_accessed, created_at, invalidated_by
     FROM memories ORDER BY id ASC`
    )
    .all() as SqliteMemoryRow[];
  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source: row.source,
    type: row.type,
    embedding: row.embedding
      ? Array.from(
          new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4
          )
        )
      : null,
    quality_score: row.quality_score,
    quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
    access_count: row.access_count ?? 0,
    last_accessed: row.last_accessed,
    created_at: row.created_at,
    invalidated_by: row.invalidated_by ?? null,
  }));
}

export async function getAllDocumentsForExportImpl(d: StorageDispatcher): Promise<
  Array<{
    id: number;
    file_path: string;
    chunk_index: number;
    content: string;
    start_line: number;
    end_line: number;
    embedding: number[] | null;
    created_at: string;
  }>
> {
  interface DocumentExportRow {
    id: number;
    file_path: string;
    chunk_index: number;
    content: string;
    start_line: number;
    end_line: number;
    embedding: string | Buffer | null;
    created_at: string;
  }

  const backend = (d as any).backend as 'sqlite' | 'postgresql';
  const postgres = (d as any).postgres;

  if (backend === 'postgresql' && postgres) {
    const pool = await postgres.getPool();
    const scopeCond = postgres.getProjectId()
      ? 'WHERE LOWER(project_id) = $1'
      : 'WHERE project_id IS NULL';
    const params = postgres.getProjectId() ? [postgres.getProjectId()] : [];
    const result = await pool.query(
      `SELECT id, file_path, chunk_index, content, start_line, end_line,
              embedding::text as embedding, created_at::text as created_at
       FROM documents ${scopeCond}
       ORDER BY id ASC`,
      params
    );
    const rows = result.rows as DocumentExportRow[];
    return rows.map((r) => ({
      id: r.id,
      file_path: r.file_path,
      chunk_index: r.chunk_index ?? 0,
      content: r.content,
      start_line: r.start_line ?? 0,
      end_line: r.end_line ?? 0,
      embedding: typeof r.embedding === 'string' ? parsePgVector(r.embedding) : null,
      created_at: r.created_at ?? new Date().toISOString(),
    }));
  }

  interface SqliteDocumentRow {
    id: number;
    file_path: string;
    chunk_index: number;
    content: string;
    start_line: number;
    end_line: number;
    embedding: Buffer | null;
    created_at: string;
  }

  const sqlite = await getSqliteFns(d);
  const db = sqlite.getDb();
  const rows = db
    .prepare(
      `SELECT id, file_path, chunk_index, content, start_line, end_line, embedding, created_at
     FROM documents ORDER BY id ASC`
    )
    .all() as SqliteDocumentRow[];
  return rows.map((row) => ({
    id: row.id,
    file_path: row.file_path,
    chunk_index: row.chunk_index,
    content: row.content,
    start_line: row.start_line,
    end_line: row.end_line,
    embedding: row.embedding
      ? Array.from(
          new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4
          )
        )
      : null,
    created_at: row.created_at,
  }));
}

export async function getAllMemoryLinksForExportImpl(d: StorageDispatcher): Promise<
  Array<{
    id: number;
    source_id: number;
    target_id: number;
    relation: string;
    weight: number;
    created_at: string;
    llm_enriched: boolean;
  }>
> {
  interface LinkRow {
    id: number;
    source_id: number;
    target_id: number;
    relation: string;
    weight: number;
    created_at: string;
    llm_enriched: number | boolean;
  }

  const backend = (d as any).backend as 'sqlite' | 'postgresql';
  const postgres = (d as any).postgres;

  if (backend === 'postgresql' && postgres) {
    const pool = await postgres.getPool();
    const scopeCond = postgres.getProjectId()
      ? 'WHERE LOWER(m.project_id) = $1 OR m.project_id IS NULL'
      : 'WHERE m.project_id IS NULL';
    const params = postgres.getProjectId() ? [postgres.getProjectId()] : [];
    const result = await pool.query(
      `SELECT ml.id, ml.source_id, ml.target_id, ml.relation, ml.weight,
              ml.created_at::text as created_at, COALESCE(ml.llm_enriched, 0) as llm_enriched
       FROM memory_links ml
       JOIN memories m ON ml.source_id = m.id
       ${scopeCond}
       ORDER BY ml.id ASC`,
      params
    );
    const rows = result.rows as LinkRow[];
    return rows.map((r) => ({ ...r, llm_enriched: !!r.llm_enriched }));
  }

  const sqlite = await getSqliteFns(d);
  const db = sqlite.getDb();
  const rows = db
    .prepare(
      `SELECT id, source_id, target_id, relation, weight, created_at,
            COALESCE(llm_enriched, 0) as llm_enriched
     FROM memory_links ORDER BY id ASC`
    )
    .all() as LinkRow[];
  return rows.map((r) => ({ ...r, llm_enriched: !!r.llm_enriched }));
}

export async function getAllCentralityForExportImpl(d: StorageDispatcher): Promise<
  Array<{
    memory_id: number;
    degree: number;
    normalized_degree: number;
    updated_at: string;
  }>
> {
  interface CentralityRow {
    memory_id: number;
    degree: number;
    normalized_degree: number;
    updated_at: string;
  }

  const backend = (d as any).backend as 'sqlite' | 'postgresql';
  const postgres = (d as any).postgres;

  if (backend === 'postgresql' && postgres) {
    const pool = await postgres.getPool();
    const scopeCond = postgres.getProjectId()
      ? 'WHERE LOWER(m.project_id) = $1 OR m.project_id IS NULL'
      : 'WHERE m.project_id IS NULL';
    const params = postgres.getProjectId() ? [postgres.getProjectId()] : [];
    const result = await pool.query(
      `SELECT mc.memory_id, mc.degree, mc.normalized_degree, mc.updated_at::text as updated_at
       FROM memory_centrality mc
       JOIN memories m ON mc.memory_id = m.id
       ${scopeCond}
       ORDER BY mc.memory_id ASC`,
      params
    );
    const rows = result.rows as CentralityRow[];
    return rows;
  }

  const sqlite = await getSqliteFns(d);
  const db = sqlite.getDb();
  return db
    .prepare(
      `SELECT memory_id, degree, normalized_degree, updated_at
     FROM memory_centrality ORDER BY memory_id ASC`
    )
    .all() as CentralityRow[];
}

// =============================================================================
// Bulk Restore
// =============================================================================

export async function bulkRestoreImpl(
  d: StorageDispatcher,
  data: {
    memories: Array<{
      id: number;
      content: string;
      tags: string[];
      source: string | null;
      embedding: number[] | null;
      type: string | null;
      quality_score: number | null;
      quality_factors: Record<string, number> | null;
      access_count: number;
      last_accessed: string | null;
      created_at: string;
    }>;
    memoryLinks: Array<{
      source_id: number;
      target_id: number;
      relation: string;
      weight: number;
      created_at: string;
      llm_enriched?: boolean;
    }>;
    centrality: Array<{
      memory_id: number;
      degree: number;
      normalized_degree: number;
      updated_at: string;
    }>;
    documents: Array<{
      file_path: string;
      chunk_index: number;
      content: string;
      start_line: number;
      end_line: number;
      embedding: number[] | null;
      created_at: string;
    }>;
    overwrite: boolean;
    restoreDocuments: boolean;
  }
): Promise<{
  memoriesRestored: number;
  linksRestored: number;
  documentsRestored: number;
  memoryIdMap: Map<number, number>;
}> {
  let memoriesRestored = 0;
  let linksRestored = 0;
  let documentsRestored = 0;
  const memoryIdMap = new Map<number, number>();

  const backend = (d as any).backend as 'sqlite' | 'postgresql';
  const postgres = (d as any).postgres;

  if (backend === 'postgresql' && postgres) {
    // PostgreSQL: explicit transaction with proper cleanup
    const pool = await postgres.getPool();
    const projectId = postgres.getProjectId();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      if (data.overwrite) {
        await client.query(
          'DELETE FROM memory_centrality WHERE memory_id IN (SELECT id FROM memories WHERE LOWER(project_id) = $1)',
          [projectId]
        );
        await client.query('DELETE FROM memory_links WHERE LOWER(project_id) = $1', [projectId]);
        await client.query('DELETE FROM memories WHERE LOWER(project_id) = $1', [projectId]);
        if (data.restoreDocuments) {
          await client.query('DELETE FROM documents WHERE LOWER(project_id) = $1', [projectId]);
        }
      }

      for (const memory of data.memories) {
        const embeddingStr = memory.embedding ? '[' + memory.embedding.join(',') + ']' : null;
        const result = await client.query(
          `INSERT INTO memories (project_id, content, tags, source, embedding, type, quality_score, quality_factors, access_count, last_accessed, created_at)
           VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            projectId,
            memory.content,
            JSON.stringify(memory.tags),
            memory.source,
            embeddingStr,
            memory.type,
            memory.quality_score,
            memory.quality_factors ? JSON.stringify(memory.quality_factors) : null,
            memory.access_count,
            memory.last_accessed,
            memory.created_at,
          ]
        );
        const returnedId = (result.rows[0] as { id: number }).id;
        memoryIdMap.set(memory.id, returnedId);
        memoriesRestored++;
      }

      for (const link of data.memoryLinks) {
        const newSourceId = memoryIdMap.get(link.source_id);
        const newTargetId = memoryIdMap.get(link.target_id);
        if (newSourceId && newTargetId) {
          await client.query(
            `INSERT INTO memory_links (project_id, source_id, target_id, relation, weight, created_at, llm_enriched)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              projectId,
              newSourceId,
              newTargetId,
              link.relation,
              link.weight,
              link.created_at,
              link.llm_enriched ? 1 : 0,
            ]
          );
          linksRestored++;
        }
      }

      if (data.centrality.length > 0) {
        for (const entry of data.centrality) {
          const newMemoryId = memoryIdMap.get(entry.memory_id);
          if (newMemoryId) {
            await client.query(
              `INSERT INTO memory_centrality (memory_id, degree, normalized_degree, updated_at)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (memory_id) DO UPDATE SET degree = $2, normalized_degree = $3, updated_at = $4`,
              [newMemoryId, entry.degree, entry.normalized_degree, entry.updated_at]
            );
          }
        }
      }

      if (data.restoreDocuments) {
        for (const doc of data.documents) {
          const embeddingStr = doc.embedding ? '[' + doc.embedding.join(',') + ']' : null;
          await client.query(
            `INSERT INTO documents (project_id, file_path, chunk_index, content, start_line, end_line, embedding, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)`,
            [
              projectId,
              doc.file_path,
              doc.chunk_index,
              doc.content,
              doc.start_line,
              doc.end_line,
              embeddingStr,
              doc.created_at,
            ]
          );
          documentsRestored++;
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    // SQLite: single atomic transaction for entire restore
    const sqlite = await getSqliteFns(d);
    const db = sqlite.getDb();

    const insertMemory = db.prepare(`
      INSERT INTO memories (content, tags, source, embedding, type, quality_score, quality_factors, access_count, last_accessed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLink = db.prepare(`
      INSERT INTO memory_links (source_id, target_id, relation, weight, created_at, llm_enriched)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertCentrality = db.prepare(`
      INSERT OR REPLACE INTO memory_centrality (memory_id, degree, normalized_degree, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertDocument = db.prepare(`
      INSERT INTO documents (file_path, chunk_index, content, start_line, end_line, embedding, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const restoreAllTx = db.transaction(() => {
      if (data.overwrite) {
        db.exec('DELETE FROM memory_centrality');
        db.exec('DELETE FROM memory_links');
        db.exec('DELETE FROM memories');
        if (data.restoreDocuments) {
          db.exec('DELETE FROM documents');
        }
      }

      for (const memory of data.memories) {
        const embedding = memory.embedding
          ? Buffer.from(new Float32Array(memory.embedding).buffer)
          : null;

        const result = insertMemory.run(
          memory.content,
          JSON.stringify(memory.tags),
          memory.source,
          embedding,
          memory.type,
          memory.quality_score,
          memory.quality_factors ? JSON.stringify(memory.quality_factors) : null,
          memory.access_count,
          memory.last_accessed,
          memory.created_at
        );

        memoryIdMap.set(memory.id, result.lastInsertRowid as number);
        memoriesRestored++;
      }

      for (const link of data.memoryLinks) {
        const newSourceId = memoryIdMap.get(link.source_id);
        const newTargetId = memoryIdMap.get(link.target_id);

        if (newSourceId && newTargetId) {
          insertLink.run(
            newSourceId,
            newTargetId,
            link.relation,
            link.weight,
            link.created_at,
            link.llm_enriched ? 1 : 0
          );
          linksRestored++;
        }
      }

      for (const entry of data.centrality) {
        const newMemoryId = memoryIdMap.get(entry.memory_id);
        if (newMemoryId) {
          insertCentrality.run(
            newMemoryId,
            entry.degree,
            entry.normalized_degree,
            entry.updated_at
          );
        }
      }

      if (data.restoreDocuments) {
        for (const doc of data.documents) {
          const embedding = doc.embedding
            ? Buffer.from(new Float32Array(doc.embedding).buffer)
            : null;

          insertDocument.run(
            doc.file_path,
            doc.chunk_index,
            doc.content,
            doc.start_line,
            doc.end_line,
            embedding,
            doc.created_at
          );
          documentsRestored++;
        }
      }
    });

    restoreAllTx();
  }

  return { memoriesRestored, linksRestored, documentsRestored, memoryIdMap };
}

// =============================================================================
// Qdrant Backfill
// =============================================================================

export async function backfillQdrantImpl(
  d: StorageDispatcher,
  target: 'memories' | 'global_memories' | 'documents' | 'all' = 'all',
  options?: { onProgress?: (msg: string) => void; dryRun?: boolean }
): Promise<{ memories: number; globalMemories: number; documents: number }> {
  const log = options?.onProgress ?? (() => {});
  const dryRun = options?.dryRun ?? false;

  const vectorBackend = (d as any).vectorBackend as 'builtin' | 'qdrant';
  const qdrant = (d as any).qdrant;

  if (vectorBackend !== 'qdrant' || !qdrant) {
    throw new ConfigError('Qdrant is not configured. Set storage.vector = "qdrant" in config.');
  }

  const stats = { memories: 0, globalMemories: 0, documents: 0 };

  if (target === 'memories' || target === 'all') {
    stats.memories = await backfillMemoriesImpl(d, log, dryRun);
  }
  if (target === 'global_memories' || target === 'all') {
    stats.globalMemories = await backfillGlobalMemoriesImpl(d, log, dryRun);
  }
  if (target === 'documents' || target === 'all') {
    stats.documents = await backfillDocumentsImpl(d, log, dryRun);
  }

  return stats;
}

async function backfillMemoriesImpl(
  d: StorageDispatcher,
  log: (msg: string) => void,
  dryRun: boolean
): Promise<number> {
  const qdrant = (d as any).qdrant;

  if (!qdrant) {
    log('Skipping memories: Qdrant not configured');
    return 0;
  }

  const projectId = qdrant.getProjectId();
  const backend = (d as any).backend as 'sqlite' | 'postgresql';
  const postgres = (d as any).postgres;

  if (backend === 'postgresql' && postgres) {
    const rows = await postgres.getAllMemoriesWithEmbeddings();
    log(`Found ${rows.length} memories in PostgreSQL`);
    if (dryRun || rows.length === 0) return rows.length;

    const items = rows
      .filter((r: any) => r.embedding?.length > 0)
      .map((r: any) => ({ id: r.id, embedding: r.embedding, meta: { ...r, projectId } }));

    log(`Upserting ${items.length} memories to Qdrant...`);
    await qdrant!.upsertMemoriesBatchWithPayload(items);
    log(`Done: ${items.length} memories synced`);
    return items.length;
  }

  // SQLite path
  const sqlite = await getSqliteFns(d);
  const db = sqlite.getDb();
  const rows = db
    .prepare(
      `SELECT m.id, m.content, m.tags, m.source, m.type,
            m.quality_score, m.access_count, m.created_at, m.last_accessed,
            m.valid_from, m.valid_until, m.invalidated_by,
            v.embedding
     FROM memories m
     LEFT JOIN memory_vec_mapping mv ON mv.memory_id = m.id
     LEFT JOIN memory_vec v ON v.rowid = mv.vec_rowid
     ORDER BY m.id`
    )
    .all() as SqlMemoryRow[];

  log(`Found ${rows.length} memories in SQLite`);
  if (dryRun || rows.length === 0) return rows.length;

  const items = rows
    .filter((r): r is SqlMemoryWithEmbedding => !!r.embedding)
    .map((r) => ({
      id: r.id,
      embedding: Array.from(new Float32Array(r.embedding.buffer ?? r.embedding)),
      meta: {
        content: r.content,
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags ?? []),
        source: r.source,
        type: r.type,
        projectId,
        createdAt: r.created_at ?? new Date().toISOString(),
        validFrom: r.valid_from,
        validUntil: r.valid_until,
        invalidatedBy: r.invalidated_by,
        accessCount: r.access_count ?? 0,
        lastAccessed: r.last_accessed,
        qualityScore: r.quality_score,
      },
    }));

  log(`Upserting ${items.length} memories to Qdrant...`);
  await qdrant!.upsertMemoriesBatchWithPayload(items);
  log(`Done: ${items.length} memories synced`);
  return items.length;
}

async function backfillGlobalMemoriesImpl(
  d: StorageDispatcher,
  log: (msg: string) => void,
  dryRun: boolean
): Promise<number> {
  const qdrant = (d as any).qdrant;

  if (!qdrant) {
    log('Skipping global memories: Qdrant not configured');
    return 0;
  }

  const backend = (d as any).backend as 'sqlite' | 'postgresql';
  const postgres = (d as any).postgres;

  // PostgreSQL: global memories are rows with project_id IS NULL
  if (backend === 'postgresql' && postgres) {
    const pool = await postgres.getPool();
    const { rows } = await pool.query(
      `SELECT id, content, embedding::text, tags, source, type,
              quality_score, access_count,
              created_at::text as created_at,
              last_accessed::text as last_accessed,
              valid_from::text as valid_from,
              valid_until::text as valid_until,
              invalidated_by
       FROM memories WHERE project_id IS NULL ORDER BY id`
    );

    log(`Found ${rows.length} global memories in PostgreSQL`);
    if (dryRun || rows.length === 0) return rows.length;

    const items = rows
      .filter((r: any) => r.embedding)
      .map((r: any) => ({
        id: r.id,
        embedding: parsePgVector(r.embedding),
        meta: {
          content: r.content,
          tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags ?? []),
          source: r.source,
          type: r.type,
          projectId: null,
          createdAt: r.created_at ?? new Date().toISOString(),
          validFrom: r.valid_from,
          validUntil: r.valid_until,
          invalidatedBy: r.invalidated_by,
          accessCount: r.access_count ?? 0,
          lastAccessed: r.last_accessed,
          qualityScore: r.quality_score,
        },
      }));

    log(`Upserting ${items.length} global memories to Qdrant...`);
    await qdrant!.upsertGlobalMemoriesBatchWithPayload(items);
    log(`Done: ${items.length} global memories synced`);
    return items.length;
  }

  // SQLite: global memories in separate DB
  const sqlite = await getSqliteFns(d);
  const gdb = sqlite.getGlobalDb();

  // Check if vec tables exist (they may not if sqlite-vec was never initialized)
  let rows: any[];
  try {
    rows = gdb
      .prepare(
        `SELECT m.id, m.content, m.tags, m.source, m.type,
              m.quality_score, m.access_count, m.created_at, m.last_accessed,
              m.valid_from, m.valid_until, m.invalidated_by,
              v.embedding
       FROM memories m
       LEFT JOIN memory_vec_mapping mv ON mv.memory_id = m.id
       LEFT JOIN memory_vec v ON v.rowid = mv.vec_rowid
       ORDER BY m.id`
      )
      .all() as SqlMemoryRow[];
  } catch {
    // sqlite-vec tables may not exist — fall back to memory-only query (no embeddings)
    log('Global DB has no vector tables — fetching memories without embeddings');
    rows = gdb
      .prepare(
        `SELECT id, content, tags, source, type,
              quality_score, access_count, created_at, last_accessed,
              valid_from, valid_until, invalidated_by
       FROM memories ORDER BY id`
      )
      .all() as SqlMemoryRow[];
  }

  log(`Found ${rows.length} global memories in SQLite`);
  if (dryRun || rows.length === 0) return rows.length;

  const items = rows
    .filter((r: any) => r.embedding)
    .map((r: any) => ({
      id: r.id,
      embedding: Array.from(new Float32Array(r.embedding.buffer ?? r.embedding)),
      meta: {
        content: r.content,
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags ?? []),
        source: r.source,
        type: r.type,
        projectId: null,
        createdAt: r.created_at ?? new Date().toISOString(),
        validFrom: r.valid_from,
        validUntil: r.valid_until,
        invalidatedBy: r.invalidated_by,
        accessCount: r.access_count ?? 0,
        lastAccessed: r.last_accessed,
        qualityScore: r.quality_score,
      },
    }));

  log(`Upserting ${items.length} global memories to Qdrant...`);
  await qdrant!.upsertGlobalMemoriesBatchWithPayload(items);
  log(`Done: ${items.length} global memories synced`);
  return items.length;
}

async function backfillDocumentsImpl(
  d: StorageDispatcher,
  log: (msg: string) => void,
  dryRun: boolean
): Promise<number> {
  const qdrant = (d as any).qdrant;

  if (!qdrant) {
    log('Skipping documents: Qdrant not configured');
    return 0;
  }

  const projectId = qdrant!.getProjectId() ?? '';
  const backend = (d as any).backend as 'sqlite' | 'postgresql';
  const postgres = (d as any).postgres;

  if (backend === 'postgresql' && postgres) {
    const rows = await postgres.getAllDocumentsWithEmbeddings();
    log(`Found ${rows.length} documents in PostgreSQL`);
    if (dryRun || rows.length === 0) return rows.length;

    const items = rows
      .filter((r: any) => r.embedding?.length > 0)
      .map((r: any) => ({ id: r.id, embedding: r.embedding, meta: r }));

    log(`Upserting ${items.length} documents to Qdrant...`);
    await qdrant!.upsertDocumentsBatchWithPayload(items);
    log(`Done: ${items.length} documents synced`);
    return items.length;
  }

  // SQLite path
  const sqlite = await getSqliteFns(d);
  const db = sqlite.getDb();
  const rows = db
    .prepare(
      `SELECT d.id, d.file_path, d.content, d.start_line, d.end_line,
            v.embedding
     FROM documents d
     LEFT JOIN document_vec_mapping dm ON dm.document_id = d.id
     LEFT JOIN document_vec v ON v.rowid = dm.vec_rowid
     ORDER BY d.id`
    )
    .all() as SqlDocumentRow[];

  log(`Found ${rows.length} documents in SQLite`);
  if (dryRun || rows.length === 0) return rows.length;

  const items = rows
    .filter((r): r is SqlDocumentWithEmbedding => !!r.embedding)
    .map((r) => ({
      id: r.id,
      embedding: Array.from(new Float32Array(r.embedding.buffer ?? r.embedding)),
      meta: {
        filePath: r.file_path,
        content: r.content,
        startLine: r.start_line,
        endLine: r.end_line,
        projectId,
      } as import('./vector/qdrant.js').DocumentUpsertMeta,
    }));

  log(`Upserting ${items.length} documents to Qdrant...`);
  await qdrant!.upsertDocumentsBatchWithPayload(items);
  log(`Done: ${items.length} documents synced`);
  return items.length;
}
