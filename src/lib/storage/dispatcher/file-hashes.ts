import { StorageDispatcherBase } from './base.js';

export class FileHashesDispatcherMixin extends StorageDispatcherBase {
  async getFileHash(filePath: string): Promise<string | null> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getFileHash(filePath);
    const sqlite = await this.getSqliteFns();
    return sqlite.getFileHash(filePath);
  }

  async setFileHash(filePath: string, hash: string): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.setFileHash(filePath, hash);
    const sqlite = await this.getSqliteFns();
    return sqlite.setFileHash(filePath, hash);
  }

  async deleteFileHash(filePath: string): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.deleteFileHash(filePath);
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.deleteFileHash(filePath);
  }

  async getAllFileHashes(): Promise<Map<string, string>> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getAllFileHashes();
    const sqlite = await this.getSqliteFns();
    return sqlite.getAllFileHashes();
  }

  async getAllFileHashesWithTimestamps(): Promise<
    Array<{ file_path: string; content_hash: string; indexed_at: string }>
  > {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getAllFileHashesWithTimestamps();
    const sqlite = await this.getSqliteFns();
    return sqlite.getAllFileHashesWithTimestamps();
  }

  // ===========================================================================
  // Token Frequency Operations
  // ===========================================================================
}
