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
  MemorySearchResult,
  QualityScoreData,
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
  async getPool(): Promise<Pool> {
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
    // project_id: scopes documents to a specific project
    await pool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        project_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        embedding vector(384),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, file_path, chunk_index)
      )
    `);

    // Migration: add project_id column if missing
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'documents' AND column_name = 'project_id'
        ) THEN
          ALTER TABLE documents ADD COLUMN project_id TEXT;
          -- Drop old unique constraint and add new one
          ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_file_path_chunk_index_key;
          ALTER TABLE documents ADD CONSTRAINT documents_project_file_chunk_key UNIQUE(project_id, file_path, chunk_index);
        END IF;
      END $$;
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_documents_project_id ON documents(project_id)');
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
    // project_id: scopes file hashes to a specific project
    await pool.query(`
      CREATE TABLE IF NOT EXISTS file_hashes (
        project_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (project_id, file_path)
      )
    `);

    // Migration: add project_id column if missing
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'file_hashes' AND column_name = 'project_id'
        ) THEN
          -- Need to recreate table with new primary key
          ALTER TABLE file_hashes ADD COLUMN project_id TEXT;
          ALTER TABLE file_hashes DROP CONSTRAINT IF EXISTS file_hashes_pkey;
          ALTER TABLE file_hashes ADD PRIMARY KEY (project_id, file_path);
        END IF;
      END $$;
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
    // project_id: scopes stats to a specific project
    await pool.query(`
      CREATE TABLE IF NOT EXISTS token_stats (
        id SERIAL PRIMARY KEY,
        project_id TEXT,
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

    // Migration: add project_id column if missing
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'token_stats' AND column_name = 'project_id'
        ) THEN
          ALTER TABLE token_stats ADD COLUMN project_id TEXT;
        END IF;
      END $$;
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_token_stats_project_id ON token_stats(project_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_token_stats_type ON token_stats(event_type)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_token_stats_created ON token_stats(created_at)');

    // Skills table
    // project_id: scopes skills to a specific project (NULL for Skyll cached skills which are global)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS skills (
        id SERIAL PRIMARY KEY,
        project_id TEXT,
        name TEXT NOT NULL,
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
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, name)
      )
    `);

    // Migration: add project_id column if missing (for existing databases)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'skills' AND column_name = 'project_id'
        ) THEN
          -- Add project_id column
          ALTER TABLE skills ADD COLUMN project_id TEXT;

          -- Drop old unique constraint on name only
          ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_name_key;

          -- Add new unique constraint on (project_id, name)
          ALTER TABLE skills ADD CONSTRAINT skills_project_name_unique UNIQUE(project_id, name);
        END IF;
      END $$;
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_skills_project_id ON skills(project_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source)');

    // Migration: add invalidated_by column for soft-delete during consolidation
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'memories' AND column_name = 'invalidated_by'
        ) THEN
          ALTER TABLE memories ADD COLUMN invalidated_by INTEGER;
        END IF;
      END $$;
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_invalidated_by ON memories(invalidated_by)');

    // Learning deltas table for session progress tracking
    await pool.query(`
      CREATE TABLE IF NOT EXISTS learning_deltas (
        id SERIAL PRIMARY KEY,
        project_id TEXT,
        timestamp TIMESTAMPTZ NOT NULL,
        source TEXT NOT NULL,
        memories_before INTEGER NOT NULL DEFAULT 0,
        memories_after INTEGER NOT NULL DEFAULT 0,
        new_memories INTEGER NOT NULL DEFAULT 0,
        types_added JSONB,
        avg_quality REAL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_learning_deltas_timestamp ON learning_deltas(timestamp)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_learning_deltas_source ON learning_deltas(source)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_learning_deltas_project_id ON learning_deltas(project_id)');
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
    if (!this.projectId) {
      throw new Error('Project ID must be set before upserting documents');
    }
    const pool = await this.getPool();
    const result = await pool.query<{ id: number }>(
      `INSERT INTO documents (project_id, file_path, chunk_index, content, start_line, end_line, embedding, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT(project_id, file_path, chunk_index) DO UPDATE SET
         content = EXCLUDED.content,
         start_line = EXCLUDED.start_line,
         end_line = EXCLUDED.end_line,
         embedding = EXCLUDED.embedding,
         updated_at = NOW()
       RETURNING id`,
      [this.projectId, filePath, chunkIndex, content, startLine, endLine, toPgVector(embedding)]
    );
    return result.rows[0].id;
  }

  async upsertDocumentsBatch(documents: DocumentBatch[]): Promise<number[]> {
    if (documents.length === 0) return [];
    if (!this.projectId) {
      throw new Error('Project ID must be set before upserting documents');
    }

    const pool = await this.getPool();
    const client = await pool.connect();
    const ids: number[] = [];

    try {
      await client.query('BEGIN');

      for (const doc of documents) {
        const result = await client.query<{ id: number }>(
          `INSERT INTO documents (project_id, file_path, chunk_index, content, start_line, end_line, embedding, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT(project_id, file_path, chunk_index) DO UPDATE SET
             content = EXCLUDED.content,
             start_line = EXCLUDED.start_line,
             end_line = EXCLUDED.end_line,
             embedding = EXCLUDED.embedding,
             updated_at = NOW()
           RETURNING id`,
          [this.projectId, doc.filePath, doc.chunkIndex, doc.content, doc.startLine, doc.endLine, toPgVector(doc.embedding)]
        );
        ids.push(result.rows[0].id);
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return ids;
  }

  async upsertDocumentsBatchWithHashes(documents: DocumentBatchWithHash[]): Promise<number[]> {
    if (documents.length === 0) return [];
    if (!this.projectId) {
      throw new Error('Project ID must be set before upserting documents');
    }

    const pool = await this.getPool();
    const client = await pool.connect();
    const ids: number[] = [];

    try {
      await client.query('BEGIN');

      const processedFiles = new Set<string>();

      for (const doc of documents) {
        const result = await client.query<{ id: number }>(
          `INSERT INTO documents (project_id, file_path, chunk_index, content, start_line, end_line, embedding, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT(project_id, file_path, chunk_index) DO UPDATE SET
             content = EXCLUDED.content,
             start_line = EXCLUDED.start_line,
             end_line = EXCLUDED.end_line,
             embedding = EXCLUDED.embedding,
             updated_at = NOW()
           RETURNING id`,
          [this.projectId, doc.filePath, doc.chunkIndex, doc.content, doc.startLine, doc.endLine, toPgVector(doc.embedding)]
        );
        ids.push(result.rows[0].id);

        if (!processedFiles.has(doc.filePath)) {
          await client.query(
            `INSERT INTO file_hashes (project_id, file_path, content_hash, indexed_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT(project_id, file_path) DO UPDATE SET
               content_hash = EXCLUDED.content_hash,
               indexed_at = NOW()`,
            [this.projectId, doc.filePath, doc.hash]
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

    return ids;
  }

  async deleteDocumentsByPath(filePath: string): Promise<number[]> {
    if (!this.projectId) {
      throw new Error('Project ID must be set before deleting documents');
    }
    const pool = await this.getPool();
    const result = await pool.query<{ id: number }>(
      'DELETE FROM documents WHERE project_id = $1 AND file_path = $2 RETURNING id',
      [this.projectId, filePath]
    );
    return result.rows.map(r => r.id);
  }

  async searchDocuments(
    queryEmbedding: number[],
    limit: number = 5,
    threshold: number = 0.5
  ): Promise<Array<{ file_path: string; content: string; start_line: number; end_line: number; similarity: number }>> {
    if (!this.projectId) {
      throw new Error('Project ID must be set before searching documents');
    }
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
       WHERE project_id = $2 AND 1 - (embedding <=> $1) >= $3
       ORDER BY embedding <=> $1
       LIMIT $4`,
      [toPgVector(queryEmbedding), this.projectId, threshold, limit]
    );

    return result.rows;
  }

  /**
   * Batch fetch documents by IDs (for Qdrant search → PG metadata pattern).
   * Optionally filter by code/doc type via file_path prefix.
   */
  async getDocumentsByIds(
    ids: number[],
    options?: { codeOnly?: boolean; docsOnly?: boolean }
  ): Promise<Array<{ id: number; file_path: string; content: string; start_line: number; end_line: number }>> {
    if (ids.length === 0) return [];
    const pool = await this.getPool();

    let query = `SELECT id, file_path, content, start_line, end_line FROM documents WHERE id = ANY($1)`;
    const params: any[] = [ids];

    if (options?.codeOnly) {
      query += ` AND file_path LIKE 'code:%'`;
    } else if (options?.docsOnly) {
      query += ` AND file_path NOT LIKE 'code:%'`;
    }

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Batch fetch memories by IDs with optional SQL-level filters
   * (for Qdrant search → PG metadata pattern).
   */
  async getMemoriesByIds(
    ids: number[],
    filters?: {
      excludeInvalidated?: boolean;
      temporalAsOf?: Date;
      includeExpired?: boolean;
      since?: Date;
      createdBefore?: Date;
    }
  ): Promise<Memory[]> {
    if (ids.length === 0) return [];
    const pool = await this.getPool();

    let query = `
      SELECT id, content, tags, source, type, quality_score, quality_factors,
             access_count, last_accessed, valid_from, valid_until, created_at
      FROM memories WHERE id = ANY($1)`;
    const params: any[] = [ids];
    let idx = 2;

    // Soft-delete filter (default: exclude invalidated)
    if (filters?.excludeInvalidated !== false) {
      query += ` AND invalidated_by IS NULL`;
    }

    // Temporal validity
    if (!filters?.includeExpired && filters?.temporalAsOf) {
      const asOf = filters.temporalAsOf.toISOString();
      query += ` AND (valid_from IS NULL OR valid_from <= $${idx})`;
      params.push(asOf); idx++;
      query += ` AND (valid_until IS NULL OR valid_until > $${idx})`;
      params.push(asOf); idx++;
    }

    // Since filter
    if (filters?.since) {
      query += ` AND created_at >= $${idx}`;
      params.push(filters.since.toISOString()); idx++;
    }

    // Created-before filter (for point-in-time queries)
    if (filters?.createdBefore) {
      query += ` AND created_at <= $${idx}`;
      params.push(filters.createdBefore.toISOString()); idx++;
    }

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

  async getDocumentStats(): Promise<{ total_documents: number; total_files: number; last_indexed: string | null }> {
    const pool = await this.getPool();

    // If project_id is set, get stats for that project; otherwise get global stats
    if (this.projectId) {
      const totalDocs = await pool.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM documents WHERE project_id = $1',
        [this.projectId]
      );
      const totalFiles = await pool.query<{ count: string }>(
        'SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE project_id = $1',
        [this.projectId]
      );
      const lastIndexed = await pool.query<{ last: string | null }>(
        'SELECT MAX(updated_at) as last FROM documents WHERE project_id = $1',
        [this.projectId]
      );

      return {
        total_documents: parseInt(totalDocs.rows[0].count),
        total_files: parseInt(totalFiles.rows[0].count),
        last_indexed: lastIndexed.rows[0].last,
      };
    }

    // No project set = aggregate stats across all projects
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

    if (this.projectId) {
      // Clear only current project's documents
      await pool.query('DELETE FROM documents WHERE project_id = $1', [this.projectId]);
      await pool.query('DELETE FROM file_hashes WHERE project_id = $1', [this.projectId]);
    } else {
      // No project set = clear ALL documents (dangerous!)
      await pool.query('DELETE FROM documents');
      await pool.query('DELETE FROM file_hashes');
    }
    await pool.query("DELETE FROM metadata WHERE key = 'embedding_model'");
  }

  // ============================================================================
  // File Hashes
  // ============================================================================

  async getFileHash(filePath: string): Promise<string | null> {
    if (!this.projectId) {
      throw new Error('Project ID must be set before getting file hash');
    }
    const pool = await this.getPool();
    const result = await pool.query<{ content_hash: string }>(
      'SELECT content_hash FROM file_hashes WHERE project_id = $1 AND file_path = $2',
      [this.projectId, filePath]
    );
    return result.rows[0]?.content_hash ?? null;
  }

  async setFileHash(filePath: string, hash: string): Promise<void> {
    if (!this.projectId) {
      throw new Error('Project ID must be set before setting file hash');
    }
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO file_hashes (project_id, file_path, content_hash, indexed_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT(project_id, file_path) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         indexed_at = NOW()`,
      [this.projectId, filePath, hash]
    );
  }

  async deleteFileHash(filePath: string): Promise<void> {
    if (!this.projectId) {
      throw new Error('Project ID must be set before deleting file hash');
    }
    const pool = await this.getPool();
    await pool.query('DELETE FROM file_hashes WHERE project_id = $1 AND file_path = $2', [this.projectId, filePath]);
  }

  async getAllFileHashes(): Promise<Map<string, string>> {
    if (!this.projectId) {
      throw new Error('Project ID must be set before getting all file hashes');
    }
    const pool = await this.getPool();
    const result = await pool.query<{ file_path: string; content_hash: string }>(
      'SELECT file_path, content_hash FROM file_hashes WHERE project_id = $1',
      [this.projectId]
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
        AND invalidated_by IS NULL
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
    // Only delete memories belonging to current project or global memories
    const result = await pool.query(
      'DELETE FROM memories WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)',
      [id, this.projectId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Soft-invalidate a memory (mark as superseded by another memory).
   */
  async invalidateMemory(memoryId: number, supersededById: number): Promise<boolean> {
    const pool = await this.getPool();
    const result = await pool.query(
      `UPDATE memories
       SET valid_until = NOW(), invalidated_by = $1
       WHERE id = $2 AND invalidated_by IS NULL`,
      [supersededById, memoryId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Restore a soft-invalidated memory.
   */
  async restoreInvalidatedMemory(memoryId: number): Promise<boolean> {
    const pool = await this.getPool();
    const result = await pool.query(
      `UPDATE memories
       SET valid_until = NULL, invalidated_by = NULL
       WHERE id = $1 AND invalidated_by IS NOT NULL`,
      [memoryId]
    );
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

    // Filter by project_id and exclude soft-deleted
    if (this.projectId) {
      if (includeGlobal) {
        query += ` WHERE (project_id = $${paramIndex} OR project_id IS NULL) AND invalidated_by IS NULL`;
      } else {
        query += ` WHERE project_id = $${paramIndex} AND invalidated_by IS NULL`;
      }
      params.push(this.projectId);
      paramIndex++;
    } else {
      query += ` WHERE project_id IS NULL AND invalidated_by IS NULL`;
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

    // Validate that both memories belong to current project
    const validation = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM memories
       WHERE id IN ($1, $2) AND (project_id = $3 OR project_id IS NULL)`,
      [sourceId, targetId, this.projectId]
    );

    if (parseInt(validation.rows[0].count) !== 2) {
      throw new Error('Cannot link memories from different projects');
    }

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

    // Only delete links where both memories belong to current project
    if (relation) {
      const result = await pool.query(
        `DELETE FROM memory_links ml
         USING memories m1, memories m2
         WHERE ml.source_id = m1.id AND ml.target_id = m2.id
           AND ml.source_id = $1 AND ml.target_id = $2 AND ml.relation = $3
           AND (m1.project_id = $4 OR m1.project_id IS NULL)
           AND (m2.project_id = $4 OR m2.project_id IS NULL)`,
        [sourceId, targetId, relation, this.projectId]
      );
      return (result.rowCount ?? 0) > 0;
    } else {
      const result = await pool.query(
        `DELETE FROM memory_links ml
         USING memories m1, memories m2
         WHERE ml.source_id = m1.id AND ml.target_id = m2.id
           AND ml.source_id = $1 AND ml.target_id = $2
           AND (m1.project_id = $3 OR m1.project_id IS NULL)
           AND (m2.project_id = $3 OR m2.project_id IS NULL)`,
        [sourceId, targetId, this.projectId]
      );
      return (result.rowCount ?? 0) > 0;
    }
  }

  async getMemoryLinks(memoryId: number): Promise<{ outgoing: MemoryLink[]; incoming: MemoryLink[] }> {
    const pool = await this.getPool();

    // Only return links where both source and target memories belong to current project
    const outgoing = await pool.query<MemoryLink>(
      `SELECT ml.* FROM memory_links ml
       JOIN memories m ON ml.target_id = m.id
       WHERE ml.source_id = $1 AND (m.project_id = $2 OR m.project_id IS NULL)`,
      [memoryId, this.projectId]
    );

    const incoming = await pool.query<MemoryLink>(
      `SELECT ml.* FROM memory_links ml
       JOIN memories m ON ml.source_id = m.id
       WHERE ml.target_id = $1 AND (m.project_id = $2 OR m.project_id IS NULL)`,
      [memoryId, this.projectId]
    );

    return {
      outgoing: outgoing.rows,
      incoming: incoming.rows,
    };
  }

  async getGraphStats(): Promise<GraphStats> {
    const pool = await this.getPool();

    // Only count memories and links for current project
    const totalMemories = await pool.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM memories WHERE project_id = $1 OR project_id IS NULL',
      [this.projectId]
    );

    // Count links only between memories of current project
    const totalLinks = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM memory_links ml
       JOIN memories m1 ON ml.source_id = m1.id
       JOIN memories m2 ON ml.target_id = m2.id
       WHERE (m1.project_id = $1 OR m1.project_id IS NULL)
         AND (m2.project_id = $1 OR m2.project_id IS NULL)`,
      [this.projectId]
    );

    const isolated = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM memories m
       WHERE (m.project_id = $1 OR m.project_id IS NULL)
         AND NOT EXISTS (
           SELECT 1 FROM memory_links ml
           JOIN memories m2 ON (ml.source_id = m2.id OR ml.target_id = m2.id)
           WHERE (ml.source_id = m.id OR ml.target_id = m.id)
             AND (m2.project_id = $1 OR m2.project_id IS NULL)
         )`,
      [this.projectId]
    );

    const relations = await pool.query<{ relation: string; count: string }>(
      `SELECT ml.relation, COUNT(*) as count FROM memory_links ml
       JOIN memories m1 ON ml.source_id = m1.id
       JOIN memories m2 ON ml.target_id = m2.id
       WHERE (m1.project_id = $1 OR m1.project_id IS NULL)
         AND (m2.project_id = $1 OR m2.project_id IS NULL)
       GROUP BY ml.relation`,
      [this.projectId]
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
      `INSERT INTO token_stats (project_id, event_type, query, returned_tokens, full_source_tokens, savings_tokens, files_count, chunks_count, model, estimated_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        this.projectId, // Can be NULL for global stats
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

    // If project_id is set, get stats for that project; otherwise get all stats
    const whereClause = this.projectId
      ? 'WHERE project_id = $1'
      : '';
    const params = this.projectId ? [this.projectId] : [];

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
      ${whereClause}
    `, params);

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
        AND invalidated_by IS NULL
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
         AND invalidated_by IS NULL
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

  // ============================================================================
  // Skills Operations
  // ============================================================================

  /**
   * Upsert a skill (local or Skyll-cached).
   * Local skills use project_id, Skyll skills use project_id = NULL (global cache).
   */
  async upsertSkill(skill: {
    name: string;
    description: string;
    source: 'local' | 'skyll';
    path?: string;
    content?: string;
    embedding?: number[];
    skyllId?: string;
    cacheExpires?: Date;
  }): Promise<number> {
    const pool = await this.getPool();
    // Local skills are project-scoped, Skyll skills are global (project_id = NULL)
    const projectId = skill.source === 'local' ? this.projectId : null;

    const result = await pool.query<{ id: number }>(
      `INSERT INTO skills (project_id, name, description, source, path, content, embedding, skyll_id, cached_at, cache_expires, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, NOW(), NOW())
       ON CONFLICT(project_id, name) DO UPDATE SET
         description = EXCLUDED.description,
         path = EXCLUDED.path,
         content = EXCLUDED.content,
         embedding = EXCLUDED.embedding,
         skyll_id = EXCLUDED.skyll_id,
         cached_at = CASE WHEN EXCLUDED.source = 'skyll' THEN NOW() ELSE skills.cached_at END,
         cache_expires = EXCLUDED.cache_expires,
         updated_at = NOW()
       RETURNING id`,
      [
        projectId,
        skill.name,
        skill.description,
        skill.source,
        skill.path ?? null,
        skill.content ?? null,
        skill.embedding ? toPgVector(skill.embedding) : null,
        skill.skyllId ?? null,
        skill.cacheExpires ?? null,
      ]
    );
    return result.rows[0].id;
  }

  /**
   * Get all skills for the current project (includes local + global Skyll cache).
   */
  async getAllSkills(): Promise<Array<{
    id: number;
    name: string;
    description: string;
    source: string;
    path?: string;
    content?: string;
    skyllId?: string;
    usageCount: number;
    lastUsed?: Date;
  }>> {
    const pool = await this.getPool();
    // Include both project-specific local skills AND global Skyll cached skills
    const result = await pool.query(
      `SELECT id, name, description, source, path, content, skyll_id, usage_count, last_used
       FROM skills
       WHERE project_id = $1 OR project_id IS NULL
       ORDER BY usage_count DESC, updated_at DESC`,
      [this.projectId]
    );
    return result.rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      source: row.source,
      path: row.path,
      content: row.content,
      skyllId: row.skyll_id,
      usageCount: row.usage_count ?? 0,
      lastUsed: row.last_used,
    }));
  }

  /**
   * Search skills by name or description.
   */
  async searchSkills(query: string, limit: number = 10): Promise<Array<{
    id: number;
    name: string;
    description: string;
    source: string;
    path?: string;
    usageCount: number;
  }>> {
    const pool = await this.getPool();
    const result = await pool.query(
      `SELECT id, name, description, source, path, usage_count
       FROM skills
       WHERE (project_id = $1 OR project_id IS NULL)
         AND (name ILIKE $2 OR description ILIKE $2)
       ORDER BY usage_count DESC, updated_at DESC
       LIMIT $3`,
      [this.projectId, `%${query}%`, limit]
    );
    return result.rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      source: row.source,
      path: row.path,
      usageCount: row.usage_count ?? 0,
    }));
  }

  /**
   * Get a skill by name.
   */
  async getSkillByName(name: string): Promise<{
    id: number;
    name: string;
    description: string;
    source: string;
    path?: string;
    content?: string;
    skyllId?: string;
  } | null> {
    const pool = await this.getPool();
    const result = await pool.query(
      `SELECT id, name, description, source, path, content, skyll_id
       FROM skills
       WHERE name = $1 AND (project_id = $2 OR project_id IS NULL)
       LIMIT 1`,
      [name, this.projectId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      source: row.source,
      path: row.path,
      content: row.content,
      skyllId: row.skyll_id,
    };
  }

  /**
   * Track skill usage (increment usage count).
   */
  async trackSkillUsage(name: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `UPDATE skills SET usage_count = usage_count + 1, last_used = NOW()
       WHERE name = $1 AND (project_id = $2 OR project_id IS NULL)`,
      [name, this.projectId]
    );
  }

  /**
   * Delete a skill by name.
   */
  async deleteSkill(name: string): Promise<boolean> {
    const pool = await this.getPool();
    const result = await pool.query(
      'DELETE FROM skills WHERE name = $1 AND project_id = $2',
      [name, this.projectId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Clear expired Skyll cache entries.
   */
  async clearExpiredSkyllCache(): Promise<number> {
    const pool = await this.getPool();
    const result = await pool.query(
      `DELETE FROM skills WHERE source = 'skyll' AND cache_expires < NOW()`
    );
    return result.rowCount ?? 0;
  }

  /**
   * Get cached Skyll skill by ID.
   */
  async getCachedSkyllSkill(skyllId: string): Promise<{
    id: number;
    name: string;
    description: string;
    content?: string;
  } | null> {
    const pool = await this.getPool();
    const result = await pool.query(
      `SELECT id, name, description, content
       FROM skills
       WHERE skyll_id = $1 AND cache_expires > NOW()`,
      [skyllId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      content: row.content,
    };
  }

  /**
   * Get Skyll cache status.
   *
   * Note: Skyll cached skills are INTENTIONALLY global (not project-scoped).
   * This is because Skyll marketplace skills are shared across all projects.
   * Only local skills use project_id scoping.
   */
  async getSkyllCacheStats(): Promise<{ cachedSkills: number }> {
    const pool = await this.getPool();
    // Global count - Skyll skills are shared across projects (project_id IS NULL)
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM skills WHERE source = 'skyll' AND project_id IS NULL`
    );
    return { cachedSkills: parseInt(result.rows[0].count) };
  }

  // ============================================================================
  // Token Frequency Operations
  // ============================================================================

  async updateTokenFrequencies(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const token of tokens) {
        if (token.length >= 2) {
          await client.query(
            `INSERT INTO token_frequencies (token, frequency, updated_at)
             VALUES ($1, 1, NOW())
             ON CONFLICT(token) DO UPDATE SET
               frequency = token_frequencies.frequency + 1,
               updated_at = NOW()`,
            [token]
          );
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

  async getTokenFrequency(token: string): Promise<number> {
    const pool = await this.getPool();
    const result = await pool.query<{ frequency: number }>(
      'SELECT frequency FROM token_frequencies WHERE token = $1',
      [token]
    );
    return result.rows[0]?.frequency ?? 0;
  }

  async getTokenFrequencies(tokens: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (tokens.length === 0) return result;

    const pool = await this.getPool();
    const placeholders = tokens.map((_, i) => `$${i + 1}`).join(',');
    const rows = await pool.query<{ token: string; frequency: number }>(
      `SELECT token, frequency FROM token_frequencies WHERE token IN (${placeholders})`,
      tokens
    );
    for (const row of rows.rows) {
      result.set(row.token, row.frequency);
    }
    return result;
  }

  async getTotalTokenCount(): Promise<number> {
    const pool = await this.getPool();
    const result = await pool.query<{ total: string }>(
      'SELECT COALESCE(SUM(frequency), 0) as total FROM token_frequencies'
    );
    return parseInt(result.rows[0].total);
  }

  async getTopTokens(limit: number = 100): Promise<Array<{ token: string; frequency: number }>> {
    const pool = await this.getPool();
    const result = await pool.query<{ token: string; frequency: number }>(
      'SELECT token, frequency FROM token_frequencies ORDER BY frequency DESC LIMIT $1',
      [limit]
    );
    return result.rows;
  }

  async clearTokenFrequencies(): Promise<void> {
    const pool = await this.getPool();
    await pool.query('DELETE FROM token_frequencies');
  }

  async getTokenFrequencyStats(): Promise<{
    unique_tokens: number;
    total_occurrences: number;
    avg_frequency: number;
  }> {
    const pool = await this.getPool();
    const result = await pool.query<{ unique_tokens: string; total_occurrences: string }>(`
      SELECT
        COUNT(*) as unique_tokens,
        COALESCE(SUM(frequency), 0) as total_occurrences
      FROM token_frequencies
    `);
    const row = result.rows[0];
    const unique = parseInt(row.unique_tokens);
    const total = parseInt(row.total_occurrences);
    return {
      unique_tokens: unique,
      total_occurrences: total,
      avg_frequency: unique > 0 ? total / unique : 0,
    };
  }

  // ============================================================================
  // Token Stats - Additional Operations
  // ============================================================================

  async getTokenStatsAggregated(): Promise<Array<{
    event_type: string;
    query_count: number;
    total_returned_tokens: number;
    total_full_source_tokens: number;
    total_savings_tokens: number;
    total_estimated_cost: number;
  }>> {
    const pool = await this.getPool();
    const whereClause = this.projectId ? 'WHERE project_id = $1' : '';
    const params = this.projectId ? [this.projectId] : [];

    const result = await pool.query(`
      SELECT
        event_type,
        COUNT(*) as query_count,
        SUM(returned_tokens) as total_returned_tokens,
        SUM(full_source_tokens) as total_full_source_tokens,
        SUM(savings_tokens) as total_savings_tokens,
        COALESCE(SUM(estimated_cost), 0) as total_estimated_cost
      FROM token_stats
      ${whereClause}
      GROUP BY event_type
      ORDER BY event_type
    `, params);

    return result.rows.map((row: any) => ({
      event_type: row.event_type,
      query_count: parseInt(row.query_count),
      total_returned_tokens: parseInt(row.total_returned_tokens),
      total_full_source_tokens: parseInt(row.total_full_source_tokens),
      total_savings_tokens: parseInt(row.total_savings_tokens),
      total_estimated_cost: parseFloat(row.total_estimated_cost),
    }));
  }

  async clearTokenStats(): Promise<void> {
    const pool = await this.getPool();
    if (this.projectId) {
      await pool.query('DELETE FROM token_stats WHERE project_id = $1', [this.projectId]);
    } else {
      await pool.query('DELETE FROM token_stats');
    }
  }

  // ============================================================================
  // Document Operations - Additional
  // ============================================================================

  async getRecentDocuments(limit: number = 10): Promise<Array<{
    file_path: string;
    content: string;
    start_line: number;
    end_line: number;
  }>> {
    if (!this.projectId) {
      throw new Error('Project ID must be set before getting recent documents');
    }
    const pool = await this.getPool();
    const result = await pool.query<{
      file_path: string;
      content: string;
      start_line: number;
      end_line: number;
    }>(
      `SELECT file_path, content, start_line, end_line
       FROM documents
       WHERE project_id = $1 AND file_path NOT LIKE 'code:%'
       ORDER BY id DESC
       LIMIT $2`,
      [this.projectId, limit]
    );
    return result.rows;
  }

  async clearCodeDocuments(): Promise<void> {
    const pool = await this.getPool();
    if (this.projectId) {
      await pool.query("DELETE FROM documents WHERE project_id = $1 AND file_path LIKE 'code:%'", [this.projectId]);
      await pool.query("DELETE FROM file_hashes WHERE project_id = $1 AND file_path LIKE 'code:%'", [this.projectId]);
    } else {
      await pool.query("DELETE FROM documents WHERE file_path LIKE 'code:%'");
      await pool.query("DELETE FROM file_hashes WHERE file_path LIKE 'code:%'");
    }
  }

  async getStoredEmbeddingDimension(): Promise<number | null> {
    const pool = await this.getPool();
    const result = await pool.query<{ embedding: string }>(
      'SELECT embedding FROM documents LIMIT 1'
    );
    if (result.rows.length === 0) return null;
    const embedding = fromPgVector(result.rows[0].embedding);
    return embedding.length;
  }

  // ============================================================================
  // Memory Operations - Additional
  // ============================================================================

  async findSimilarMemory(
    embedding: number[],
    threshold: number = 0.92
  ): Promise<{ id: number; content: string; similarity: number } | null> {
    const pool = await this.getPool();

    let query: string;
    let params: any[];

    if (this.projectId) {
      query = `SELECT id, content, 1 - (embedding <=> $1) as similarity
               FROM memories
               WHERE (project_id = $2 OR project_id IS NULL)
                 AND 1 - (embedding <=> $1) >= $3
               ORDER BY embedding <=> $1
               LIMIT 1`;
      params = [toPgVector(embedding), this.projectId, threshold];
    } else {
      query = `SELECT id, content, 1 - (embedding <=> $1) as similarity
               FROM memories
               WHERE project_id IS NULL
                 AND 1 - (embedding <=> $1) >= $2
               ORDER BY embedding <=> $1
               LIMIT 1`;
      params = [toPgVector(embedding), threshold];
    }

    const result = await pool.query<{ id: number; content: string; similarity: number }>(query, params);
    if (result.rows.length === 0) return null;

    return {
      id: result.rows[0].id,
      content: result.rows[0].content,
      similarity: parseFloat(String(result.rows[0].similarity)),
    };
  }

  async findSimilarGlobalMemory(
    embedding: number[],
    threshold: number = 0.92
  ): Promise<{ id: number; content: string; similarity: number } | null> {
    const pool = await this.getPool();
    const result = await pool.query<{ id: number; content: string; similarity: number }>(
      `SELECT id, content, 1 - (embedding <=> $1) as similarity
       FROM memories
       WHERE project_id IS NULL
         AND 1 - (embedding <=> $1) >= $2
       ORDER BY embedding <=> $1
       LIMIT 1`,
      [toPgVector(embedding), threshold]
    );
    if (result.rows.length === 0) return null;

    return {
      id: result.rows[0].id,
      content: result.rows[0].content,
      similarity: parseFloat(String(result.rows[0].similarity)),
    };
  }

  async saveMemoriesBatch(
    memories: Array<{
      content: string;
      embedding: number[];
      tags: string[];
      type: MemoryType;
      source?: string;
      qualityScore?: { score: number; factors: Record<string, number> };
      validFrom?: string | Date;
      validUntil?: string | Date;
    }>,
    deduplicateThreshold: number = 0.92,
    options?: { autoLink?: boolean; linkThreshold?: number; deduplicate?: boolean }
  ): Promise<{
    saved: number;
    skipped: number;
    results: Array<{
      index: number;
      isDuplicate: boolean;
      id?: number;
      reason: 'duplicate' | 'saved';
      similarity?: number;
    }>;
  }> {
    if (memories.length === 0) {
      return { saved: 0, skipped: 0, results: [] };
    }

    const pool = await this.getPool();
    const client = await pool.connect();
    const results: Array<{
      index: number;
      isDuplicate: boolean;
      id?: number;
      reason: 'duplicate' | 'saved';
      similarity?: number;
    }> = [];
    let saved = 0;
    let skipped = 0;
    const shouldDedup = options?.deduplicate !== false;

    try {
      await client.query('BEGIN');

      for (let i = 0; i < memories.length; i++) {
        const memory = memories[i];

        // Check for duplicates via pgvector
        if (shouldDedup) {
          let dupQuery: string;
          let dupParams: any[];

          if (this.projectId) {
            dupQuery = `SELECT id, 1 - (embedding <=> $1) as similarity
                       FROM memories
                       WHERE (project_id = $2 OR project_id IS NULL)
                         AND 1 - (embedding <=> $1) >= $3
                       ORDER BY embedding <=> $1
                       LIMIT 1`;
            dupParams = [toPgVector(memory.embedding), this.projectId, deduplicateThreshold];
          } else {
            dupQuery = `SELECT id, 1 - (embedding <=> $1) as similarity
                       FROM memories
                       WHERE project_id IS NULL
                         AND 1 - (embedding <=> $1) >= $2
                       ORDER BY embedding <=> $1
                       LIMIT 1`;
            dupParams = [toPgVector(memory.embedding), deduplicateThreshold];
          }

          const dupResult = await client.query<{ id: number; similarity: number }>(dupQuery, dupParams);

          if (dupResult.rows.length > 0) {
            results.push({
              index: i,
              isDuplicate: true,
              id: dupResult.rows[0].id,
              reason: 'duplicate',
              similarity: parseFloat(String(dupResult.rows[0].similarity)),
            });
            skipped++;
            continue;
          }
        }

        // Insert memory
        const validFromStr = memory.validFrom
          ? (memory.validFrom instanceof Date ? memory.validFrom.toISOString() : memory.validFrom)
          : null;
        const validUntilStr = memory.validUntil
          ? (memory.validUntil instanceof Date ? memory.validUntil.toISOString() : memory.validUntil)
          : null;

        const insertResult = await client.query<{ id: number }>(
          `INSERT INTO memories (project_id, content, tags, source, type, quality_score, quality_factors, embedding, valid_from, valid_until)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            this.projectId,
            memory.content,
            memory.tags.length > 0 ? JSON.stringify(memory.tags) : null,
            memory.source ?? null,
            memory.type,
            memory.qualityScore?.score ?? null,
            memory.qualityScore?.factors ? JSON.stringify(memory.qualityScore.factors) : null,
            toPgVector(memory.embedding),
            validFromStr,
            validUntilStr,
          ]
        );

        results.push({
          index: i,
          isDuplicate: false,
          id: insertResult.rows[0].id,
          reason: 'saved',
        });
        saved++;
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    results.sort((a, b) => a.index - b.index);
    return { saved, skipped, results };
  }

  async getMemoryStats(): Promise<{
    total_memories: number;
    active_memories: number;
    invalidated_memories: number;
    oldest_memory: string | null;
    newest_memory: string | null;
    by_type: Record<string, number>;
    stale_count: number;
  }> {
    const pool = await this.getPool();

    const scopeCond = this.projectId
      ? '(project_id = $1 OR project_id IS NULL)'
      : 'project_id IS NULL';
    const scopeParams = this.projectId ? [this.projectId] : [];

    const total = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM memories WHERE ${scopeCond}`, scopeParams
    );
    const active = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM memories WHERE ${scopeCond} AND invalidated_by IS NULL`, scopeParams
    );
    const oldest = await pool.query<{ oldest: string | null }>(
      `SELECT MIN(created_at)::text as oldest FROM memories WHERE ${scopeCond} AND invalidated_by IS NULL`, scopeParams
    );
    const newest = await pool.query<{ newest: string | null }>(
      `SELECT MAX(created_at)::text as newest FROM memories WHERE ${scopeCond} AND invalidated_by IS NULL`, scopeParams
    );

    const typeCounts = await pool.query<{ type: string; count: string }>(
      `SELECT COALESCE(type, 'observation') as type, COUNT(*) as count
       FROM memories WHERE ${scopeCond} AND invalidated_by IS NULL
       GROUP BY type`, scopeParams
    );

    const by_type: Record<string, number> = {};
    for (const row of typeCounts.rows) {
      by_type[row.type] = parseInt(row.count);
    }

    // Stale memories: older than 30 days, active only
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const staleParamIdx = scopeParams.length + 1;
    const stale = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM memories
       WHERE ${scopeCond} AND created_at < $${staleParamIdx} AND invalidated_by IS NULL`,
      [...scopeParams, thirtyDaysAgo]
    );

    const totalCount = parseInt(total.rows[0].count);
    const activeCount = parseInt(active.rows[0].count);

    return {
      total_memories: totalCount,
      active_memories: activeCount,
      invalidated_memories: totalCount - activeCount,
      oldest_memory: oldest.rows[0].oldest,
      newest_memory: newest.rows[0].newest,
      by_type,
      stale_count: parseInt(stale.rows[0].count),
    };
  }

  async deleteMemoriesOlderThan(date: Date): Promise<number> {
    const pool = await this.getPool();
    const result = await pool.query(
      'DELETE FROM memories WHERE created_at < $1',
      [date.toISOString()]
    );
    return result.rowCount ?? 0;
  }

  async deleteMemoriesByTag(tag: string): Promise<number> {
    const pool = await this.getPool();
    // JSONB array containment: tags is a JSONB array, check if any element matches (case-insensitive)
    const result = await pool.query(
      `DELETE FROM memories
       WHERE tags IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(tags) elem
           WHERE LOWER(elem) = LOWER($1)
         )`,
      [tag]
    );
    return result.rowCount ?? 0;
  }

  async deleteMemoriesByIds(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const pool = await this.getPool();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const result = await pool.query(
      `DELETE FROM memories WHERE id IN (${placeholders})`,
      ids
    );
    return result.rowCount ?? 0;
  }

  async searchMemoriesAsOf(
    queryEmbedding: number[],
    asOfDate: Date,
    limit: number = 5,
    threshold: number = 0.3
  ): Promise<Array<Memory & { similarity: number }>> {
    const pool = await this.getPool();
    const asOfStr = asOfDate.toISOString();

    // Get memories that existed at that time, with temporal validity check
    const scopeCond = this.projectId
      ? '(project_id = $4 OR project_id IS NULL)'
      : 'project_id IS NULL';
    const scopeParams = this.projectId ? [this.projectId] : [];

    const result = await pool.query(
      `SELECT id, project_id, content, tags, source, type, quality_score, quality_factors,
              access_count, last_accessed, valid_from, valid_until, created_at,
              1 - (embedding <=> $1) as similarity
       FROM memories
       WHERE created_at <= $2
         AND 1 - (embedding <=> $1) >= $3
         AND ${scopeCond}
         AND (valid_from IS NULL OR valid_from <= $2)
         AND (valid_until IS NULL OR valid_until > $2)
       ORDER BY embedding <=> $1
       LIMIT $${scopeParams.length + 4}`,
      [toPgVector(queryEmbedding), asOfStr, threshold, ...scopeParams, limit]
    );

    return result.rows.map((row: any) => ({
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
  }

  async getConsolidationHistory(limit: number = 20): Promise<Array<{
    mergedMemoryId: number;
    mergedContent: string;
    originalIds: number[];
    mergedAt: string;
  }>> {
    const pool = await this.getPool();

    // Find memories that have 'supersedes' links (merge results)
    const rows = await pool.query<{ merged_id: number; merged_at: string }>(
      `SELECT DISTINCT ml.source_id as merged_id, ml.created_at::text as merged_at
       FROM memory_links ml
       WHERE ml.relation = 'supersedes'
       ORDER BY ml.created_at DESC
       LIMIT $1`,
      [limit]
    );

    const results: Array<{
      mergedMemoryId: number;
      mergedContent: string;
      originalIds: number[];
      mergedAt: string;
    }> = [];

    for (const row of rows.rows) {
      const memory = await this.getMemoryById(row.merged_id);
      const originals = await pool.query<{ target_id: number }>(
        `SELECT target_id FROM memory_links
         WHERE source_id = $1 AND relation = 'supersedes'`,
        [row.merged_id]
      );

      results.push({
        mergedMemoryId: row.merged_id,
        mergedContent: memory?.content ?? '(deleted)',
        originalIds: originals.rows.map(o => o.target_id),
        mergedAt: row.merged_at,
      });
    }

    return results;
  }

  // ============================================================================
  // Retention Operations
  // ============================================================================

  async incrementMemoryAccessBatch(accesses: Array<{ memoryId: number; weight: number }>): Promise<void> {
    if (accesses.length === 0) return;
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { memoryId, weight } of accesses) {
        await client.query(
          `UPDATE memories
           SET access_count = COALESCE(access_count, 0) + $1,
               last_accessed = NOW()
           WHERE id = $2`,
          [weight, memoryId]
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

  async getAllMemoriesForRetention(): Promise<MemoryForRetention[]> {
    const pool = await this.getPool();

    const scopeCond = this.projectId
      ? 'WHERE (project_id = $1 OR project_id IS NULL)'
      : 'WHERE project_id IS NULL';
    const params = this.projectId ? [this.projectId] : [];

    const result = await pool.query(
      `SELECT id, content, quality_score, access_count, created_at::text as created_at, last_accessed::text as last_accessed
       FROM memories
       ${scopeCond}
       ORDER BY created_at ASC`,
      params
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      content: row.content,
      quality_score: row.quality_score,
      access_count: row.access_count ?? 0,
      created_at: row.created_at,
      last_accessed: row.last_accessed,
    }));
  }

  // ============================================================================
  // Backfill — fetch all records with embeddings for Qdrant sync
  // ============================================================================

  async getAllMemoriesWithEmbeddings(): Promise<Array<{
    id: number; content: string; tags: string[]; source: string | null;
    type: string | null; projectId: string | null; createdAt: string;
    validFrom: string | null; validUntil: string | null;
    invalidatedBy: number | null; accessCount: number;
    lastAccessed: string | null; qualityScore: number | null;
    embedding: number[];
  }>> {
    const pool = await this.getPool();
    const scopeCond = this.projectId
      ? 'WHERE project_id = $1 AND invalidated_by IS NULL'
      : 'WHERE project_id IS NULL AND invalidated_by IS NULL';
    const params = this.projectId ? [this.projectId] : [];

    const result = await pool.query(
      `SELECT id, content, tags, source, type, project_id,
              created_at::text as created_at, valid_from::text as valid_from,
              valid_until::text as valid_until, invalidated_by, access_count,
              last_accessed::text as last_accessed, quality_score,
              embedding::text as embedding
       FROM memories ${scopeCond}
       ORDER BY id ASC`,
      params
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      content: row.content,
      tags: row.tags ?? [],
      source: row.source,
      type: row.type,
      projectId: row.project_id,
      createdAt: row.created_at,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      invalidatedBy: row.invalidated_by,
      accessCount: row.access_count ?? 0,
      lastAccessed: row.last_accessed,
      qualityScore: row.quality_score,
      embedding: fromPgVector(row.embedding),
    }));
  }

  async getAllDocumentsWithEmbeddings(): Promise<Array<{
    id: number; filePath: string; content: string;
    startLine: number; endLine: number; projectId: string;
    embedding: number[];
  }>> {
    const pool = await this.getPool();
    const scopeCond = this.projectId ? 'WHERE project_id = $1' : '';
    const params = this.projectId ? [this.projectId] : [];

    const result = await pool.query(
      `SELECT id, file_path, content, start_line, end_line, project_id,
              embedding::text as embedding
       FROM documents ${scopeCond}
       ORDER BY id ASC`,
      params
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      filePath: row.file_path,
      content: row.content,
      startLine: row.start_line,
      endLine: row.end_line,
      projectId: row.project_id,
      embedding: fromPgVector(row.embedding),
    }));
  }

  // ============================================================================
  // Graph Operations - Additional
  // ============================================================================

  async getMemoryWithLinks(
    memoryId: number,
    options?: { asOfDate?: Date; includeExpired?: boolean }
  ): Promise<MemoryWithLinks | null> {
    const memory = await this.getMemoryById(memoryId);
    if (!memory) return null;

    const links = await this.getMemoryLinks(memoryId);
    const now = options?.asOfDate?.getTime() ?? Date.now();
    const includeExpired = options?.includeExpired ?? false;

    const filterLink = (link: MemoryLink) => {
      if (includeExpired) return true;
      if (link.valid_from) {
        const validFrom = new Date(link.valid_from).getTime();
        if (now < validFrom) return false;
      }
      if (link.valid_until) {
        const validUntil = new Date(link.valid_until).getTime();
        if (now > validUntil) return false;
      }
      return true;
    };

    // Fetch content for linked memories
    const pool = await this.getPool();

    const outgoing = [];
    for (const l of links.outgoing.filter(filterLink)) {
      const targetMem = await pool.query<{ content: string }>(
        'SELECT content FROM memories WHERE id = $1', [l.target_id]
      );
      outgoing.push({
        target_id: l.target_id,
        relation: l.relation as LinkRelation,
        weight: l.weight,
        target_content: targetMem.rows[0]?.content ?? '',
      });
    }

    const incoming = [];
    for (const l of links.incoming.filter(filterLink)) {
      const sourceMem = await pool.query<{ content: string }>(
        'SELECT content FROM memories WHERE id = $1', [l.source_id]
      );
      incoming.push({
        source_id: l.source_id,
        relation: l.relation as LinkRelation,
        weight: l.weight,
        source_content: sourceMem.rows[0]?.content ?? '',
      });
    }

    return {
      ...memory,
      outgoing_links: outgoing,
      incoming_links: incoming,
    };
  }

  async findConnectedMemories(
    memoryId: number,
    maxDepth: number = 2
  ): Promise<Array<{ memory: Memory; depth: number; path: number[] }>> {
    const pool = await this.getPool();
    const visited = new Set<number>([memoryId]);
    const results: Array<{ memory: Memory; depth: number; path: number[] }> = [];

    // BFS traversal
    let currentLevel = [{ id: memoryId, path: [memoryId] }];

    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextLevel: Array<{ id: number; path: number[] }> = [];

      for (const { id, path } of currentLevel) {
        const outgoing = await pool.query<{ target_id: number }>(
          'SELECT target_id FROM memory_links WHERE source_id = $1',
          [id]
        );
        const incoming = await pool.query<{ source_id: number }>(
          'SELECT source_id FROM memory_links WHERE target_id = $1',
          [id]
        );

        const neighbors = [
          ...outgoing.rows.map(r => r.target_id),
          ...incoming.rows.map(r => r.source_id),
        ];

        for (const neighborId of neighbors) {
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            const memory = await this.getMemoryById(neighborId);
            if (memory) {
              const newPath = [...path, neighborId];
              results.push({ memory, depth, path: newPath });
              nextLevel.push({ id: neighborId, path: newPath });
            }
          }
        }
      }

      currentLevel = nextLevel;
    }

    return results;
  }

  async findRelatedMemoriesForLinking(
    memoryId: number,
    threshold: number = 0.75,
    maxLinks: number = 3
  ): Promise<Array<{ id: number; similarity: number }>> {
    const pool = await this.getPool();

    // Use pgvector to find similar memories efficiently
    const source = await pool.query<{ embedding: string }>(
      'SELECT embedding FROM memories WHERE id = $1',
      [memoryId]
    );
    if (source.rows.length === 0) return [];

    const result = await pool.query<{ id: number; similarity: number }>(
      `SELECT id, 1 - (embedding <=> (SELECT embedding FROM memories WHERE id = $1)) as similarity
       FROM memories
       WHERE id != $1
         AND 1 - (embedding <=> (SELECT embedding FROM memories WHERE id = $1)) >= $2
       ORDER BY embedding <=> (SELECT embedding FROM memories WHERE id = $1)
       LIMIT $3`,
      [memoryId, threshold, maxLinks]
    );

    return result.rows.map(r => ({
      id: r.id,
      similarity: parseFloat(String(r.similarity)),
    }));
  }

  async createAutoLinks(
    memoryId: number,
    threshold: number = 0.75,
    maxLinks: number = 3
  ): Promise<number> {
    const candidates = await this.findRelatedMemoriesForLinking(memoryId, threshold, maxLinks);

    let linksCreated = 0;
    for (const { id: targetId, similarity } of candidates) {
      const result = await this.createMemoryLink(memoryId, targetId, 'similar_to', similarity);
      if (result.created) {
        linksCreated++;
      }
    }

    return linksCreated;
  }

  async autoLinkSimilarMemories(
    threshold: number = 0.75,
    maxLinks: number = 3
  ): Promise<number> {
    const pool = await this.getPool();

    const scopeCond = this.projectId
      ? 'WHERE (project_id = $1 OR project_id IS NULL)'
      : 'WHERE project_id IS NULL';
    const params = this.projectId ? [this.projectId] : [];

    // Get all memory IDs
    const memories = await pool.query<{ id: number }>(
      `SELECT id FROM memories ${scopeCond}`,
      params
    );

    let linksCreated = 0;
    for (const { id } of memories.rows) {
      const created = await this.createAutoLinks(id, threshold, maxLinks);
      linksCreated += created;
    }

    return linksCreated;
  }

  async invalidateMemoryLink(
    sourceId: number,
    targetId: number,
    relation?: LinkRelation
  ): Promise<boolean> {
    const pool = await this.getPool();

    if (relation) {
      const result = await pool.query(
        `UPDATE memory_links SET valid_until = NOW()
         WHERE source_id = $1 AND target_id = $2 AND relation = $3 AND valid_until IS NULL`,
        [sourceId, targetId, relation]
      );
      return (result.rowCount ?? 0) > 0;
    } else {
      const result = await pool.query(
        `UPDATE memory_links SET valid_until = NOW()
         WHERE source_id = $1 AND target_id = $2 AND valid_until IS NULL`,
        [sourceId, targetId]
      );
      return (result.rowCount ?? 0) > 0;
    }
  }

  async getMemoryLinksAsOf(
    memoryId: number,
    asOfDate: Date
  ): Promise<{ outgoing: MemoryLink[]; incoming: MemoryLink[] }> {
    const pool = await this.getPool();
    const asOfStr = asOfDate.toISOString();

    const outgoing = await pool.query<MemoryLink>(
      `SELECT * FROM memory_links
       WHERE source_id = $1
         AND created_at <= $2
         AND (valid_from IS NULL OR valid_from <= $2)
         AND (valid_until IS NULL OR valid_until > $2)`,
      [memoryId, asOfStr]
    );

    const incoming = await pool.query<MemoryLink>(
      `SELECT * FROM memory_links
       WHERE target_id = $1
         AND created_at <= $2
         AND (valid_from IS NULL OR valid_from <= $2)
         AND (valid_until IS NULL OR valid_until > $2)`,
      [memoryId, asOfStr]
    );

    return { outgoing: outgoing.rows, incoming: incoming.rows };
  }

  async findConnectedMemoriesAsOf(
    memoryId: number,
    asOfDate: Date,
    maxDepth: number = 2
  ): Promise<Array<{ memory: Memory; depth: number; path: number[] }>> {
    const pool = await this.getPool();
    const asOfStr = asOfDate.toISOString();
    const visited = new Set<number>([memoryId]);
    const results: Array<{ memory: Memory; depth: number; path: number[] }> = [];

    let currentLevel = [{ id: memoryId, path: [memoryId] }];

    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextLevel: Array<{ id: number; path: number[] }> = [];

      for (const { id, path } of currentLevel) {
        const outgoing = await pool.query<{ target_id: number }>(
          `SELECT target_id FROM memory_links
           WHERE source_id = $1
             AND created_at <= $2
             AND (valid_from IS NULL OR valid_from <= $2)
             AND (valid_until IS NULL OR valid_until > $2)`,
          [id, asOfStr]
        );
        const incoming = await pool.query<{ source_id: number }>(
          `SELECT source_id FROM memory_links
           WHERE target_id = $1
             AND created_at <= $2
             AND (valid_from IS NULL OR valid_from <= $2)
             AND (valid_until IS NULL OR valid_until > $2)`,
          [id, asOfStr]
        );

        const neighbors = [
          ...outgoing.rows.map(r => r.target_id),
          ...incoming.rows.map(r => r.source_id),
        ];

        for (const neighborId of neighbors) {
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            const memory = await this.getMemoryById(neighborId);
            if (memory) {
              const newPath = [...path, neighborId];
              results.push({ memory, depth, path: newPath });
              nextLevel.push({ id: neighborId, path: newPath });
            }
          }
        }
      }

      currentLevel = nextLevel;
    }

    return results;
  }

  async getGraphStatsAsOf(asOfDate: Date): Promise<{
    total_memories: number;
    total_links: number;
    avg_links_per_memory: number;
    relations: Record<string, number>;
  }> {
    const pool = await this.getPool();
    const asOfStr = asOfDate.toISOString();

    const totalMemories = await pool.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM memories WHERE created_at <= $1',
      [asOfStr]
    );

    const totalLinks = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM memory_links
       WHERE created_at <= $1
         AND (valid_from IS NULL OR valid_from <= $1)
         AND (valid_until IS NULL OR valid_until > $1)`,
      [asOfStr]
    );

    const relationCounts = await pool.query<{ relation: string; count: string }>(
      `SELECT relation, COUNT(*) as count FROM memory_links
       WHERE created_at <= $1
         AND (valid_from IS NULL OR valid_from <= $1)
         AND (valid_until IS NULL OR valid_until > $1)
       GROUP BY relation`,
      [asOfStr]
    );

    const relations: Record<string, number> = {};
    for (const row of relationCounts.rows) {
      relations[row.relation] = parseInt(row.count);
    }

    const memCount = parseInt(totalMemories.rows[0].count);
    const linkCount = parseInt(totalLinks.rows[0].count);

    return {
      total_memories: memCount,
      total_links: linkCount,
      avg_links_per_memory: memCount > 0 ? linkCount / memCount : 0,
      relations,
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
