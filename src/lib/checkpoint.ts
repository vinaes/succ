/**
 * Checkpoint Library
 *
 * Full backup/restore of succ state including:
 * - memories (with embeddings, quality scores, access tracking)
 * - documents (indexed chunks with embeddings)
 * - memory_links (knowledge graph)
 * - config
 * - brain_vault (markdown files)
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { getDb } from './db/index.js';
import { getSuccDir } from './config.js';

// Checkpoint format version
const CHECKPOINT_VERSION = '1.0';

export interface CheckpointMemory {
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
}

export interface CheckpointDocument {
  id: number;
  file_path: string;
  chunk_index: number;
  content: string;
  start_line: number;
  end_line: number;
  embedding: number[] | null;
  created_at: string;
}

export interface CheckpointMemoryLink {
  id: number;
  source_id: number;
  target_id: number;
  relation: string;
  weight: number;
  created_at: string;
}

export interface CheckpointBrainFile {
  path: string;  // relative to .succ/brain/
  content: string;
}

export interface CheckpointData {
  version: string;
  created_at: string;
  project_name: string;
  succ_version: string;
  data: {
    memories: CheckpointMemory[];
    documents: CheckpointDocument[];
    memory_links: CheckpointMemoryLink[];
    config: Record<string, unknown>;
    brain_vault: CheckpointBrainFile[];
  };
  stats: {
    memories_count: number;
    documents_count: number;
    links_count: number;
    brain_files_count: number;
  };
}

export interface CreateCheckpointOptions {
  includeBrain?: boolean;      // Include brain vault markdown files (default: true)
  includeDocuments?: boolean;  // Include indexed documents (default: true)
  includeConfig?: boolean;     // Include config (default: true)
  compress?: boolean;          // Gzip compress output (default: false)
  outputPath?: string;         // Custom output path
}

export interface RestoreCheckpointOptions {
  overwrite?: boolean;         // Overwrite existing data (default: false)
  restoreBrain?: boolean;      // Restore brain vault files (default: true)
  restoreDocuments?: boolean;  // Restore documents (default: true)
  restoreConfig?: boolean;     // Restore config (default: false - safer)
}

/**
 * Get all memories for checkpoint export
 */
function getAllMemoriesForCheckpoint(): CheckpointMemory[] {
  const database = getDb();
  const rows = database.prepare(`
    SELECT id, content, tags, source, embedding, type,
           quality_score, quality_factors, access_count, last_accessed, created_at
    FROM memories
    ORDER BY id ASC
  `).all() as Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    embedding: Buffer | null;
    type: string | null;
    quality_score: number | null;
    quality_factors: string | null;
    access_count: number | null;
    last_accessed: string | null;
    created_at: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source: row.source,
    embedding: row.embedding ? Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)) : null,
    type: row.type,
    quality_score: row.quality_score,
    quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
    access_count: row.access_count ?? 0,
    last_accessed: row.last_accessed,
    created_at: row.created_at,
  }));
}

/**
 * Get all documents for checkpoint export
 */
function getAllDocumentsForCheckpoint(): CheckpointDocument[] {
  const database = getDb();
  const rows = database.prepare(`
    SELECT id, file_path, chunk_index, content, start_line, end_line, embedding, created_at
    FROM documents
    ORDER BY id ASC
  `).all() as Array<{
    id: number;
    file_path: string;
    chunk_index: number;
    content: string;
    start_line: number;
    end_line: number;
    embedding: Buffer | null;
    created_at: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    file_path: row.file_path,
    chunk_index: row.chunk_index,
    content: row.content,
    start_line: row.start_line,
    end_line: row.end_line,
    embedding: row.embedding ? Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)) : null,
    created_at: row.created_at,
  }));
}

/**
 * Get all memory links for checkpoint export
 */
function getAllMemoryLinksForCheckpoint(): CheckpointMemoryLink[] {
  const database = getDb();
  const rows = database.prepare(`
    SELECT id, source_id, target_id, relation, weight, created_at
    FROM memory_links
    ORDER BY id ASC
  `).all() as Array<{
    id: number;
    source_id: number;
    target_id: number;
    relation: string;
    weight: number;
    created_at: string;
  }>;

  return rows;
}

/**
 * Get all brain vault files
 */
function getBrainVaultFiles(): CheckpointBrainFile[] {
  const succDir = getSuccDir();
  const brainDir = path.join(succDir, 'brain');

  if (!fs.existsSync(brainDir)) {
    return [];
  }

  const files: CheckpointBrainFile[] = [];

  function walkDir(dir: string, basePath: string = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = basePath ? path.join(basePath, entry.name) : entry.name;

      if (entry.isDirectory()) {
        walkDir(fullPath, relativePath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          files.push({
            path: relativePath.replace(/\\/g, '/'),  // Normalize path separators
            content,
          });
        } catch {
          // Skip files we can't read
        }
      }
    }
  }

  walkDir(brainDir);
  return files;
}

/**
 * Get project name from current directory or config
 */
function getProjectName(): string {
  const cwd = process.cwd();
  return path.basename(cwd);
}

/**
 * Get succ version from package.json
 */
function getSuccVersion(): string {
  try {
    const packagePath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json');
    const normalizedPath = process.platform === 'win32' ? packagePath.replace(/^\/([A-Za-z]):/, '$1:') : packagePath;
    const pkg = JSON.parse(fs.readFileSync(normalizedPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Create a checkpoint of current succ state
 */
export function createCheckpoint(options: CreateCheckpointOptions = {}): {
  checkpoint: CheckpointData;
  outputPath: string;
} {
  const {
    includeBrain = true,
    includeDocuments = true,
    includeConfig = true,
    compress = false,
    outputPath,
  } = options;

  // Gather data
  const memories = getAllMemoriesForCheckpoint();
  const documents = includeDocuments ? getAllDocumentsForCheckpoint() : [];
  const memoryLinks = getAllMemoryLinksForCheckpoint();
  const brainFiles = includeBrain ? getBrainVaultFiles() : [];

  let config: Record<string, unknown> = {};
  if (includeConfig) {
    try {
      const succDir = getSuccDir();
      const configPath = path.join(succDir, 'config.json');
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
    } catch {
      // No config or can't read
    }
  }

  const checkpoint: CheckpointData = {
    version: CHECKPOINT_VERSION,
    created_at: new Date().toISOString(),
    project_name: getProjectName(),
    succ_version: getSuccVersion(),
    data: {
      memories,
      documents,
      memory_links: memoryLinks,
      config,
      brain_vault: brainFiles,
    },
    stats: {
      memories_count: memories.length,
      documents_count: documents.length,
      links_count: memoryLinks.length,
      brain_files_count: brainFiles.length,
    },
  };

  // Determine output path
  const succDir = getSuccDir();
  const checkpointsDir = path.join(succDir, 'checkpoints');
  if (!fs.existsSync(checkpointsDir)) {
    fs.mkdirSync(checkpointsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const defaultFileName = `checkpoint-${timestamp}${compress ? '.json.gz' : '.json'}`;
  const finalPath = outputPath || path.join(checkpointsDir, defaultFileName);

  // Write checkpoint
  const jsonContent = JSON.stringify(checkpoint, null, 2);

  if (compress) {
    const compressed = zlib.gzipSync(jsonContent);
    fs.writeFileSync(finalPath, compressed);
  } else {
    fs.writeFileSync(finalPath, jsonContent);
  }

  return { checkpoint, outputPath: finalPath };
}

/**
 * Read a checkpoint file
 */
export function readCheckpoint(filePath: string): CheckpointData {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Checkpoint file not found: ${filePath}`);
  }

  let content: string;

  if (filePath.endsWith('.gz')) {
    const compressed = fs.readFileSync(filePath);
    content = zlib.gunzipSync(compressed).toString('utf8');
  } else {
    content = fs.readFileSync(filePath, 'utf8');
  }

  const checkpoint = JSON.parse(content) as CheckpointData;

  // Validate checkpoint structure
  if (!checkpoint.version || !checkpoint.data) {
    throw new Error('Invalid checkpoint format');
  }

  return checkpoint;
}

/**
 * Restore a checkpoint
 */
export function restoreCheckpoint(
  checkpoint: CheckpointData,
  options: RestoreCheckpointOptions = {}
): {
  memoriesRestored: number;
  documentsRestored: number;
  linksRestored: number;
  brainFilesRestored: number;
} {
  const {
    overwrite = false,
    restoreBrain = true,
    restoreDocuments = true,
    restoreConfig = false,
  } = options;

  const database = getDb();
  let memoriesRestored = 0;
  let documentsRestored = 0;
  let linksRestored = 0;
  let brainFilesRestored = 0;

  // Clear existing data if overwrite
  if (overwrite) {
    database.exec('DELETE FROM memories');
    database.exec('DELETE FROM memory_links');
    if (restoreDocuments) {
      database.exec('DELETE FROM documents');
    }
  }

  // Restore memories
  const insertMemory = database.prepare(`
    INSERT INTO memories (content, tags, source, embedding, type, quality_score, quality_factors, access_count, last_accessed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const memoryIdMap = new Map<number, number>();  // old ID -> new ID

  const restoreMemoriesTx = database.transaction((memories: CheckpointMemory[]) => {
    for (const memory of memories) {
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
  });

  restoreMemoriesTx(checkpoint.data.memories);

  // Restore memory links (with remapped IDs)
  const insertLink = database.prepare(`
    INSERT INTO memory_links (source_id, target_id, relation, weight, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const restoreLinksTx = database.transaction((links: CheckpointMemoryLink[]) => {
    for (const link of links) {
      const newSourceId = memoryIdMap.get(link.source_id);
      const newTargetId = memoryIdMap.get(link.target_id);

      if (newSourceId && newTargetId) {
        insertLink.run(newSourceId, newTargetId, link.relation, link.weight, link.created_at);
        linksRestored++;
      }
    }
  });

  restoreLinksTx(checkpoint.data.memory_links);

  // Restore documents
  if (restoreDocuments && checkpoint.data.documents.length > 0) {
    const insertDocument = database.prepare(`
      INSERT INTO documents (file_path, chunk_index, content, start_line, end_line, embedding, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const restoreDocsTx = database.transaction((docs: CheckpointDocument[]) => {
      for (const doc of docs) {
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
    });

    restoreDocsTx(checkpoint.data.documents);
  }

  // Restore brain vault files
  if (restoreBrain && checkpoint.data.brain_vault.length > 0) {
    const succDir = getSuccDir();
    const brainDir = path.join(succDir, 'brain');

    for (const file of checkpoint.data.brain_vault) {
      const filePath = path.join(brainDir, file.path);
      const dirPath = path.dirname(filePath);

      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      // Don't overwrite existing files unless overwrite=true
      if (!fs.existsSync(filePath) || overwrite) {
        fs.writeFileSync(filePath, file.content);
        brainFilesRestored++;
      }
    }
  }

  // Restore config
  if (restoreConfig && Object.keys(checkpoint.data.config).length > 0) {
    const succDir = getSuccDir();
    const configPath = path.join(succDir, 'config.json');

    // Merge with existing config instead of overwriting
    let existingConfig: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try {
        existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch {
        // Ignore parse errors
      }
    }

    const mergedConfig = { ...existingConfig, ...checkpoint.data.config };
    fs.writeFileSync(configPath, JSON.stringify(mergedConfig, null, 2));
  }

  return {
    memoriesRestored,
    documentsRestored,
    linksRestored,
    brainFilesRestored,
  };
}

/**
 * List available checkpoints
 */
export function listCheckpoints(): Array<{
  name: string;
  path: string;
  size: number;
  compressed: boolean;
  created_at: string | null;
}> {
  const succDir = getSuccDir();
  const checkpointsDir = path.join(succDir, 'checkpoints');

  if (!fs.existsSync(checkpointsDir)) {
    return [];
  }

  const files = fs.readdirSync(checkpointsDir)
    .filter(f => f.endsWith('.json') || f.endsWith('.json.gz'))
    .map(name => {
      const filePath = path.join(checkpointsDir, name);
      const stats = fs.statSync(filePath);

      let created_at: string | null = null;
      try {
        const checkpoint = readCheckpoint(filePath);
        created_at = checkpoint.created_at;
      } catch {
        // Can't read checkpoint, use file mtime
        created_at = stats.mtime.toISOString();
      }

      return {
        name,
        path: filePath,
        size: stats.size,
        compressed: name.endsWith('.gz'),
        created_at,
      };
    })
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  return files;
}

/**
 * Format file size for display
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
