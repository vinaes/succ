import { getConfig, getProjectRoot } from '../../config.js';
import { logError } from '../../fault-logger.js';
import type { PostgresBackend } from '../backends/postgresql.js';
import type { QdrantVectorStore } from '../vector/qdrant.js';
import type { StorageConfig } from '../types.js';
import { StorageDispatcherBase } from './base.js';
import { applyMixins } from './mixin-helper.js';
import { DocumentsDispatcherMixin } from './documents.js';
import { MemoriesDispatcherMixin } from './memories.js';
import { GraphDispatcherMixin } from './graph.js';
import { EmbeddingsDispatcherMixin } from './embeddings.js';
import { RetentionDispatcherMixin } from './retention.js';
import { SearchDispatcherMixin } from './search.js';
import { GlobalMemoriesDispatcherMixin } from './global-memories.js';
import { SkillsDispatcherMixin } from './skills.js';
import { FileHashesDispatcherMixin } from './file-hashes.js';
import { TokenStatsDispatcherMixin } from './token-stats.js';
import { WebSearchDispatcherMixin } from './web-search.js';
import { ExportImportDispatcherMixin } from './export-import.js';

// Dispatcher state
let _backend: 'sqlite' | 'postgresql' = 'sqlite';
let _vectorBackend: 'builtin' | 'qdrant' = 'builtin';
let _postgresBackend: PostgresBackend | null = null;
let _qdrantStore: QdrantVectorStore | null = null;
let _initialized = false;

function getDispatcherStorageConfig(): StorageConfig {
  const config = getConfig();
  // Normalize 'postgres' → 'postgresql' (matches storage/index.ts getStorageConfig)
  const rawBackend: string = config.storage?.backend ?? 'sqlite';
  return {
    backend: (rawBackend === 'postgres' ? 'postgresql' : rawBackend) as 'sqlite' | 'postgresql',
    vector: config.storage?.vector ?? 'builtin',
    sqlite: config.storage?.sqlite,
    postgresql: config.storage?.postgresql,
    qdrant: config.storage?.qdrant,
  };
}

export async function initStorageDispatcher(): Promise<void> {
  if (_initialized) return;

  const config = getDispatcherStorageConfig();
  _backend = config.backend ?? 'sqlite';
  _vectorBackend = config.vector ?? 'builtin';

  const projectId = getProjectRoot().replace(/\\/g, '/').toLowerCase();

  if (_backend === 'postgresql') {
    const { createPostgresBackend } = await import('../backends/postgresql.js');
    _postgresBackend = createPostgresBackend(config);
    _postgresBackend.setProjectId(projectId);
    await _postgresBackend.getDocumentStats();
  }

  if (_vectorBackend === 'qdrant') {
    try {
      const { createQdrantVectorStore } = await import('../vector/qdrant.js');
      _qdrantStore = createQdrantVectorStore(config);
      _qdrantStore.setProjectId(projectId);
      const { getEmbeddingInfo } = await import('../../embeddings.js');
      const embDims = getEmbeddingInfo().dimensions ?? 384;
      await _qdrantStore.init(embDims);
    } catch (error) {
      logError(
        'storage',
        `Qdrant init failed, falling back to builtin: ${(error as Error).message}`,
        error as Error
      );
      _qdrantStore = null;
    }
  }

  _initialized = true;
  _dispatcher = null;
}

export function getBackendType(): 'sqlite' | 'postgresql' {
  return _backend;
}

export function getVectorBackendType(): 'builtin' | 'qdrant' {
  return _vectorBackend;
}

export function isPostgresBackend(): boolean {
  return _backend === 'postgresql';
}

export function isQdrantVectors(): boolean {
  return _vectorBackend === 'qdrant';
}

export function getPostgresBackend(): PostgresBackend | null {
  return _postgresBackend;
}

export function getQdrantStore(): QdrantVectorStore | null {
  return _qdrantStore;
}

export async function closeStorageDispatcher(): Promise<void> {
  if (_postgresBackend) {
    await _postgresBackend.close();
    _postgresBackend = null;
  }
  if (_qdrantStore) {
    await _qdrantStore.close();
    _qdrantStore = null;
  }
  _initialized = false;
  _dispatcher = null;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class StorageDispatcherImpl extends StorageDispatcherBase {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
interface StorageDispatcherImpl
  extends
    DocumentsDispatcherMixin,
    MemoriesDispatcherMixin,
    GraphDispatcherMixin,
    EmbeddingsDispatcherMixin,
    RetentionDispatcherMixin,
    SearchDispatcherMixin,
    GlobalMemoriesDispatcherMixin,
    SkillsDispatcherMixin,
    FileHashesDispatcherMixin,
    TokenStatsDispatcherMixin,
    WebSearchDispatcherMixin,
    ExportImportDispatcherMixin {}

applyMixins(StorageDispatcherImpl, [
  DocumentsDispatcherMixin,
  MemoriesDispatcherMixin,
  GraphDispatcherMixin,
  EmbeddingsDispatcherMixin,
  RetentionDispatcherMixin,
  SearchDispatcherMixin,
  GlobalMemoriesDispatcherMixin,
  SkillsDispatcherMixin,
  FileHashesDispatcherMixin,
  TokenStatsDispatcherMixin,
  WebSearchDispatcherMixin,
  ExportImportDispatcherMixin,
]);

export class StorageDispatcher extends StorageDispatcherImpl {
  constructor() {
    super({
      backend: _backend,
      vectorBackend: _vectorBackend,
      postgres: _postgresBackend,
      qdrant: _qdrantStore,
    });
  }
}

// Singleton
let _dispatcher: StorageDispatcher | null = null;

export async function getStorageDispatcher(): Promise<StorageDispatcher> {
  if (!_initialized) await initStorageDispatcher();
  if (!_dispatcher) _dispatcher = new StorageDispatcher();
  return _dispatcher;
}

export function resetStorageDispatcher(): void {
  _dispatcher = null;
  _initialized = false;
  _postgresBackend = null;
  _qdrantStore = null;
  _backend = 'sqlite';
  _vectorBackend = 'builtin';
}
