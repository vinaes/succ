/**
 * PostgreSQL storage backend implementation.
 *
 * Uses pg (node-postgres) for connections and pgvector extension for vector similarity search.
 *
 * Schema mirrors SQLite structure with PostgreSQL-specific adaptations:
 * - SERIAL instead of AUTOINCREMENT
 * - BYTEA instead of BLOB
 * - vector(N) type from pgvector extension
 * - ON CONFLICT instead of INSERT OR REPLACE
 */

import type { Pool, PoolClient, PoolConfig, QueryResult } from 'pg';
import type {
  Document,
  DocumentBatch,
  DocumentBatchWithHash,
  Memory,
  MemoryType,
  MemoryLink,
  MemoryWithLinks,
  ConnectedMemory,
  GraphStats,
  GlobalMemory,
  TokenStatRecord,
  TokenStatsAggregated,
  MemoryForRetention,
  LinkRelation,
  StorageConfig,
} from '../types.js';

// Lazy-load pg to make it optional
let pg: typeof import('pg') | null = null;

async function loadPg(): Promise<typeof import('pg')> {
  if (pg) return pg;
  try {
    pg = await import('pg');
    return pg;
  } catch {
    throw new Error(
      'PostgreSQL support requires the "pg" package. ' +
      'Install it with: npm install pg'
    );
  }
}

/**
 * Convert number[] embedding to pgvector format string: '[1.0, 2.0, 3.0]'
 */
function toPgVector(embedding: number[]): string {
  return '[' + embedding.join(',') + ']';
}

/**
 * Parse pgvector string back to number[]
 */
function fromPgVector(str: string): number[] {
  // pgvector returns string like '[1.0, 2.0, 3.0]'
  const inner = str.slice(1, -1);
  if (!inner) return [];
  return inner.split(',').map(s => parseFloat(s.trim()));
}

export interface PostgresBackendConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  poolSize?: number;
}

export class PostgresBackend {
  private pool: Pool | null = null;
  private config: PostgresBackendConfig;
  private initialized = false;
  private projectId: string | null = null;

  constructor(config: PostgresBackendConfig, projectId?: string) {
    this.config = config;
    this.projectId = projectId ?? null;
  }

  /**
   * Set the current project ID for scoping memories.
   * NULL = global memories (shared across all projects)
   */
  setProjectId(projectId: string | null): void {
    this.projectId = projectId;
  }

  getProjectId(): string | null {
    return this.projectId;
  }

  /**
   * Get or create the connection pool.
   */
  private async getPool(): Promise<Pool> {
    if (this.pool) return this.pool;

    const { Pool } = await loadPg();

    const poolConfig: PoolConfig = {
      max: this.config.poolSize ?? 10,
    };

    if (this.config.connectionString) {
      poolConfig.connectionString = this.config.connectionString;
    } else {
      poolConfig.host = this.config.host ?? 'localhost';
      poolConfig.port = this.config.port ?? 5432;
      poolConfig.database = this.config.database ?? 'succ';
      poolConfig.user = this.config.user;
      poolConfig.password = this.config.password;
    }

    if (this.config.ssl) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }

    this.pool = new Pool(poolConfig);

    if (!this.initialized) {
      await this.initSchema();
      this.initialized = true;
    }

    return this.pool;
  }

  /**
   * Initialize database schema.
   */
  private async initSchema(): Promise<void> {
    const pool = await this.getPool();

    // Enable pgvector extension
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Documents table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        file_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        embedding vector(384),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(file_path, chunk_index)
      )
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_documents_file_path ON documents(file_path)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_documents_embedding ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)');

    // Metadata table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // File hashes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS file_hashes (
        file_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        indexed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Memories table
    // project_id: NULL = global memory (shared across all projects)
    //             non-NULL = project-specific memory
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id SERIAL PRIMARY KEY,
        project_id TEXT,
        content TEXT NOT NULL,
        tags JSONB,
        source TEXT,
        type TEXT DEFAULT 'observation',
        quality_score REAL,
        quality_factors JSONB,
        embedding vector(384),
        access_count REAL DEFAULT 0,
        last_accessed TIMESTAMPTZ,
        valid_from TIMESTAMPTZ,
        valid_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Add project_id column if it doesn't exist (migration for existing databases)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'memories' AND column_name = 'project_id'
        ) THEN
          ALTER TABLE memories ADD COLUMN project_id TEXT;
        END IF;
      END $$;
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_quality ON memories(quality_score)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)');

    // Memory links table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memory_links (
        id SERIAL PRIMARY KEY,
        source_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        relation TEXT NOT NULL DEFAULT 'related',
        weight REAL DEFAULT 1.0,
        valid_from TIMESTAMPTZ,
        valid_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(source_id, target_id, relation)
      )
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_id)');

    // Token frequencies table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS token_frequencies (
        token TEXT PRIMARY KEY,
        frequency INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_token_freq ON token_frequencies(frequency DESC)');

    // Token stats table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS token_stats (
        id SERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        query TEXT,
        returned_tokens INTEGER NOT NULL DEFAULT 0,
        full_source_tokens INTEGER NOT NULL DEFAULT 0,
        savings_tokens INTEGER NOT NULL DEFAULT 0,
        files_count INTEGER,
        chunks_count INTEGER,
        model TEXT,
        estimated_cost REAL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_token_stats_type ON token_stats(event_type)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_token_stats_created ON token_stats(created_at)');

    // Skills table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS skills (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT NOT NULL,
        source TEXT NOT NULL,
        path TEXT,
        content TEXT,
        embedding vector(384),
        skyll_id TEXT,
        usage_count INTEGER DEFAULT 0,
        last_used TIMESTAMPTZ,
        cached_at TIMESTAMPTZ,
        cache_expires TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source)');
  }

  /**
   * Close all connections.
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.initialized = false;
    }
  }

  // ============================================================================
  // Document Operations
  // ============================================================================

  async upsertDocument(
    filePath: string,
    chunkIndex: number,
    content: string,
    startLine: number,
    endLine: number,
    embedding: number[]
  ): Promise<number> {
    const pool = await this.getPool();
    const result = await pool.query<{ id: number }>(
      `INSERT INTO documents (file_path, chunk_index, content, start_line, end_line, embedding, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT(file_path, chunk_index) DO UPDATE SET
         content = EXCLUDED.content,
         start_line = EXCLUDED.start_line,
         end_line = EXCLUDED.end_line,
         embedding = EXCLUDED.embedding,
         updated_at = NOW()
       RETURNING id`,
      [filePath, chunkIndex, content, startLine, endLine, toPgVector(embedding)]
    );
    return result.rows[0].id;
  }

  async upsertDocumentsBatch(documents: DocumentBatch[]): Promise<void> {
    if (documents.length === 0) return;

    const pool = await this.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const doc of documents) {
        await client.query(
          `INSERT INTO documents (file_path, chunk_index, content, start_line, end_line, embedding, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT(file_path, chunk_index) DO UPDATE SET
             content = EXCLUDED.content,
             start_line = EXCLUDED.start_line,
             end_line = EXCLUDED.end_line,
             embedding = EXCLUDED.embedding,
             updated_at = NOW()`,
          [doc.filePath, doc.chunkIndex, doc.content, doc.startLine, doc.endLine, toPgVector(doc.embedding)]
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async upsertDocumentsBatchWithHashes(documents: DocumentBatchWithHash[]): Promise<void> {
    if (documents.length === 0) return;

    const pool = await this.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const processedFiles = new Set<string>();

      for (const doc of documents) {
        await client.query(
          `INSERT INTO documents (file_path, chunk_index, content, start_line, end_line, embedding, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT(file_path, chunk_index) DO UPDATE SET
             content = EXCLUDED.content,
             start_line = EXCLUDED.start_line,
             end_line = EXCLUDED.end_line,
             embedding = EXCLUDED.embedding,
             updated_at = NOW()`,
          [doc.filePath, doc.chunkIndex, doc.content, doc.startLine, doc.endLine, toPgVector(doc.embedding)]
        );

        if (!processedFiles.has(doc.filePath)) {
          await client.query(
            `INSERT INTO file_hashes (file_path, content_hash, indexed_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT(file_path) DO UPDATE SET
               content_hash = EXCLUDED.content_hash,
               indexed_at = NOW()`,
            [doc.filePath, doc.hash]
          );
          processedFiles.add(doc.filePath);
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async deleteDocumentsByPath(filePath: string): Promise<number[]> {
    const pool = await this.getPool();
    const result = await pool.query<{ id: number }>(
      'DELETE FROM documents WHERE file_path = $1 RETURNING id',
      [filePath]
    );
    return result.rows.map(r => r.id);
  }

  async searchDocuments(
    queryEmbedding: number[],
    limit: number = 5,
    threshold: number = 0.5
  ): Promise<Array<{ file_path: string; content: string; start_line: number; end_line: number; similarity: number }>> {
    const pool = await this.getPool();

    // pgvector cosine distance: <=> returns distance (0 = identical, 2 = opposite)
    // similarity = 1 - distance/2 for normalized vectors
    // For our use: similarity = 1 - distance (since cosine distance from pgvector is 1-cosine_similarity)
    const result = await pool.query<{
      file_path: string;
      content: string;
      start_line: number;
      end_line: number;
      similarity: number;
    }>(
      `SELECT file_path, content, start_line, end_line,
              1 - (embedding <=> $1) as similarity
       FROM documents
       WHERE 1 - (embedding <=> $1) >= $2
       ORDER BY embedding <=> $1
       LIMIT $3`,
      [toPgVector(queryEmbedding), threshold, limit]
    );

    return result.rows;
  }

  async getDocumentStats(): Promise<{ total_documents: number; total_files: number; last_indexed: string | null }> {
    const pool = await this.getPool();

    const totalDocs = await pool.query<{ count: string }>('SELECT COUNT(*) as count FROM documents');
    const totalFiles = await pool.query<{ count: string }>('SELECT COUNT(DISTINCT file_path) as count FROM documents');
    const lastIndexed = await pool.query<{ last: string | null }>('SELECT MAX(updated_at) as last FROM documents');

    return {
      total_documents: parseInt(totalDocs.rows[0].count),
      total_files: parseInt(totalFiles.rows[0].count),
      last_indexed: lastIndexed.rows[0].last,
    };
  }

  async clearDocuments(): Promise<void> {
    const pool = await this.getPool();
    await pool.query('DELETE FROM documents');
    await pool.query('DELETE FROM file_hashes');
    await pool.query("DELETE FROM metadata WHERE key = 'embedding_model'");
  }

  // ============================================================================
  // File Hashes
  // ============================================================================

  async getFileHash(filePath: string): Promise<string | null> {
    const pool = await this.getPool();
    const result = await pool.query<{ content_hash: string }>(
      'SELECT content_hash FROM file_hashes WHERE file_path = $1',
      [filePath]
    );
    return result.rows[0]?.content_hash ?? null;
  }

  async setFileHash(filePath: string, hash: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO file_hashes (file_path, content_hash, indexed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT(file_path) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         indexed_at = NOW()`,
      [filePath, hash]
    );
  }

  async deleteFileHash(filePath: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query('DELETE FROM file_hashes WHERE file_path = $1', [filePath]);
  }

  async getAllFileHashes(): Promise<Map<string, string>> {
    const pool = await this.getPool();
    const result = await pool.query<{ file_path: string; content_hash: string }>(
      'SELECT file_path, content_hash FROM file_hashes'
    );
    return new Map(result.rows.map(r => [r.file_path, r.content_hash]));
  }

  // ============================================================================
  // Memory Operations
  // ============================================================================

  async saveMemory(
    content: string,
    embedding: number[],
    tags: string[] = [],
    source?: string,
    type: MemoryType = 'observation',
    qualityScore?: number,
    qualityFactors?: Record<string, number>,
    validFrom?: string,
    validUntil?: string,
    isGlobal: boolean = false
  ): Promise<number> {
    const pool = await this.getPool();
    const projectId = isGlobal ? null : this.projectId;

    const result = await pool.query<{ id: number }>(
      `INSERT INTO memories (project_id, content, tags, source, type, quality_score, quality_factors, embedding, valid_from, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        projectId,
        content,
        tags.length > 0 ? JSON.stringify(tags) : null,
        source ?? null,
        type,
        qualityScore ?? null,
        qualityFactors ? JSON.stringify(qualityFactors) : null,
        toPgVector(embedding),
        validFrom ?? null,
        validUntil ?? null,
      ]
    );

    return result.rows[0].id;
  }

  async searchMemories(
    queryEmbedding: number[],
    limit: number = 5,
    threshold: number = 0.3,
    tags?: string[],
    since?: Date,
    options?: { includeExpired?: boolean; asOfDate?: Date; includeGlobal?: boolean }
  ): Promise<Array<Memory & { similarity: number }>> {
    const pool = await this.getPool();
    const now = options?.asOfDate ?? new Date();
    const includeExpired = options?.includeExpired ?? false;
    const includeGlobal = options?.includeGlobal ?? true;

    let query = `
      SELECT id, project_id, content, tags, source, type, quality_score, quality_factors,
             access_count, last_accessed, valid_from, valid_until, created_at,
             1 - (embedding <=> $1) as similarity
      FROM memories
      WHERE 1 - (embedding <=> $1) >= $2
    `;
    const params: any[] = [toPgVector(queryEmbedding), threshold];
    let paramIndex = 3;

    // Filter by project_id: include current project AND optionally global (NULL)
    if (this.projectId) {
      if (includeGlobal) {
        query += ` AND (project_id = $${paramIndex} OR project_id IS NULL)`;
      } else {
        query += ` AND project_id = $${paramIndex}`;
      }
      params.push(this.projectId);
      paramIndex++;
    } else {
      // No project set = only return global memories
      query += ` AND project_id IS NULL`;
    }

    if (since) {
      query += ` AND created_at >= $${paramIndex}`;
      params.push(since.toISOString());
      paramIndex++;
    }

    if (!includeExpired) {
      query += ` AND (valid_from IS NULL OR valid_from <= $${paramIndex})`;
      params.push(now.toISOString());
      paramIndex++;
      query += ` AND (valid_until IS NULL OR valid_until > $${paramIndex})`;
      params.push(now.toISOString());
      paramIndex++;
    }

    query += ` ORDER BY embedding <=> $1 LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await pool.query(query, params);

    let memories = result.rows.map(row => ({
      id: row.id,
      content: row.content,
      tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : [],
      source: row.source,
      type: row.type as MemoryType,
      quality_score: row.quality_score,
      quality_factors: row.quality_factors ? (typeof row.quality_factors === 'string' ? JSON.parse(row.quality_factors) : row.quality_factors) : null,
      access_count: row.access_count ?? 0,
      last_accessed: row.last_accessed,
      valid_from: row.valid_from,
      valid_until: row.valid_until,
      created_at: row.created_at,
      similarity: parseFloat(row.similarity),
    }));

    // Filter by tags if specified
    if (tags && tags.length > 0) {
      memories = memories.filter(m =>
        tags.some(t => m.tags.some((rt: string) => rt.toLowerCase().includes(t.toLowerCase())))
      );
    }

    return memories;
  }

  async getMemoryById(id: number): Promise<Memory | null> {
    const pool = await this.getPool();
    const result = await pool.query(
      `SELECT id, content, tags, source, type, quality_score, quality_factors,
              access_count, last_accessed, valid_from, valid_until, created_at
       FROM memories WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      content: row.content,
      tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : [],
      source: row.source,
      type: row.type as MemoryType,
      quality_score: row.quality_score,
      quality_factors: row.quality_factors ? (typeof row.quality_factors === 'string' ? JSON.parse(row.quality_factors) : row.quality_factors) : null,
      access_count: row.access_count ?? 0,
      last_accessed: row.last_accessed,
      valid_from: row.valid_from,
      valid_until: row.valid_until,
      created_at: row.created_at,
    };
  }

  async deleteMemory(id: number): Promise<boolean> {
    const pool = await this.getPool();
    const result = await pool.query('DELETE FROM memories WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async getRecentMemories(limit: number = 10, includeGlobal: boolean = true): Promise<Memory[]> {
    const pool = await this.getPool();

    let query = `
      SELECT id, project_id, content, tags, source, type, quality_score, quality_factors,
             access_count, last_accessed, valid_from, valid_until, created_at
      FROM memories
    `;
    const params: any[] = [];
    let paramIndex = 1;

    // Filter by project_id
    if (this.projectId) {
      if (includeGlobal) {
        query += ` WHERE (project_id = $${paramIndex} OR project_id IS NULL)`;
      } else {
        query += ` WHERE project_id = $${paramIndex}`;
      }
      params.push(this.projectId);
      paramIndex++;
    } else {
      query += ` WHERE project_id IS NULL`;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await pool.query(query, params);

    return result.rows.map(row => ({
      id: row.id,
      content: row.content,
      tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : [],
      source: row.source,
      type: row.type as MemoryType,
      quality_score: row.quality_score,
      quality_factors: row.quality_factors ? (typeof row.quality_factors === 'string' ? JSON.parse(row.quality_factors) : row.quality_factors) : null,
      access_count: row.access_count ?? 0,
      last_accessed: row.last_accessed,
      valid_from: row.valid_from,
      valid_until: row.valid_until,
      created_at: row.created_at,
    }));
  }

  async incrementMemoryAccess(memoryId: number, weight: number = 1.0): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `UPDATE memories
       SET access_count = COALESCE(access_count, 0) + $1,
           last_accessed = NOW()
       WHERE id = $2`,
      [weight, memoryId]
    );
  }

  // ============================================================================
  // Memory Links
  // ============================================================================

  async createMemoryLink(
    sourceId: number,
    targetId: number,
    relation: LinkRelation = 'related',
    weight: number = 1.0,
    validFrom?: string,
    validUntil?: string
  ): Promise<{ id: number; created: boolean }> {
    const pool = await this.getPool();

    try {
      const result = await pool.query<{ id: number }>(
        `INSERT INTO memory_links (source_id, target_id, relation, weight, valid_from, valid_until)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [sourceId, targetId, relation, weight, validFrom ?? null, validUntil ?? null]
      );
      return { id: result.rows[0].id, created: true };
    } catch (e: any) {
      if (e.code === '23505') { // unique_violation
        const existing = await pool.query<{ id: number }>(
          'SELECT id FROM memory_links WHERE source_id = $1 AND target_id = $2 AND relation = $3',
          [sourceId, targetId, relation]
        );
        return { id: existing.rows[0].id, created: false };
      }
      throw e;
    }
  }

  async deleteMemoryLink(sourceId: number, targetId: number, relation?: LinkRelation): Promise<boolean> {
    const pool = await this.getPool();

    if (relation) {
      const result = await pool.query(
        'DELETE FROM memory_links WHERE source_id = $1 AND target_id = $2 AND relation = $3',
        [sourceId, targetId, relation]
      );
      return (result.rowCount ?? 0) > 0;
    } else {
      const result = await pool.query(
        'DELETE FROM memory_links WHERE source_id = $1 AND target_id = $2',
        [sourceId, targetId]
      );
      return (result.rowCount ?? 0) > 0;
    }
  }

  async getMemoryLinks(memoryId: number): Promise<{ outgoing: MemoryLink[]; incoming: MemoryLink[] }> {
    const pool = await this.getPool();

    const outgoing = await pool.query<MemoryLink>(
      'SELECT * FROM memory_links WHERE source_id = $1',
      [memoryId]
    );

    const incoming = await pool.query<MemoryLink>(
      'SELECT * FROM memory_links WHERE target_id = $1',
      [memoryId]
    );

    return {
      outgoing: outgoing.rows,
      incoming: incoming.rows,
    };
  }

  async getGraphStats(): Promise<GraphStats> {
    const pool = await this.getPool();

    const totalMemories = await pool.query<{ count: string }>('SELECT COUNT(*) as count FROM memories');
    const totalLinks = await pool.query<{ count: string }>('SELECT COUNT(*) as count FROM memory_links');
    const isolated = await pool.query<{ count: string }>(`
      SELECT COUNT(*) as count FROM memories m
      WHERE NOT EXISTS (SELECT 1 FROM memory_links WHERE source_id = m.id OR target_id = m.id)
    `);
    const relations = await pool.query<{ relation: string; count: string }>(
      'SELECT relation, COUNT(*) as count FROM memory_links GROUP BY relation'
    );

    const relationsMap: Record<string, number> = {};
    for (const row of relations.rows) {
      relationsMap[row.relation] = parseInt(row.count);
    }

    const total = parseInt(totalMemories.rows[0].count);
    const links = parseInt(totalLinks.rows[0].count);

    return {
      total_memories: total,
      total_links: links,
      avg_links_per_memory: total > 0 ? links / total : 0,
      isolated_memories: parseInt(isolated.rows[0].count),
      relations: relationsMap,
    };
  }

  // ============================================================================
  // Token Stats
  // ============================================================================

  async recordTokenStat(record: TokenStatRecord): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO token_stats (event_type, query, returned_tokens, full_source_tokens, savings_tokens, files_count, chunks_count, model, estimated_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.event_type,
        record.query ?? null,
        record.returned_tokens,
        record.full_source_tokens,
        record.savings_tokens,
        record.files_count ?? null,
        record.chunks_count ?? null,
        record.model ?? null,
        record.estimated_cost ?? 0,
      ]
    );
  }

  async getTokenStatsSummary(): Promise<{
    total_queries: number;
    total_returned_tokens: number;
    total_full_source_tokens: number;
    total_savings_tokens: number;
    total_estimated_cost: number;
  }> {
    const pool = await this.getPool();
    const result = await pool.query<{
      total_queries: string;
      total_returned_tokens: string;
      total_full_source_tokens: string;
      total_savings_tokens: string;
      total_estimated_cost: string;
    }>(`
      SELECT
        COUNT(*) as total_queries,
        COALESCE(SUM(returned_tokens), 0) as total_returned_tokens,
        COALESCE(SUM(full_source_tokens), 0) as total_full_source_tokens,
        COALESCE(SUM(savings_tokens), 0) as total_savings_tokens,
        COALESCE(SUM(estimated_cost), 0) as total_estimated_cost
      FROM token_stats
    `);

    const row = result.rows[0];
    return {
      total_queries: parseInt(row.total_queries),
      total_returned_tokens: parseInt(row.total_returned_tokens),
      total_full_source_tokens: parseInt(row.total_full_source_tokens),
      total_savings_tokens: parseInt(row.total_savings_tokens),
      total_estimated_cost: parseFloat(row.total_estimated_cost),
    };
  }

  // ============================================================================
  // Metadata
  // ============================================================================

  async getMetadata(key: string): Promise<string | null> {
    const pool = await this.getPool();
    const result = await pool.query<{ value: string }>(
      'SELECT value FROM metadata WHERE key = $1',
      [key]
    );
    return result.rows[0]?.value ?? null;
  }

  async setMetadata(key: string, value: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO metadata (key, value) VALUES ($1, $2)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }

  // ============================================================================
  // Global Memory Operations (project_id = NULL)
  // ============================================================================

  /**
   * Save a global memory (shared across all projects).
   */
  async saveGlobalMemory(
    content: string,
    embedding: number[],
    tags: string[] = [],
    source?: string,
    type: MemoryType = 'observation',
    qualityScore?: number,
    qualityFactors?: Record<string, number>
  ): Promise<number> {
    return this.saveMemory(
      content,
      embedding,
      tags,
      source,
      type,
      qualityScore,
      qualityFactors,
      undefined, // validFrom
      undefined, // validUntil
      true // isGlobal
    );
  }

  /**
   * Search global memories only.
   */
  async searchGlobalMemories(
    queryEmbedding: number[],
    limit: number = 5,
    threshold: number = 0.3,
    tags?: string[]
  ): Promise<Array<Memory & { similarity: number }>> {
    const pool = await this.getPool();

    let query = `
      SELECT id, project_id, content, tags, source, type, quality_score, quality_factors,
             access_count, last_accessed, valid_from, valid_until, created_at,
             1 - (embedding <=> $1) as similarity
      FROM memories
      WHERE 1 - (embedding <=> $1) >= $2
        AND project_id IS NULL
      ORDER BY embedding <=> $1
      LIMIT $3
    `;
    const params: any[] = [toPgVector(queryEmbedding), threshold, limit];

    const result = await pool.query(query, params);

    let memories = result.rows.map(row => ({
      id: row.id,
      content: row.content,
      tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : [],
      source: row.source,
      type: row.type as MemoryType,
      quality_score: row.quality_score,
      quality_factors: row.quality_factors ? (typeof row.quality_factors === 'string' ? JSON.parse(row.quality_factors) : row.quality_factors) : null,
      access_count: row.access_count ?? 0,
      last_accessed: row.last_accessed,
      valid_from: row.valid_from,
      valid_until: row.valid_until,
      created_at: row.created_at,
      similarity: parseFloat(row.similarity),
    }));

    // Filter by tags if specified
    if (tags && tags.length > 0) {
      memories = memories.filter(m =>
        tags.some(t => m.tags.some((rt: string) => rt.toLowerCase().includes(t.toLowerCase())))
      );
    }

    return memories;
  }

  /**
   * Get recent global memories.
   */
  async getRecentGlobalMemories(limit: number = 10): Promise<Memory[]> {
    const pool = await this.getPool();

    const result = await pool.query(
      `SELECT id, project_id, content, tags, source, type, quality_score, quality_factors,
              access_count, last_accessed, valid_from, valid_until, created_at
       FROM memories
       WHERE project_id IS NULL
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows.map(row => ({
      id: row.id,
      content: row.content,
      tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : [],
      source: row.source,
      type: row.type as MemoryType,
      quality_score: row.quality_score,
      quality_factors: row.quality_factors ? (typeof row.quality_factors === 'string' ? JSON.parse(row.quality_factors) : row.quality_factors) : null,
      access_count: row.access_count ?? 0,
      last_accessed: row.last_accessed,
      valid_from: row.valid_from,
      valid_until: row.valid_until,
      created_at: row.created_at,
    }));
  }

  /**
   * Delete a global memory.
   */
  async deleteGlobalMemory(id: number): Promise<boolean> {
    const pool = await this.getPool();
    const result = await pool.query(
      'DELETE FROM memories WHERE id = $1 AND project_id IS NULL',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get global memory statistics.
   */
  async getGlobalMemoryStats(): Promise<{
    total: number;
    by_type: Record<string, number>;
    by_quality: { high: number; medium: number; low: number; unscored: number };
  }> {
    const pool = await this.getPool();

    const total = await pool.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM memories WHERE project_id IS NULL'
    );

    const byType = await pool.query<{ type: string; count: string }>(
      'SELECT type, COUNT(*) as count FROM memories WHERE project_id IS NULL GROUP BY type'
    );

    const byQuality = await pool.query<{ bucket: string; count: string }>(`
      SELECT
        CASE
          WHEN quality_score >= 0.7 THEN 'high'
          WHEN quality_score >= 0.4 THEN 'medium'
          WHEN quality_score IS NOT NULL THEN 'low'
          ELSE 'unscored'
        END as bucket,
        COUNT(*) as count
      FROM memories
      WHERE project_id IS NULL
      GROUP BY bucket
    `);

    const typeMap: Record<string, number> = {};
    for (const row of byType.rows) {
      typeMap[row.type || 'observation'] = parseInt(row.count);
    }

    const qualityMap = { high: 0, medium: 0, low: 0, unscored: 0 };
    for (const row of byQuality.rows) {
      qualityMap[row.bucket as keyof typeof qualityMap] = parseInt(row.count);
    }

    return {
      total: parseInt(total.rows[0].count),
      by_type: typeMap,
      by_quality: qualityMap,
    };
  }
}

/**
 * Create PostgreSQL backend from storage config.
 */
export function createPostgresBackend(config: StorageConfig): PostgresBackend {
  const pgConfig = config.postgresql ?? {};
  return new PostgresBackend({
    connectionString: pgConfig.connection_string,
    host: pgConfig.host,
    port: pgConfig.port,
    database: pgConfig.database,
    user: pgConfig.user,
    password: pgConfig.password,
    ssl: pgConfig.ssl,
    poolSize: pgConfig.pool_size,
  });
}
