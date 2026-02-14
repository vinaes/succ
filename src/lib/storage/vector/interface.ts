/**
 * VectorStore interface for abstracting vector search backends.
 *
 * Implementations:
 * - sqlite-vec (builtin for SQLite)
 * - pgvector (builtin for PostgreSQL)
 * - Qdrant (optional external service)
 */

import type { VectorSearchResult, VectorItem } from '../types.js';

export interface VectorStore {
  /**
   * Initialize the vector store with the given embedding dimensions.
   * Creates collections/tables as needed.
   */
  init(dimensions: number): Promise<void>;

  /**
   * Close connections and clean up resources.
   */
  close(): Promise<void>;

  /**
   * Check if the vector store is available and working.
   */
  isAvailable(): boolean;

  // ============================================================================
  // Document Vectors
  // ============================================================================

  /**
   * Insert or update a document vector.
   */
  upsertDocumentVector(id: number, embedding: number[]): Promise<void>;

  /**
   * Batch insert/update document vectors.
   */
  upsertDocumentVectorsBatch(items: VectorItem[]): Promise<void>;

  /**
   * Delete a document vector by ID.
   */
  deleteDocumentVector(id: number): Promise<void>;

  /**
   * Delete all document vectors for a given file path.
   * @param docIds - Array of document IDs to delete
   */
  deleteDocumentVectorsByIds(docIds: number[]): Promise<void>;

  /**
   * Search for similar documents.
   * @param query - Query embedding vector
   * @param limit - Max results to return
   * @param threshold - Minimum similarity threshold (0-1)
   * @returns Array of {id, similarity} sorted by similarity desc
   */
  searchDocuments(query: number[], limit: number, threshold: number): Promise<VectorSearchResult[]>;

  // ============================================================================
  // Memory Vectors (Local)
  // ============================================================================

  /**
   * Insert or update a memory vector.
   */
  upsertMemoryVector(id: number, embedding: number[]): Promise<void>;

  /**
   * Delete a memory vector by ID.
   */
  deleteMemoryVector(id: number): Promise<void>;

  /**
   * Search for similar memories.
   */
  searchMemories(query: number[], limit: number, threshold: number): Promise<VectorSearchResult[]>;

  // ============================================================================
  // Global Memory Vectors
  // ============================================================================

  /**
   * Insert or update a global memory vector.
   */
  upsertGlobalMemoryVector(id: number, embedding: number[]): Promise<void>;

  /**
   * Delete a global memory vector by ID.
   */
  deleteGlobalMemoryVector(id: number): Promise<void>;

  /**
   * Search for similar global memories.
   */
  searchGlobalMemories(
    query: number[],
    limit: number,
    threshold: number
  ): Promise<VectorSearchResult[]>;

  // ============================================================================
  // Maintenance
  // ============================================================================

  /**
   * Rebuild vector index for documents from raw embeddings.
   * @param items - Array of {id, embedding} pairs
   */
  rebuildDocumentVectors(items: VectorItem[]): Promise<void>;

  /**
   * Rebuild vector index for memories from raw embeddings.
   * @param items - Array of {id, embedding} pairs
   */
  rebuildMemoryVectors(items: VectorItem[]): Promise<void>;

  /**
   * Rebuild vector index for global memories from raw embeddings.
   * @param items - Array of {id, embedding} pairs
   */
  rebuildGlobalMemoryVectors(items: VectorItem[]): Promise<void>;
}
