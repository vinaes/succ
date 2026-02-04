/**
 * Tests for storage abstraction layer.
 *
 * These tests verify:
 * 1. Storage config validation
 * 2. Backend detection and info
 * 3. PostgreSQL backend (if pg is available)
 * 4. Qdrant vector store (if qdrant is available)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getStorageConfig,
  validateStorageConfig,
  getStorageInfo,
} from './index.js';

describe('Storage Abstraction', () => {
  describe('getStorageConfig', () => {
    it('should return default config when no storage config set', () => {
      const config = getStorageConfig();
      expect(config.backend).toBe('sqlite');
      expect(config.vector).toBe('builtin');
    });
  });

  describe('validateStorageConfig', () => {
    it('should not throw for default config', () => {
      expect(() => validateStorageConfig()).not.toThrow();
    });

    it('should not throw for valid sqlite config', () => {
      // Default is sqlite, should be valid
      expect(() => validateStorageConfig()).not.toThrow();
    });
  });

  describe('getStorageInfo', () => {
    it('should return sqlite info by default', () => {
      const info = getStorageInfo();
      expect(info.backend).toBe('sqlite');
      expect(info.vector).toBe('sqlite-vec');
      expect(info.path).toBeDefined();
      expect(info.globalPath).toBeDefined();
    });
  });
});

describe('PostgreSQL Backend', () => {
  it('should export PostgresBackend class', async () => {
    const { PostgresBackend } = await import('./backends/postgresql.js');
    expect(PostgresBackend).toBeDefined();
  });

  it('should export createPostgresBackend factory', async () => {
    const { createPostgresBackend } = await import('./backends/postgresql.js');
    expect(createPostgresBackend).toBeDefined();
    expect(typeof createPostgresBackend).toBe('function');
  });

  it('should create backend with config', async () => {
    const { createPostgresBackend } = await import('./backends/postgresql.js');
    const backend = createPostgresBackend({
      backend: 'postgresql',
      postgresql: {
        host: 'localhost',
        port: 5432,
        database: 'test',
      },
    });
    expect(backend).toBeDefined();
  });
});

describe('Qdrant Vector Store', () => {
  it('should export QdrantVectorStore class', async () => {
    const { QdrantVectorStore } = await import('./vector/qdrant.js');
    expect(QdrantVectorStore).toBeDefined();
  });

  it('should export createQdrantVectorStore factory', async () => {
    const { createQdrantVectorStore } = await import('./vector/qdrant.js');
    expect(createQdrantVectorStore).toBeDefined();
    expect(typeof createQdrantVectorStore).toBe('function');
  });

  it('should create vector store with config', async () => {
    const { createQdrantVectorStore } = await import('./vector/qdrant.js');
    const store = createQdrantVectorStore({
      backend: 'sqlite',
      vector: 'qdrant',
      qdrant: {
        url: 'http://localhost:6333',
      },
    });
    expect(store).toBeDefined();
  });
});

describe('Storage Types', () => {
  it('should export all entity types', async () => {
    const types = await import('./types.js');

    // Config types
    expect(types.MEMORY_TYPES).toBeDefined();
    expect(types.LINK_RELATIONS).toBeDefined();

    // Memory types should include expected values
    expect(types.MEMORY_TYPES).toContain('observation');
    expect(types.MEMORY_TYPES).toContain('decision');
    expect(types.MEMORY_TYPES).toContain('learning');
    expect(types.MEMORY_TYPES).toContain('error');
    expect(types.MEMORY_TYPES).toContain('pattern');

    // Link relations should include expected values
    expect(types.LINK_RELATIONS).toContain('related');
    expect(types.LINK_RELATIONS).toContain('similar_to');
    expect(types.LINK_RELATIONS).toContain('leads_to');
  });
});

describe('VectorStore Interface', () => {
  it('should export VectorStore interface', async () => {
    // This is a type-only export, so we just verify the module loads
    const module = await import('./vector/interface.js');
    expect(module).toBeDefined();
  });
});

describe('StorageBackend Interface', () => {
  it('should export StorageBackend interface', async () => {
    // This is a type-only export, so we just verify the module loads
    const module = await import('./backends/interface.js');
    expect(module).toBeDefined();
  });
});
