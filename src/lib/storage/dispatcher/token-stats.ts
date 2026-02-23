import { StorageDispatcherBase } from './base.js';
import type { TokenStatsByEvent, TokenStatsSummary } from '../types.js';

export class TokenStatsDispatcherMixin extends StorageDispatcherBase {
  async updateTokenFrequencies(tokens: string[]): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.updateTokenFrequencies(tokens);
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.updateTokenFrequencies(tokens);
  }

  async getTokenFrequency(token: string): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getTokenFrequency(token);
    const sqlite = await this.getSqliteFns();
    return sqlite.getTokenFrequency(token);
  }

  async getTokenFrequencies(tokens: string[]): Promise<Map<string, number>> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getTokenFrequencies(tokens);
    const sqlite = await this.getSqliteFns();
    return sqlite.getTokenFrequencies(tokens);
  }

  async getTotalTokenCount(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getTotalTokenCount();
    const sqlite = await this.getSqliteFns();
    return sqlite.getTotalTokenCount();
  }

  async getTopTokens(limit?: number): Promise<Array<{ token: string; frequency: number }>> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getTopTokens(limit);
    const sqlite = await this.getSqliteFns();
    return sqlite.getTopTokens(limit);
  }

  async clearTokenFrequencies(): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.clearTokenFrequencies();
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.clearTokenFrequencies();
  }

  async getTokenFrequencyStats(): Promise<{
    unique_tokens: number;
    total_occurrences: number;
    avg_frequency: number;
  }> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getTokenFrequencyStats();
    const sqlite = await this.getSqliteFns();
    return sqlite.getTokenFrequencyStats();
  }

  // ===========================================================================
  // Token Stats
  // ===========================================================================

  async recordTokenStat(record: any): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.recordTokenStat(record);
    const sqlite = await this.getSqliteFns();
    return sqlite.recordTokenStat(record);
  }

  async getTokenStatsSummary(): Promise<TokenStatsSummary> {
    if (this.backend === 'postgresql' && this.postgres) {
      const summary = await this.postgres.getTokenStatsSummary();
      const savingsPercent =
        summary.total_full_source_tokens > 0
          ? (summary.total_savings_tokens / summary.total_full_source_tokens) * 100
          : 0;
      return {
        total_calls: summary.total_queries,
        total_returned_tokens: summary.total_returned_tokens,
        total_full_source_tokens: summary.total_full_source_tokens,
        total_savings_tokens: summary.total_savings_tokens,
        total_estimated_cost: summary.total_estimated_cost,
        savings_percent: savingsPercent,
        by_event_type: [],
      };
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.getTokenStatsSummary();
  }

  async getTokenStatsAggregated(): Promise<TokenStatsByEvent[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getTokenStatsAggregated();
    const sqlite = await this.getSqliteFns();
    return sqlite.getTokenStatsAggregated();
  }

  async clearTokenStats(): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.clearTokenStats();
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.clearTokenStats();
  }

  // ===========================================================================
  // Web Search History
  // ===========================================================================
}
