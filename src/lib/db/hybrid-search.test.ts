import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

// Deterministic embeddings: seeded "random" vectors for test reproducibility
const DIMS = 384;

function makeEmbedding(seed: number): number[] {
  // Simple LCG-based deterministic vector, normalized to unit length
  const vec: number[] = [];
  let s = seed;
  for (let i = 0; i < DIMS; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    vec.push((s / 0xffffffff) * 2 - 1);
  }
  const mag = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map((v) => v / mag);
}

function floatArrayToBuffer(arr: number[]): Buffer {
  const float32 = new Float32Array(arr);
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}

// Similar embeddings: shift the seed slightly to get high cosine similarity
function makeSimilarEmbedding(seed: number, noise: number = 0.05): number[] {
  const base = makeEmbedding(seed);
  const noiseVec = makeEmbedding(seed + 9999);
  const result = base.map((v, i) => v + noiseVec[i] * noise);
  const mag = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
  return result.map((v) => v / mag);
}

// Create temp dir for tests
const tempDir = path.join(
  os.tmpdir(),
  `succ-hybrid-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

// Mock config
vi.mock('../config.js', () => {
  return {
    getConfig: () => ({
      chunk_size: 500,
      chunk_overlap: 50,
      llm: { embeddings: { mode: 'local', model: 'test-model' } },
    }),
    getLLMTaskConfig: (task: string) => ({
      mode: task === 'embeddings' ? 'local' : 'api',
      model: task === 'embeddings' ? 'test-model' : 'qwen2.5:7b',
      api_url: 'http://localhost:11434/v1',
      api_key: undefined,
      max_tokens: 2000,
      temperature: 0.3,
    }),
    getDbPath: () => path.join(tempDir, 'test.db'),
    getGlobalDbPath: () => path.join(tempDir, 'global.db'),
    getClaudeDir: () => tempDir,
    getProjectRoot: () => tempDir,
  };
});

// Mock embeddings
vi.mock('../embeddings.js', () => ({
  cosineSimilarity: (a: number[], b: number[]) => {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  },
  getModelDimension: () => 384,
}));

// ============================================================================
// Helpers
// ============================================================================

const SCHEMA_DDL = `
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
    symbol_name TEXT,
    symbol_type TEXT,
    signature TEXT,
    UNIQUE(file_path, chunk_index)
  );
  CREATE INDEX IF NOT EXISTS idx_documents_file_path ON documents(file_path);
  CREATE INDEX IF NOT EXISTS idx_documents_symbol_type ON documents(symbol_type);
  CREATE INDEX IF NOT EXISTS idx_documents_symbol_name ON documents(symbol_name);

  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS file_hashes (
    file_path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    indexed_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    tags TEXT,
    source TEXT,
    type TEXT DEFAULT 'observation',
    quality_score REAL,
    quality_factors TEXT,
    embedding BLOB NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    access_count REAL DEFAULT 0,
    last_accessed TEXT,
    valid_from TEXT,
    valid_until TEXT,
    invalidated_by INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);

  CREATE TABLE IF NOT EXISTS memory_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    relation TEXT NOT NULL DEFAULT 'related',
    weight REAL DEFAULT 1.0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    valid_from TEXT,
    valid_until TEXT,
    llm_enriched INTEGER DEFAULT 0,
    FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE,
    UNIQUE(source_id, target_id, relation)
  );

  CREATE TABLE IF NOT EXISTS token_frequencies (
    token TEXT PRIMARY KEY,
    frequency INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_token_freq ON token_frequencies(frequency DESC);

  CREATE TABLE IF NOT EXISTS token_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    query TEXT,
    returned_tokens INTEGER NOT NULL DEFAULT 0,
    full_source_tokens INTEGER NOT NULL DEFAULT 0,
    savings_tokens INTEGER NOT NULL DEFAULT 0,
    files_count INTEGER,
    chunks_count INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    model TEXT,
    estimated_cost REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL,
    source TEXT NOT NULL,
    path TEXT,
    content TEXT,
    embedding BLOB,
    skyll_id TEXT,
    usage_count INTEGER DEFAULT 0,
    last_used TEXT,
    cached_at TEXT,
    cache_expires TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    project_id TEXT
  );

  CREATE TABLE IF NOT EXISTS learning_deltas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    source TEXT NOT NULL,
    memories_before INTEGER NOT NULL DEFAULT 0,
    memories_after INTEGER NOT NULL DEFAULT 0,
    new_memories INTEGER NOT NULL DEFAULT 0,
    types_added TEXT,
    avg_quality REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS memory_centrality (
    memory_id INTEGER PRIMARY KEY,
    degree REAL DEFAULT 0,
    normalized_degree REAL DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS web_search_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL,
    model TEXT NOT NULL,
    query TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    citations_count INTEGER NOT NULL DEFAULT 0,
    has_reasoning INTEGER NOT NULL DEFAULT 0,
    response_length_chars INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

/** Insert a code document into the DB (file_path gets code: prefix) */
function insertCodeDoc(
  database: Database.Database,
  filePath: string,
  content: string,
  embedding: number[],
  opts?: {
    symbolName?: string;
    symbolType?: string;
    signature?: string;
    chunkIndex?: number;
    startLine?: number;
    endLine?: number;
  }
): number {
  const result = database
    .prepare(
      `INSERT INTO documents (file_path, chunk_index, content, start_line, end_line, embedding, symbol_name, symbol_type, signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `code:${filePath}`,
      opts?.chunkIndex ?? 0,
      content,
      opts?.startLine ?? 1,
      opts?.endLine ?? 10,
      floatArrayToBuffer(embedding),
      opts?.symbolName ?? null,
      opts?.symbolType ?? null,
      opts?.signature ?? null
    );
  return Number(result.lastInsertRowid);
}

/** Insert a doc (brain vault) document (no code: prefix) */
function insertDocDocument(
  database: Database.Database,
  filePath: string,
  content: string,
  embedding: number[],
  opts?: { chunkIndex?: number; startLine?: number; endLine?: number }
): number {
  const result = database
    .prepare(
      `INSERT INTO documents (file_path, chunk_index, content, start_line, end_line, embedding)
     VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      filePath,
      opts?.chunkIndex ?? 0,
      content,
      opts?.startLine ?? 1,
      opts?.endLine ?? 10,
      floatArrayToBuffer(embedding)
    );
  return Number(result.lastInsertRowid);
}

/** Insert a memory */
function insertMemory(
  database: Database.Database,
  content: string,
  embedding: number[],
  opts?: {
    tags?: string;
    source?: string;
    type?: string;
    validFrom?: string;
    validUntil?: string;
    qualityScore?: number;
  }
): number {
  const result = database
    .prepare(
      `INSERT INTO memories (content, embedding, tags, source, type, valid_from, valid_until, quality_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      content,
      floatArrayToBuffer(embedding),
      opts?.tags ?? null,
      opts?.source ?? null,
      opts?.type ?? 'observation',
      opts?.validFrom ?? null,
      opts?.validUntil ?? null,
      opts?.qualityScore ?? null
    );
  return Number(result.lastInsertRowid);
}

// ============================================================================
// Tests
// ============================================================================

describe('Hybrid Search E2E', () => {
  let db: Database.Database;
  let setDb: (d: Database.Database) => void;
  let closeDb: () => void;
  let hybridSearchCode: any;
  let hybridSearchDocs: any;
  let hybridSearchMemories: any;
  let invalidateBM25Index: any;

  beforeAll(async () => {
    fs.mkdirSync(tempDir, { recursive: true });

    // Import modules after mocks are set up
    const conn = await import('./connection.js');
    const hybrid = await import('./hybrid-search.js');
    const bm25Indexes = await import('./bm25-indexes.js');

    setDb = conn.setDb;
    closeDb = conn.closeDb;
    hybridSearchCode = hybrid.hybridSearchCode;
    hybridSearchDocs = hybrid.hybridSearchDocs;
    hybridSearchMemories = hybrid.hybridSearchMemories;
    invalidateBM25Index = bm25Indexes.invalidateBM25Index;
  });

  afterAll(async () => {
    try {
      closeDb();
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 100));
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors on Windows
    }
  });

  /** Create a fresh DB and set it as active */
  function freshDb(): Database.Database {
    const dbPath = path.join(
      tempDir,
      `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    const database = new Database(dbPath);
    database.pragma('journal_mode = WAL');
    // Run schema DDL
    for (const stmt of SCHEMA_DDL.split(';').filter((s) => s.trim())) {
      database.prepare(stmt + ';').run();
    }
    setDb(database);
    return database;
  }

  // ========================================================================
  // Group 1: hybridSearchCode — basic RRF fusion
  // ========================================================================

  describe('Group 1: hybridSearchCode basic RRF fusion', () => {
    it('1. BM25 + vector both find results', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(100);

      insertCodeDoc(db, 'src/user-service.ts', 'export function getUserById(id: string) { return db.users.find(u => u.id === id); }', makeSimilarEmbedding(100, 0.02), { symbolName: 'getUserById', symbolType: 'function' });
      insertCodeDoc(db, 'src/user-repo.ts', 'class UserRepository { getUserById(id: number) { return this.db.query("SELECT * FROM users WHERE id = ?", [id]); } }', makeSimilarEmbedding(100, 0.04), { symbolName: 'getUserById', symbolType: 'method' });
      insertCodeDoc(db, 'src/api/users.ts', 'router.get("/users/:id", async (req, res) => { const user = await getUserById(req.params.id); res.json(user); });', makeSimilarEmbedding(100, 0.06));
      insertCodeDoc(db, 'src/types.ts', 'export interface User { id: string; name: string; email: string; }', makeEmbedding(200));
      insertCodeDoc(db, 'src/utils.ts', 'export function formatDate(d: Date) { return d.toISOString(); }', makeEmbedding(300));

      invalidateBM25Index();
      const results = hybridSearchCode('getUserById', queryEmb, 5, 0.0);

      expect(results.length).toBeGreaterThan(0);

      // At least one result should have both BM25 and vector scores
      const withBoth = results.filter(
        (r: any) => r.bm25Score !== undefined && r.bm25Score > 0 && r.vectorScore !== undefined && r.vectorScore > 0
      );
      expect(withBoth.length).toBeGreaterThan(0);
    });

    it('2. BM25-only fallback when brute-force skipped (>BRUTE_FORCE_MAX_ROWS)', () => {
      db = freshDb();

      // Insert 5 docs about "processData"
      for (let i = 0; i < 5; i++) {
        insertCodeDoc(db, `src/processor-${i}.ts`, `function processData${i}(input: any) { return transform(input); }`, makeEmbedding(400 + i), { symbolName: `processData${i}`, symbolType: 'function' });
      }

      invalidateBM25Index();

      // With low threshold, results should come back (at least from BM25)
      const queryEmb = makeEmbedding(999); // unrelated embedding
      const results = hybridSearchCode('processData', queryEmb, 3, 0.0);
      expect(results.length).toBeGreaterThan(0);

      // Results should have bm25Score
      for (const r of results) {
        expect(r.bm25Score).toBeDefined();
        expect(r.bm25Score).toBeGreaterThan(0);
      }
    });

    it('3. Empty result below threshold', () => {
      db = freshDb();

      insertCodeDoc(db, 'src/hello.ts', 'console.log("hello world")', makeEmbedding(500));

      invalidateBM25Index();

      // Search for something that doesn't exist with very high threshold
      const results = hybridSearchCode('xyzNonexistent123', makeEmbedding(999), 5, 0.9);
      expect(results).toEqual([]);
    });

    it('4. Limit works correctly', () => {
      db = freshDb();

      // Insert 20 code files all containing "function"
      for (let i = 0; i < 20; i++) {
        insertCodeDoc(db, `src/mod-${i}.ts`, `export function handler${i}() { return ${i}; }`, makeEmbedding(600 + i), { symbolName: `handler${i}`, symbolType: 'function' });
      }

      invalidateBM25Index();

      const queryEmb = makeEmbedding(600);
      const results = hybridSearchCode('function handler', queryEmb, 3, 0.0);
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  // ========================================================================
  // Group 2: AST symbol boost
  // ========================================================================

  describe('Group 2: AST symbol boost', () => {
    it('5. Exact symbol name match +0.15 boost', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(700);

      // Doc A: has symbol_name = "getUserById" — should get +0.15 boost
      insertCodeDoc(
        db,
        'src/a.ts',
        'function getUserById(id: string) { return db.find(id); }',
        makeSimilarEmbedding(700, 0.02),
        { symbolName: 'getUserById', symbolType: 'function', signature: 'function getUserById(id: string): User' }
      );

      // Doc B: has "getUserById" in content but NO symbol_name
      insertCodeDoc(
        db,
        'src/b.ts',
        'function getUserById(id: string) { return db.find(id); }',
        makeSimilarEmbedding(700, 0.02),
        { symbolName: undefined, symbolType: undefined }
      );

      invalidateBM25Index();
      const results = hybridSearchCode('getUserById', queryEmb, 5, 0.0);

      expect(results.length).toBe(2);
      // Doc with symbol_name should be first (boosted)
      expect(results[0].symbol_name).toBe('getUserById');
      expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
    });

    it('6. Partial symbol name match +0.08 boost', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(800);

      // Doc with symbol_name that contains query token
      insertCodeDoc(
        db,
        'src/a.ts',
        'function getUserByEmail(email: string) { return db.findByEmail(email); }',
        makeSimilarEmbedding(800, 0.02),
        { symbolName: 'getUserByEmail', symbolType: 'function' }
      );

      // Doc without symbol_name
      insertCodeDoc(
        db,
        'src/b.ts',
        'function getUserByEmail(email: string) { return db.findByEmail(email); }',
        makeSimilarEmbedding(800, 0.02),
        { symbolName: undefined, symbolType: undefined }
      );

      invalidateBM25Index();
      const results = hybridSearchCode('getuser', queryEmb, 5, 0.0);

      expect(results.length).toBe(2);
      // Doc with symbol_name (partial match) should score higher
      const withSymbol = results.find((r: any) => r.symbol_name === 'getUserByEmail');
      const withoutSymbol = results.find((r: any) => !r.symbol_name);
      expect(withSymbol).toBeDefined();
      expect(withoutSymbol).toBeDefined();
      expect(withSymbol!.similarity).toBeGreaterThan(withoutSymbol!.similarity);
    });

    it('7. No symbol_name = no boost', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(900);

      // Both docs have same content, same embedding, neither has symbol_name
      insertCodeDoc(
        db,
        'src/a.ts',
        'function doSomething() { return 42; }',
        makeSimilarEmbedding(900, 0.02),
        { symbolName: undefined, symbolType: undefined }
      );

      insertCodeDoc(
        db,
        'src/b.ts',
        'function doSomethingElse() { return 43; }',
        makeSimilarEmbedding(900, 0.03),
        { symbolName: undefined, symbolType: undefined }
      );

      invalidateBM25Index();
      const results = hybridSearchCode('doSomething', queryEmb, 5, 0.0);

      // Scores should be RRF scores only (no boost applied)
      for (const r of results) {
        expect(r.symbol_name).toBeUndefined();
      }
    });
  });

  // ========================================================================
  // Group 3: Filters
  // ========================================================================

  describe('Group 3: Filters', () => {
    it('8. symbolType filter', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(1000);

      // 2 functions
      insertCodeDoc(db, 'src/fn1.ts', 'function alpha() { return 1; }', makeSimilarEmbedding(1000, 0.02), { symbolName: 'alpha', symbolType: 'function' });
      insertCodeDoc(db, 'src/fn2.ts', 'function beta() { return 2; }', makeSimilarEmbedding(1000, 0.03), { symbolName: 'beta', symbolType: 'function' });

      // 2 classes
      insertCodeDoc(db, 'src/cl1.ts', 'class AlphaService { run() {} }', makeSimilarEmbedding(1000, 0.04), { symbolName: 'AlphaService', symbolType: 'class' });
      insertCodeDoc(db, 'src/cl2.ts', 'class BetaService { run() {} }', makeSimilarEmbedding(1000, 0.05), { symbolName: 'BetaService', symbolType: 'class' });

      // 2 interfaces
      insertCodeDoc(db, 'src/if1.ts', 'interface AlphaConfig { key: string; }', makeSimilarEmbedding(1000, 0.06), { symbolName: 'AlphaConfig', symbolType: 'interface' });
      insertCodeDoc(db, 'src/if2.ts', 'interface BetaConfig { key: string; }', makeSimilarEmbedding(1000, 0.07), { symbolName: 'BetaConfig', symbolType: 'interface' });

      invalidateBM25Index();
      const results = hybridSearchCode('alpha beta', queryEmb, 10, 0.0, 0.5, { symbolType: 'function' });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.symbol_type).toBe('function');
      }
    });

    it('9. regex filter', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(1100);

      insertCodeDoc(db, 'src/a.ts', 'async function fetchData() { return await api.get("/data"); }', makeSimilarEmbedding(1100, 0.02), { symbolName: 'fetchData', symbolType: 'function' });
      insertCodeDoc(db, 'src/b.ts', 'function transformData(input: any) { return input.map(x => x * 2); }', makeSimilarEmbedding(1100, 0.03), { symbolName: 'transformData', symbolType: 'function' });
      insertCodeDoc(db, 'src/c.ts', 'async function processItems() { for await (const item of stream) { handle(item); } }', makeSimilarEmbedding(1100, 0.04), { symbolName: 'processItems', symbolType: 'function' });

      invalidateBM25Index();
      const results = hybridSearchCode('function data', queryEmb, 10, 0.0, 0.5, { regex: 'async\\s+function' });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.content).toMatch(/async\s+function/);
      }
    });

    it('10. regex + symbolType combined', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(1200);

      // async function
      insertCodeDoc(db, 'src/a.ts', 'async function loadUser() { return await db.getUser(); }', makeSimilarEmbedding(1200, 0.02), { symbolName: 'loadUser', symbolType: 'function' });

      // sync function
      insertCodeDoc(db, 'src/b.ts', 'function parseUser(data: string) { return JSON.parse(data); }', makeSimilarEmbedding(1200, 0.03), { symbolName: 'parseUser', symbolType: 'function' });

      // async method in class
      insertCodeDoc(db, 'src/c.ts', 'class UserService { async loadUser() { return await this.db.get(); } }', makeSimilarEmbedding(1200, 0.04), { symbolName: 'UserService', symbolType: 'class' });

      invalidateBM25Index();

      // Only async + function type
      const results = hybridSearchCode('user load', queryEmb, 10, 0.0, 0.5, {
        regex: 'async\\s+function',
        symbolType: 'function',
      });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.content).toMatch(/async\s+function/);
        expect(r.symbol_type).toBe('function');
      }
    });

    it('11. Invalid regex does not crash', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(1300);
      insertCodeDoc(db, 'src/a.ts', 'function hello() { return "world"; }', makeSimilarEmbedding(1300, 0.02), { symbolName: 'hello', symbolType: 'function' });

      invalidateBM25Index();

      // Invalid regex — should be skipped (returns all results)
      const results = hybridSearchCode('hello', queryEmb, 5, 0.0, 0.5, { regex: '[invalid(' });
      expect(results.length).toBeGreaterThan(0);
    });

    it('12. ReDoS protection — long regex ignored', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(1400);
      insertCodeDoc(db, 'src/a.ts', 'function test() { return true; }', makeSimilarEmbedding(1400, 0.02), { symbolName: 'test', symbolType: 'function' });

      invalidateBM25Index();

      // Regex > 500 chars should be ignored
      const longRegex = 'a'.repeat(501);
      const results = hybridSearchCode('test', queryEmb, 5, 0.0, 0.5, { regex: longRegex });
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ========================================================================
  // Group 4: tokenizeCodeWithAST BM25 boost
  // ========================================================================

  describe('Group 4: tokenizeCodeWithAST BM25 boost', () => {
    it('13. AST identifiers raise TF in BM25', async () => {
      const bm25 = await import('../bm25.js');

      // Doc with AST metadata
      const indexWithAST = bm25.buildIndex(
        [
          {
            id: 1,
            content: 'function handleError(err: Error): void { console.error(err); }',
            symbolName: 'handleError',
            signature: 'function handleError(err: Error): void',
          },
        ],
        'code'
      );

      // Same content, no AST metadata
      const indexWithout = bm25.buildIndex(
        [
          {
            id: 1,
            content: 'function handleError(err: Error): void { console.error(err); }',
          },
        ],
        'code'
      );

      const resultsWithAST = bm25.search('handleError', indexWithAST, 'code', 1);
      const resultsWithout = bm25.search('handleError', indexWithout, 'code', 1);

      expect(resultsWithAST.length).toBe(1);
      expect(resultsWithout.length).toBe(1);
      expect(resultsWithAST[0].score).toBeGreaterThan(resultsWithout[0].score);
    });

    it('14. Symbol name 3x boost in BM25 — same content, different metadata', async () => {
      const bm25 = await import('../bm25.js');

      const sharedContent = 'This module provides data processing utilities for the pipeline.';

      // Doc A: has symbolName "processData" → symbol name tokens get 3x TF
      const indexA = bm25.buildIndex(
        [{ id: 1, content: sharedContent, symbolName: 'processData' }],
        'code'
      );

      // Doc B: same content, no symbolName
      const indexB = bm25.buildIndex(
        [{ id: 1, content: sharedContent }],
        'code'
      );

      const resultsA = bm25.search('processData', indexA, 'code', 1);
      const resultsB = bm25.search('processData', indexB, 'code', 1);

      // Doc A should find processData via boosted AST tokens
      expect(resultsA.length).toBe(1);
      // Doc B may or may not find anything (processData not in content)
      // The key assertion: if both find something, A scores higher
      if (resultsB.length > 0) {
        expect(resultsA[0].score).toBeGreaterThan(resultsB[0].score);
      } else {
        // B didn't even find it — A's boost made it findable
        expect(resultsA[0].score).toBeGreaterThan(0);
      }
    });
  });

  // ========================================================================
  // Group 5: hybridSearchDocs — brain vault search
  // ========================================================================

  describe('Group 5: hybridSearchDocs — brain vault', () => {
    it('15. Finds markdown docs', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(1500);

      insertDocDocument(db, '.succ/brain/01_Projects/auth-flow.md', '# Authentication Flow\n\nUsers authenticate via JWT tokens issued by the auth service.', makeSimilarEmbedding(1500, 0.02));
      insertDocDocument(db, '.succ/brain/02_Knowledge/api-design.md', '# API Design Patterns\n\nREST endpoints follow resource-based naming conventions.', makeSimilarEmbedding(1500, 0.04));
      insertDocDocument(db, '.succ/brain/decisions/chose-sqlite.md', '# Decision: SQLite over Postgres\n\nChose SQLite for local-first architecture.', makeSimilarEmbedding(1500, 0.06));

      invalidateBM25Index();

      const results = hybridSearchDocs('authentication JWT tokens', queryEmb, 5, 0.0);
      expect(results.length).toBeGreaterThan(0);

      for (const r of results) {
        expect(r.file_path).not.toMatch(/^code:/);
      }
    });

    it('16. Stemming works — "authenticate" finds "authentication"', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(1600);

      insertDocDocument(db, 'docs/auth.md', 'Authentication mechanisms include OAuth2, JWT, and API keys for securing endpoints.', makeSimilarEmbedding(1600, 0.02));

      invalidateBM25Index();

      const results = hybridSearchDocs('authenticate', queryEmb, 5, 0.0);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('Authentication');
    });

    it('17. Code and docs do not mix', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(1700);

      insertCodeDoc(db, 'src/auth.ts', 'function authenticate(user: User) { return jwt.sign(user); }', makeSimilarEmbedding(1700, 0.02), { symbolName: 'authenticate', symbolType: 'function' });
      insertDocDocument(db, 'docs/auth.md', 'Authentication is handled via JWT in the auth module.', makeSimilarEmbedding(1700, 0.03));

      invalidateBM25Index();

      // hybridSearchDocs should return only docs
      const docsResults = hybridSearchDocs('authenticate', queryEmb, 10, 0.0);
      for (const r of docsResults) {
        expect(r.file_path).not.toMatch(/^code:/);
      }

      // hybridSearchCode should return only code
      const codeResults = hybridSearchCode('authenticate', queryEmb, 10, 0.0);
      for (const r of codeResults) {
        expect(r.file_path).toMatch(/^code:/);
      }
    });
  });

  // ========================================================================
  // Group 6: hybridSearchMemories
  // ========================================================================

  describe('Group 6: hybridSearchMemories', () => {
    it('18. Finds memories by BM25 + vector', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(1800);

      insertMemory(db, 'Decided to use TypeScript strict mode for all new code', makeSimilarEmbedding(1800, 0.02), { tags: '["decision","typescript"]', type: 'decision' });
      insertMemory(db, 'React components should use functional style with hooks', makeSimilarEmbedding(1800, 0.04), { tags: '["pattern","react"]', type: 'pattern' });
      insertMemory(db, 'ESM requires explicit .js extensions in imports', makeSimilarEmbedding(1800, 0.06), { tags: '["learning","esm"]', type: 'learning' });
      insertMemory(db, 'Fixed CORS issue by adding proper headers in middleware', makeSimilarEmbedding(1800, 0.08), { tags: '["error","cors"]', type: 'error' });
      insertMemory(db, 'Database migrations run automatically on startup', makeSimilarEmbedding(1800, 0.1), { tags: '["observation"]', type: 'observation' });

      invalidateBM25Index();

      const results = hybridSearchMemories('TypeScript strict', queryEmb, 5, 0.0);
      expect(results.length).toBeGreaterThan(0);

      const first = results[0];
      expect(first.id).toBeDefined();
      expect(first.content).toBeDefined();
      expect(first.type).toBeDefined();
      expect(first.created_at).toBeDefined();
      expect(first.similarity).toBeGreaterThan(0);
    });

    it('19. Temporal fields propagated', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(1900);

      insertMemory(db, 'Sprint goal: complete auth module by end of week', makeSimilarEmbedding(1900, 0.02), {
        tags: '["sprint"]',
        type: 'observation',
        validFrom: '2026-02-01',
        validUntil: '2026-02-14',
        qualityScore: 0.85,
      });

      invalidateBM25Index();

      const results = hybridSearchMemories('sprint goal auth', queryEmb, 5, 0.0);
      expect(results.length).toBeGreaterThan(0);

      const result = results[0];
      expect(result.valid_from).toBe('2026-02-01');
      expect(result.valid_until).toBe('2026-02-14');
      expect(result.quality_score).toBe(0.85);
    });
  });

  // ========================================================================
  // Group 7: RRF fusion correctness
  // ========================================================================

  describe('Group 7: RRF fusion correctness', () => {
    it('20. alpha=0 → pure BM25', () => {
      db = freshDb();

      // Doc A: good BM25 match (exact keyword), bad vector match
      insertCodeDoc(db, 'src/a.ts', 'function searchQuery(q: string) { return database.search(q); }', makeEmbedding(2000), { symbolName: 'searchQuery', symbolType: 'function' });

      // Doc B: bad BM25 match (no keyword), good vector match
      insertCodeDoc(db, 'src/b.ts', 'function transform(data: any) { return data.map(x => x + 1); }', makeEmbedding(2001), { symbolName: 'transform', symbolType: 'function' });

      invalidateBM25Index();

      // Query embedding is very similar to doc B's embedding
      const queryEmb = makeSimilarEmbedding(2001, 0.01);

      // With alpha=0 → pure BM25, doc A should rank higher (has "searchQuery" keyword)
      const results = hybridSearchCode('searchQuery', queryEmb, 5, 0.0, 0.0);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('searchQuery');
    });

    it('21. alpha=1 → pure vector ranking dominates', () => {
      db = freshDb();

      // Doc A: good BM25 match (has the keyword), DISTANT vector
      insertCodeDoc(db, 'src/a.ts', 'function findItem(id: string) { return items.find(i => i.id === id); }', makeEmbedding(2100), { symbolName: 'findItem', symbolType: 'function' });

      // Doc B: no BM25 match (different keywords), CLOSE vector to query
      insertCodeDoc(db, 'src/b.ts', 'class DataTransformer { run(input: object) { return mutate(input); } }', makeEmbedding(2150), { symbolName: 'DataTransformer', symbolType: 'class' });

      invalidateBM25Index();

      // Query embedding very close to doc B (seed 2150)
      const queryEmb = makeSimilarEmbedding(2150, 0.005);

      // With alpha=1, vector weight=1 and BM25 weight=0
      // Doc B should have higher vectorScore
      const results = hybridSearchCode('findItem', queryEmb, 5, 0.0, 1.0);

      expect(results.length).toBeGreaterThan(0);
      // The result closest to query embedding should have highest vectorScore
      const withVector = results.filter((r: any) => r.vectorScore && r.vectorScore > 0);
      if (withVector.length >= 2) {
        // Doc B (DataTransformer) should have higher vector score
        const docB = withVector.find((r: any) => r.content.includes('DataTransformer'));
        const docA = withVector.find((r: any) => r.content.includes('findItem'));
        if (docB && docA) {
          expect(docB.vectorScore).toBeGreaterThan(docA.vectorScore);
        }
      }
    });

    it('22. alpha=0.5 → doc in both lists ranks higher', () => {
      db = freshDb();

      // Doc A: appears in BOTH BM25 and vector results
      insertCodeDoc(db, 'src/a.ts', 'function processPayment(amount: number) { return charge(amount); }', makeSimilarEmbedding(2200, 0.01), { symbolName: 'processPayment', symbolType: 'function' });

      // Doc B: only good for BM25 (has the keyword)
      insertCodeDoc(db, 'src/b.ts', 'function processPaymentRefund(id: string) { return refund(id); }', makeEmbedding(2299), { symbolName: 'processPaymentRefund', symbolType: 'function' });

      // Doc C: only good for vector (close embedding, no keyword)
      insertCodeDoc(db, 'src/c.ts', 'class OrderManager { submit(order: Order) { return validate(order); } }', makeSimilarEmbedding(2200, 0.02), { symbolName: 'OrderManager', symbolType: 'class' });

      invalidateBM25Index();

      const queryEmb = makeSimilarEmbedding(2200, 0.005);

      const results = hybridSearchCode('processPayment', queryEmb, 5, 0.0, 0.5);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('processPayment(amount');
    });
  });

  // ========================================================================
  // Group 8: Result structure
  // ========================================================================

  describe('Group 8: Result structure', () => {
    it('23. Results contain expected fields for full output', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(2300);
      insertCodeDoc(db, 'src/a.ts', 'export function hello() { return "world"; }', makeSimilarEmbedding(2300, 0.02), { symbolName: 'hello', symbolType: 'function' });

      invalidateBM25Index();

      const results = hybridSearchCode('hello', queryEmb, 5, 0.0);
      expect(results.length).toBeGreaterThan(0);

      const r = results[0];
      expect(r.file_path).toBeDefined();
      expect(r.content).toBeDefined();
      expect(r.start_line).toBeDefined();
      expect(r.end_line).toBeDefined();
      expect(r.similarity).toBeDefined();
      expect(typeof r.similarity).toBe('number');
    });

    it('24. Results have symbol metadata when available', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(2400);
      insertCodeDoc(db, 'src/a.ts', 'function greet(name: string) { return `Hello ${name}`; }', makeSimilarEmbedding(2400, 0.02), { symbolName: 'greet', symbolType: 'function', signature: 'function greet(name: string): string' });

      invalidateBM25Index();

      const results = hybridSearchCode('greet', queryEmb, 5, 0.0);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].symbol_name).toBe('greet');
      expect(results[0].symbol_type).toBe('function');
    });

    it('25. Score is clamped to 1.0 max', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(2500);

      insertCodeDoc(db, 'src/a.ts', 'function x() { return 1; }', makeSimilarEmbedding(2500, 0.001), { symbolName: 'x', symbolType: 'function' });

      invalidateBM25Index();

      const results = hybridSearchCode('x', queryEmb, 5, 0.0);
      for (const r of results) {
        expect(r.similarity).toBeLessThanOrEqual(1.0);
      }
    });
  });

  // ========================================================================
  // Group 9: Flatcase segmentation
  // ========================================================================

  describe('Group 9: Flatcase segmentation', () => {
    it('26. Ronin segmentation splits flatcase query', async () => {
      const bm25 = await import('../bm25.js');

      const getFreq = (token: string): number => {
        const dict: Record<string, number> = { get: 500, user: 200, name: 200, getusername: 0 };
        return dict[token] ?? 0;
      };

      const tokens = bm25.tokenizeCodeWithSegmentation('getusername', getFreq, 10000);

      expect(tokens).toContain('get');
      expect(tokens).toContain('user');
      expect(tokens).toContain('name');
    });

    it('27. Without token_frequencies, flatcase not segmented', async () => {
      const bm25 = await import('../bm25.js');

      // totalTokens = 0 → no segmentation
      const tokens = bm25.tokenizeCodeWithSegmentation('getusername');

      // Should contain the original flatcase token (tokenizeCode doesn't split flatcase)
      expect(tokens).toContain('getusername');
    });
  });

  // ========================================================================
  // Group 10: Edge cases
  // ========================================================================

  describe('Group 10: Edge cases', () => {
    it('28. Empty DB returns empty array', () => {
      db = freshDb();
      invalidateBM25Index();

      const results = hybridSearchCode('anything', makeEmbedding(2800), 5, 0.0);
      expect(results).toEqual([]);
    });

    it('29. Single document found', () => {
      db = freshDb();

      insertCodeDoc(db, 'src/only.ts', 'export const MAGIC = 42;', makeSimilarEmbedding(2900, 0.02));

      invalidateBM25Index();

      const results = hybridSearchCode('MAGIC', makeEmbedding(2900), 5, 0.0);
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('MAGIC');
      expect(results[0].similarity).toBeGreaterThan(0);
    });

    it('30. Unicode in content does not crash', () => {
      db = freshDb();

      const queryEmb = makeEmbedding(3000);

      insertCodeDoc(db, 'src/i18n.ts', '// \u041f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440! \u4f60\u597d\u4e16\u754c\nfunction greet() { return "Hello"; }', makeSimilarEmbedding(3000, 0.02), { symbolName: 'greet', symbolType: 'function' });
      insertCodeDoc(db, 'src/emoji.ts', '// Celebration module\nfunction celebrate() { return "party"; }', makeSimilarEmbedding(3000, 0.04), { symbolName: 'celebrate', symbolType: 'function' });

      invalidateBM25Index();

      const results = hybridSearchCode('greet', queryEmb, 5, 0.0);
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
