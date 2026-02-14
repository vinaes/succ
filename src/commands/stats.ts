/**
 * Stats Command
 *
 * Show statistics about succ usage, including token savings and estimated costs.
 *
 * Cost estimates are shown as "Claude Opus equivalent" to provide a consistent
 * reference point regardless of which LLM backend is actually being used.
 * This helps users understand the value of token savings even when using
 * free local models (Ollama) or different API providers (OpenRouter).
 */

import {
  getStats,
  getMemoryStats,
  getTokenStatsAggregated,
  clearTokenStats,
  type TokenEventType,
} from '../lib/storage/index.js';
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
    await clearTokenStats();
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
  const docStats = await getStats();
  const memStats = await getMemoryStats();

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

  const aggregated = await getTokenStatsAggregated();

  // Always use Opus as reference model for "Claude equivalent" pricing
  // This provides consistent comparison regardless of actual backend used
  const pricingModel = overrideModel || 'opus';
  const isDefaultModel = !overrideModel;

  console.log('## Token Savings\n');
  console.log('> Cost shown as Claude Opus equivalent for comparison\n');

  // Session Summaries
  const sessionStats = aggregated.find((s) => s.event_type === 'session_summary');
  console.log('### Session Summaries');
  if (!summaryEnabled) {
    console.log('  Status: disabled (not tracking)');
  } else if (sessionStats) {
    const sessionSavings = estimateSavings(sessionStats.total_savings_tokens, pricingModel);
    console.log(`  Sessions: ${sessionStats.query_count}`);
    console.log(`  Transcript: ${formatTokens(sessionStats.total_full_source_tokens)} tokens`);
    console.log(`  Summary: ${formatTokens(sessionStats.total_returned_tokens)} tokens`);
    console.log(
      `  Compression: ${compressionPercent(sessionStats.total_full_source_tokens, sessionStats.total_returned_tokens)}`
    );
    console.log(
      `  Saved: ${formatTokens(sessionStats.total_savings_tokens)} tokens (~${formatCost(sessionSavings)})`
    );
  } else {
    console.log('  No session summaries recorded yet.');
  }

  // RAG Queries
  console.log('\n### RAG Queries');

  // recall doesn't have "savings" - it returns memories, not chunks from indexed files
  // search and search_code return chunks vs full files
  const ragTypes: TokenEventType[] = ['recall', 'search', 'search_code'];
  const ragTotal = {
    queries: 0,
    returned: 0,
    saved: 0,
    cost: 0,
  };

  for (const type of ragTypes) {
    const stat = aggregated.find((s) => s.event_type === type);
    if (stat) {
      const label = type === 'search_code' ? 'search_code' : type;

      ragTotal.queries += stat.query_count;
      ragTotal.returned += stat.total_returned_tokens;

      if (stat.total_savings_tokens > 0) {
        const typeSavings = estimateSavings(stat.total_savings_tokens, pricingModel);
        console.log(
          `  ${label.padEnd(12)}: ${stat.query_count} queries, ${formatTokens(stat.total_returned_tokens)} returned, ${formatTokens(stat.total_savings_tokens)} saved (~${formatCost(typeSavings)})`
        );
        ragTotal.saved += stat.total_savings_tokens;
        ragTotal.cost += typeSavings;
      } else {
        console.log(
          `  ${label.padEnd(12)}: ${stat.query_count} queries, ${formatTokens(stat.total_returned_tokens)} returned`
        );
      }
    }
  }

  if (ragTotal.queries === 0) {
    console.log('  No RAG queries recorded yet.');
    console.log('  Use succ_recall, succ_search, or succ_search_code to start tracking.');
  } else if (ragTotal.saved > 0) {
    console.log(
      `  ${'Subtotal'.padEnd(12)}: ${ragTotal.queries} queries, ${formatTokens(ragTotal.returned)} returned, ${formatTokens(ragTotal.saved)} saved (~${formatCost(ragTotal.cost)})`
    );
  } else {
    console.log(
      `  ${'Subtotal'.padEnd(12)}: ${ragTotal.queries} queries, ${formatTokens(ragTotal.returned)} returned`
    );
  }

  // Grand Total with breakdown
  console.log('\n### Grand Total');

  const sessionSaved = sessionStats?.total_savings_tokens || 0;
  const totalSaved = sessionSaved + ragTotal.saved;

  if (totalSaved > 0) {
    const totalSavings = estimateSavings(totalSaved, pricingModel);

    // Show breakdown
    if (sessionSaved > 0 && ragTotal.saved > 0) {
      const sessionCost = estimateSavings(sessionSaved, pricingModel);
      const ragCost = ragTotal.cost;
      console.log(
        `  Session compression: ${formatTokens(sessionSaved)} tokens (~${formatCost(sessionCost)})`
      );
      console.log(
        `  RAG optimization:    ${formatTokens(ragTotal.saved)} tokens (~${formatCost(ragCost)})`
      );
      console.log('  ─────────────────────────────────────');
    }

    console.log(`  Total saved: ${formatTokens(totalSaved)} tokens`);
    if (isDefaultModel) {
      console.log(`  Claude equivalent: ~${formatCost(totalSavings)} (at Opus rates)`);
    } else {
      console.log(`  Claude equivalent: ~${formatCost(totalSavings)} (at ${pricingModel} rates)`);
    }
  } else {
    console.log('  No savings recorded yet.');
  }

  console.log('\nRun `succ stats --tokens --clear` to reset statistics.');
  console.log('Use `--model opus|sonnet|haiku` to compare with different Claude models.');
}
