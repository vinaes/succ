/**
 * Precompute Context Command
 *
 * Generate context briefing for next session from transcript.
 */

import { precomputeContextCLI } from '../lib/precompute-context.js';

interface PrecomputeContextOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

export async function precomputeContext(
  transcriptPath: string,
  options: PrecomputeContextOptions = {}
): Promise<void> {
  await precomputeContextCLI(transcriptPath, {
    dryRun: options.dryRun,
    verbose: options.verbose,
  });
}
