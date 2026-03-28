import { StorageDispatcherBase } from './base.js';
import type { DocumentUpsertMeta } from '../vector/qdrant.js';
import type { DocumentBatch, DocumentBatchWithHash, RecentDocumentRecord } from '../types.js';

export class DocumentsDispatcherMixin extends StorageDispatcherBase {
  async upsertDocument(
    filePath: string,
    chunkIndex: number,
    content: string,
    startLine: number,
    endLine: number,
    embedding: number[],
    symbolName?: string,
    symbolType?: string,
    signature?: string
  ): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const id = await this.postgres.upsertDocument(
        filePath,
        chunkIndex,
        content,
        startLine,
        endLine,
        embedding,
        symbolName,
        symbolType,
        signature
      );
      if (this.hasQdrant()) {
        try {
          await this.qdrant!.upsertDocumentWithPayload(id, embedding, {
            filePath,
            content,
            startLine,
            endLine,
            projectId: this.qdrant!.getProjectId() ?? '',
            symbolName,
            symbolType,
            signature,
          });
        } catch (error) {
          this._warnQdrantFailure(`Failed to sync document vector ${id}`, error);
        }
      }
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.upsertDocument(
      filePath,
      chunkIndex,
      content,
      startLine,
      endLine,
      embedding,
      symbolName,
      symbolType,
      signature
    );
  }

  async upsertDocumentsBatch(documents: DocumentBatch[]): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const ids = await this.postgres.upsertDocumentsBatch(documents);
      if (this.hasQdrant() && ids.length > 0) {
        try {
          const items = documents.map((doc, idx) => ({
            id: ids[idx],
            embedding: doc.embedding,
            meta: {
              filePath: doc.filePath,
              content: doc.content,
              startLine: doc.startLine,
              endLine: doc.endLine,
              projectId: this.qdrant!.getProjectId() ?? '',
              symbolName: doc.symbolName,
              symbolType: doc.symbolType,
              signature: doc.signature,
            } as DocumentUpsertMeta,
          }));
          await this.qdrant!.upsertDocumentsBatchWithPayload(items);
        } catch (error) {
          this._warnQdrantFailure(`Failed to sync ${ids.length} document vectors`, error);
        }
      }
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.upsertDocumentsBatch(documents);
  }

  async upsertDocumentsBatchWithHashes(documents: DocumentBatchWithHash[]): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const ids = await this.postgres.upsertDocumentsBatchWithHashes(documents);
      if (this.hasQdrant() && ids.length > 0) {
        try {
          const items = documents.map((doc, idx) => ({
            id: ids[idx],
            embedding: doc.embedding,
            meta: {
              filePath: doc.filePath,
              content: doc.content,
              startLine: doc.startLine,
              endLine: doc.endLine,
              projectId: this.qdrant!.getProjectId() ?? '',
              symbolName: doc.symbolName,
              symbolType: doc.symbolType,
              signature: doc.signature,
            } as DocumentUpsertMeta,
          }));
          await this.qdrant!.upsertDocumentsBatchWithPayload(items);
        } catch (error) {
          this._warnQdrantFailure(`Failed to sync ${ids.length} document vectors`, error);
        }
      }
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.upsertDocumentsBatchWithHashes(documents);
  }

  async deleteDocumentsByPath(filePath: string): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const deletedIds = await this.postgres.deleteDocumentsByPath(filePath);
      if (this.vectorBackend === 'qdrant' && this.qdrant && deletedIds.length > 0) {
        try {
          await this.qdrant.deleteDocumentVectorsByIds(deletedIds);
        } catch (error) {
          this._warnQdrantFailure('Failed to delete document vectors', error);
        }
      }
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.deleteDocumentsByPath(filePath);
  }

  async searchDocuments(
    queryEmbedding: number[],
    limit: number = 5,
    threshold: number = 0.5
  ): Promise<
    Array<{
      file_path: string;
      content: string;
      start_line: number;
      end_line: number;
      similarity: number;
    }>
  > {
    if (this.hasQdrant()) {
      try {
        // Access Qdrant private methods via property access for backward compatibility
        const qdrantAny = this.qdrant as unknown as {
          getClient(): Promise<any>;
          collectionName(type: string): string;
        };
        const client = await qdrantAny.getClient();
        const name = qdrantAny.collectionName('documents');
        const qResults = await client.query(name, {
          query: queryEmbedding,
          using: 'dense',
          limit,
          score_threshold: threshold,
          params: { hnsw_ef: 128, exact: false },
          with_payload: true,
        });
        const points = qResults.points ?? qResults;
        if (points.length > 0 && points[0].payload?.content) {
          return points.map((p: any) => ({
            file_path: p.payload?.file_path ?? '',
            content: p.payload?.content ?? '',
            start_line: p.payload?.start_line ?? 0,
            end_line: p.payload?.end_line ?? 0,
            similarity: p.score,
          }));
        }
        if (this.backend === 'postgresql' && this.postgres) {
          const results = await this.qdrant!.searchDocuments(queryEmbedding, limit * 3, threshold);
          if (results.length > 0) {
            const pgRows = await this.postgres.getDocumentsByIds(results.map((r) => r.id));
            const scoreMap = new Map(results.map((r) => [r.id, r.similarity]));
            return pgRows
              .map((row) => ({
                file_path: row.file_path,
                content: row.content,
                start_line: row.start_line,
                end_line: row.end_line,
                similarity: scoreMap.get(row.id) ?? 0,
              }))
              .sort((a, b) => b.similarity - a.similarity)
              .slice(0, limit);
          }
        }
      } catch (error) {
        this._warnQdrantFailure('searchDocuments failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.searchDocuments(queryEmbedding, limit, threshold);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.searchDocuments(queryEmbedding, limit, threshold);
  }

  async getRecentDocuments(limit: number = 10): Promise<RecentDocumentRecord[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getRecentDocuments(limit);
    const sqlite = await this.getSqliteFns();
    return sqlite.getRecentDocuments(limit);
  }

  async getStats(): Promise<{
    total_documents: number;
    total_files: number;
    last_indexed: string | null;
  }> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getDocumentStats();
    const sqlite = await this.getSqliteFns();
    return sqlite.getStats();
  }

  async clearDocuments(): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.clearDocuments();
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.clearDocuments();
  }

  async clearCodeDocuments(): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.clearCodeDocuments();
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.clearCodeDocuments();
  }

  async getStoredEmbeddingDimension(): Promise<number | null> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getStoredEmbeddingDimension();
    const sqlite = await this.getSqliteFns();
    return sqlite.getStoredEmbeddingDimension();
  }

  // ===========================================================================
  // Memory Operations
  // ===========================================================================
}
