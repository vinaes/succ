/**
 * Precompute Context Command
 *
 * Generate context briefing for next session from transcript.
 */

import { precomputeContextCLI } from '../lib/precompute-context.js';

interface PrecomputeContextOptions {
  dryRun?: boolean;
  verbose?: boolean;
  local?: boolean;
  openrouter?: boolean;
  apiUrl?: string;
  model?: string;
}

export async function precomputeContext(
  transcriptPath: string,
  options: PrecomputeContextOptions = {}
): Promise<void> {
  await precomputeContextCLI(transcriptPath, {
    dryRun: options.dryRun,
    verbose: options.verbose,
    local: options.local,
    openrouter: options.openrouter,
    apiUrl: options.apiUrl,
    model: options.model,
  });
}
