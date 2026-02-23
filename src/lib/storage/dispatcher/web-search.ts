import { StorageDispatcherBase } from './base.js';
import type {
  WebSearchHistoryInput,
  WebSearchHistoryRecord,
  WebSearchHistoryFilter,
  WebSearchHistorySummary,
} from '../types.js';

export class WebSearchDispatcherMixin extends StorageDispatcherBase {
  async recordWebSearch(record: WebSearchHistoryInput): Promise<number> {
    this._sessionCounters.webSearchQueries++;
    this._sessionCounters.webSearchCostUsd += record.estimated_cost_usd;
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.recordWebSearch(record);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.recordWebSearch(record);
  }

  async getWebSearchHistory(filter: WebSearchHistoryFilter): Promise<WebSearchHistoryRecord[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getWebSearchHistory(filter);
    const sqlite = await this.getSqliteFns();
    return sqlite.getWebSearchHistory(filter);
  }

  async getWebSearchSummary(): Promise<WebSearchHistorySummary> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getWebSearchSummary();
    const sqlite = await this.getSqliteFns();
    return sqlite.getWebSearchSummary();
  }

  async getTodayWebSearchSpend(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getTodayWebSearchSpend();
    const sqlite = await this.getSqliteFns();
    return sqlite.getTodayWebSearchSpend();
  }

  async clearWebSearchHistory(): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.clearWebSearchHistory();
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.clearWebSearchHistory();
  }

  // ===========================================================================
  // Retention Operations
  // ===========================================================================
}
