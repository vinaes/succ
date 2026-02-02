/**
 * Stats Command
 *
 * Show statistics about succ usage, including token savings and estimated costs.
 */

import {
  getStats,
  getMemoryStats,
  getTokenStatsAggregated,
  getTokenStatsSummary,
  clearTokenStats,
  type TokenEventType,
} from '../lib/db.js';
import { formatTokens, compressionPercent } from '../lib/token-counter.js';
import { getIdleReflectionConfig } from '../lib/config.js';
import { estimateSavings, formatCost } from '../lib/pricing.js';

interface StatsOptions {
  tokens?: boolean;
  clear?: boolean;
  model?: string;
}

export async function stats(options: StatsOptions = {}): Promise<void> {
  if (options.clear) {
    clearTokenStats();
    console.log('Token stats cleared.');
    return;
  }

  if (options.tokens) {
    await showTokenStats(options.model);
  } else {
    await showGeneralStats();
  }
}

async function showGeneralStats(): Promise<void> {
  const docStats = getStats();
  const memStats = getMemoryStats();

  console.log('## Documents');
  console.log(`  Files indexed: ${docStats.total_files}`);
  console.log(`  Total chunks: ${docStats.total_documents}`);
  console.log(`  Last indexed: ${docStats.last_indexed || 'Never'}`);

  console.log('\n## Memories');
  console.log(`  Total: ${memStats.total_memories}`);

  if (memStats.by_type && Object.keys(memStats.by_type).length > 0) {
    console.log('  By type:');
    for (const [type, count] of Object.entries(memStats.by_type)) {
      console.log(`    ${type}: ${count}`);
    }
  }

  console.log('\nRun `succ stats --tokens` to see token savings statistics.');
}

async function showTokenStats(overrideModel?: string): Promise<void> {
  const idleConfig = getIdleReflectionConfig();
  const summaryEnabled = idleConfig.operations?.session_summary ?? true;

  const aggregated = getTokenStatsAggregated();
  const summary = getTokenStatsSummary();

  // If model is specified, recalculate costs; otherwise use stored costs
  const useStoredCosts = !overrideModel;
  const pricingModel = overrideModel || 'sonnet';

  console.log('## Token Savings\n');

  // Session Summaries
  const sessionStats = aggregated.find((s) => s.event_type === 'session_summary');
  console.log('### Session Summaries');
  if (!summaryEnabled) {
    console.log('  Status: disabled (not tracking)');
  } else if (sessionStats) {
    const sessionSavings = useStoredCosts
      ? sessionStats.total_estimated_cost
      : estimateSavings(sessionStats.total_savings_tokens, pricingModel);
    console.log(`  Sessions: ${sessionStats.query_count}`);
    console.log(`  Transcript: ${formatTokens(sessionStats.total_full_source_tokens)} tokens`);
    console.log(`  Summary: ${formatTokens(sessionStats.total_returned_tokens)} tokens`);
    console.log(
      `  Compression: ${compressionPercent(sessionStats.total_full_source_tokens, sessionStats.total_returned_tokens)}`
    );
    console.log(`  Saved: ${formatTokens(sessionStats.total_savings_tokens)} tokens (~${formatCost(sessionSavings)})`);
  } else {
    console.log('  No session summaries recorded yet.');
  }

  // RAG Queries
  console.log('\n### RAG Queries');

  const ragTypes: TokenEventType[] = ['recall', 'search', 'search_code'];
  let ragTotal = {
    queries: 0,
    returned: 0,
    saved: 0,
    cost: 0,
  };

  for (const type of ragTypes) {
    const stat = aggregated.find((s) => s.event_type === type);
    if (stat) {
      const label = type === 'search_code' ? 'search_code' : type;
      const typeSavings = useStoredCosts
        ? stat.total_estimated_cost
        : estimateSavings(stat.total_savings_tokens, pricingModel);
      console.log(
        `  ${label.padEnd(12)}: ${stat.query_count} queries, ${formatTokens(stat.total_returned_tokens)} returned, ${formatTokens(stat.total_savings_tokens)} saved (~${formatCost(typeSavings)})`
      );
      ragTotal.queries += stat.query_count;
      ragTotal.returned += stat.total_returned_tokens;
      ragTotal.saved += stat.total_savings_tokens;
      ragTotal.cost += typeSavings;
    }
  }

  if (ragTotal.queries === 0) {
    console.log('  No RAG queries recorded yet.');
    console.log('  Use succ_recall, succ_search, or succ_search_code to start tracking.');
  } else {
    console.log(
      `  ${'Subtotal'.padEnd(12)}: ${ragTotal.queries} queries, ${formatTokens(ragTotal.returned)} returned, ${formatTokens(ragTotal.saved)} saved (~${formatCost(ragTotal.cost)})`
    );
  }

  // Total
  console.log('\n### Total');
  if (summary.total_queries > 0) {
    const totalSavings = useStoredCosts
      ? summary.total_estimated_cost
      : estimateSavings(summary.total_savings_tokens, pricingModel);
    console.log(`  Queries: ${summary.total_queries}`);
    console.log(`  Tokens returned: ${formatTokens(summary.total_returned_tokens)}`);
    console.log(`  Tokens saved: ${formatTokens(summary.total_savings_tokens)}`);
    if (useStoredCosts) {
      console.log(`  Estimated savings: ${formatCost(totalSavings)}`);
    } else {
      console.log(`  Estimated savings: ${formatCost(totalSavings)} (recalculated at ${pricingModel} rates)`);
    }
  } else {
    console.log('  No stats recorded yet.');
  }

  console.log('\nRun `succ stats --tokens --clear` to reset statistics.');
  console.log('Use `--model opus|sonnet|haiku` to recalculate with different pricing.');
}
