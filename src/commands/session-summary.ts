/**
 * Session Summary Command
 *
 * Extract facts from session transcripts and save as memories.
 */

import { sessionSummary as runSessionSummary } from '../lib/session-summary.js';

interface SessionSummaryOptions {
  dryRun?: boolean;
  verbose?: boolean;
  local?: boolean;
  openrouter?: boolean;
  apiUrl?: string;
  model?: string;
}

export async function sessionSummary(
  transcriptPath: string,
  options: SessionSummaryOptions = {}
): Promise<void> {
  await runSessionSummary(transcriptPath, {
    dryRun: options.dryRun,
    verbose: options.verbose,
    local: options.local,
    openrouter: options.openrouter,
    apiUrl: options.apiUrl,
    model: options.model,
  });
}
