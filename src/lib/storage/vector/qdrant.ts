/**
 * Qdrant vector store implementation.
 *
 * Qdrant is used as a high-performance vector search backend,
 * complementing SQLite or PostgreSQL for metadata storage.
 *
 * Collections:
 * - {prefix}documents - Document embeddings
 * - {prefix}memories - Memory embeddings
 * - {prefix}global_memories - Global memory embeddings
 */

import type { VectorStore } from './interface.js';
import type { VectorSearchResult, VectorItem, StorageConfig } from '../types.js';

// Lazy-load qdrant client
let QdrantClient: any = null;

async function loadQdrant(): Promise<any> {
  if (QdrantClient) return QdrantClient;
  try {
    const module = await import('@qdrant/js-client-rest');
    QdrantClient = module.QdrantClient;
    return QdrantClient;
  } catch {
    throw new Error(
      'Qdrant support requires the "@qdrant/js-client-rest" package. ' +
      'Install it with: npm install @qdrant/js-client-rest'
    );
  }
}

export interface QdrantConfig {
  url?: string;
  apiKey?: string;
  collectionPrefix?: string;
  /** HNSW ef parameter for search (higher = more accurate but slower). Default: 128 */
  searchEf?: number;
  /** Enable scalar quantization for faster search. Default: true */
  useQuantization?: boolean;
}

export class QdrantVectorStore implements VectorStore {
  private client: any = null;
  private config: QdrantConfig;
  private dimensions: number = 384;
  private prefix: string;
  private searchEf: number;
  private useQuantization: boolean;
  private initialized: { documents: boolean; memories: boolean; globalMemories: boolean } = {
    documents: false,
    memories: false,
    globalMemories: false,
  };

  constructor(config: QdrantConfig) {
    this.config = config;
    this.prefix = config.collectionPrefix ?? 'succ_';
    this.searchEf = config.searchEf ?? 128;
    this.useQuantization = config.useQuantization ?? true;
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;

    const ClientClass = await loadQdrant();
    this.client = new ClientClass({
      url: this.config.url ?? 'http://localhost:6333',
      apiKey: this.config.apiKey,
    });

    return this.client;
  }

  private collectionName(type: 'documents' | 'memories' | 'global_memories'): string {
    return `${this.prefix}${type}`;
  }

  async init(dimensions: number): Promise<void> {
    this.dimensions = dimensions;
    const client = await this.getClient();

    // Create collections if they don't exist
    await this.ensureCollection('documents');
    await this.ensureCollection('memories');
    await this.ensureCollection('global_memories');
  }

  private async ensureCollection(type: 'documents' | 'memories' | 'global_memories'): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName(type);

    try {
      await client.getCollection(name);
      this.initialized[type === 'global_memories' ? 'globalMemories' : type] = true;
    } catch (e: any) {
      // Collection doesn't exist, create it
      if (e.status === 404 || e.message?.includes('Not found')) {
        const collectionConfig: any = {
          vectors: {
            size: this.dimensions,
            distance: 'Cosine',
          },
          // Optimized HNSW parameters for 384-dim vectors
          hnsw_config: {
            m: 16,              // Default is 16, good balance
            ef_construct: 100, // Higher = better quality index
          },
        };

        // Enable scalar quantization for faster search (reduces memory ~4x)
        if (this.useQuantization) {
          collectionConfig.quantization_config = {
            scalar: {
              type: 'int8',
              always_ram: true, // Keep quantized vectors in RAM for speed
            },
          };
        }

        await client.createCollection(name, collectionConfig);
        this.initialized[type === 'global_memories' ? 'globalMemories' : type] = true;
      } else {
        throw e;
      }
    }
  }

  async close(): Promise<void> {
    // Qdrant client doesn't need explicit closing
    this.client = null;
    this.initialized = { documents: false, memories: false, globalMemories: false };
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  // ============================================================================
  // Document Vectors
  // ============================================================================

  async upsertDocumentVector(id: number, embedding: number[]): Promise<void> {
    const client = await this.getClient();
    await client.upsert(this.collectionName('documents'), {
      points: [{
        id,
        vector: embedding,
        payload: { type: 'document' },
      }],
    });
  }

  async upsertDocumentVectorsBatch(items: VectorItem[]): Promise<void> {
    if (items.length === 0) return;

    const client = await this.getClient();

    // Qdrant recommends batches of ~100 points
    const batchSize = 100;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await client.upsert(this.collectionName('documents'), {
        points: batch.map(item => ({
          id: item.id,
          vector: item.embedding,
          payload: { type: 'document' },
        })),
      });
    }
  }

  async deleteDocumentVector(id: number): Promise<void> {
    const client = await this.getClient();
    await client.delete(this.collectionName('documents'), {
      points: [id],
    });
  }

  async deleteDocumentVectorsByIds(docIds: number[]): Promise<void> {
    if (docIds.length === 0) return;

    const client = await this.getClient();
    await client.delete(this.collectionName('documents'), {
      points: docIds,
    });
  }

  async searchDocuments(query: number[], limit: number, threshold: number): Promise<VectorSearchResult[]> {
    const client = await this.getClient();

    const results = await client.search(this.collectionName('documents'), {
      vector: query,
      limit,
      score_threshold: threshold,
      params: {
        hnsw_ef: this.searchEf,  // Search-time accuracy parameter
        exact: false,            // Use HNSW index, not brute force
      },
    });

    return results.map((r: any) => ({
      id: typeof r.id === 'number' ? r.id : parseInt(r.id),
      similarity: r.score,
    }));
  }

  // ============================================================================
  // Memory Vectors
  // ============================================================================

  async upsertMemoryVector(id: number, embedding: number[]): Promise<void> {
    const client = await this.getClient();
    await client.upsert(this.collectionName('memories'), {
      points: [{
        id,
        vector: embedding,
        payload: { type: 'memory' },
      }],
    });
  }

  async deleteMemoryVector(id: number): Promise<void> {
    const client = await this.getClient();
    await client.delete(this.collectionName('memories'), {
      points: [id],
    });
  }

  async searchMemories(query: number[], limit: number, threshold: number): Promise<VectorSearchResult[]> {
    const client = await this.getClient();

    const results = await client.search(this.collectionName('memories'), {
      vector: query,
      limit,
      score_threshold: threshold,
      params: {
        hnsw_ef: this.searchEf,
        exact: false,
      },
    });

    return results.map((r: any) => ({
      id: typeof r.id === 'number' ? r.id : parseInt(r.id),
      similarity: r.score,
    }));
  }

  // ============================================================================
  // Global Memory Vectors
  // ============================================================================

  async upsertGlobalMemoryVector(id: number, embedding: number[]): Promise<void> {
    const client = await this.getClient();
    await client.upsert(this.collectionName('global_memories'), {
      points: [{
        id,
        vector: embedding,
        payload: { type: 'global_memory' },
      }],
    });
  }

  async deleteGlobalMemoryVector(id: number): Promise<void> {
    const client = await this.getClient();
    await client.delete(this.collectionName('global_memories'), {
      points: [id],
    });
  }

  async searchGlobalMemories(query: number[], limit: number, threshold: number): Promise<VectorSearchResult[]> {
    const client = await this.getClient();

    const results = await client.search(this.collectionName('global_memories'), {
      vector: query,
      limit,
      score_threshold: threshold,
      params: {
        hnsw_ef: this.searchEf,
        exact: false,
      },
    });

    return results.map((r: any) => ({
      id: typeof r.id === 'number' ? r.id : parseInt(r.id),
      similarity: r.score,
    }));
  }

  // ============================================================================
  // Maintenance
  // ============================================================================

  async rebuildDocumentVectors(items: VectorItem[]): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName('documents');

    // Delete all points and re-insert
    try {
      await client.delete(name, {
        filter: {
          must: [{ key: 'type', match: { value: 'document' } }],
        },
      });
    } catch {
      // Collection might be empty
    }

    await this.upsertDocumentVectorsBatch(items);
  }

  async rebuildMemoryVectors(items: VectorItem[]): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName('memories');

    try {
      await client.delete(name, {
        filter: {
          must: [{ key: 'type', match: { value: 'memory' } }],
        },
      });
    } catch {
      // Collection might be empty
    }

    // Insert in batches
    const batchSize = 100;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await client.upsert(name, {
        points: batch.map(item => ({
          id: item.id,
          vector: item.embedding,
          payload: { type: 'memory' },
        })),
      });
    }
  }

  async rebuildGlobalMemoryVectors(items: VectorItem[]): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName('global_memories');

    try {
      await client.delete(name, {
        filter: {
          must: [{ key: 'type', match: { value: 'global_memory' } }],
        },
      });
    } catch {
      // Collection might be empty
    }

    const batchSize = 100;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await client.upsert(name, {
        points: batch.map(item => ({
          id: item.id,
          vector: item.embedding,
          payload: { type: 'global_memory' },
        })),
      });
    }
  }
}

/**
 * Create Qdrant vector store from storage config.
 */
export function createQdrantVectorStore(config: StorageConfig): QdrantVectorStore {
  const qdrantConfig = config.qdrant ?? {};
  return new QdrantVectorStore({
    url: qdrantConfig.url,
    apiKey: qdrantConfig.api_key,
    collectionPrefix: qdrantConfig.collection_prefix,
  });
}
