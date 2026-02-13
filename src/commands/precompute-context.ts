/**
 * CLI command wrapper for precompute context
 */

import { precomputeContextCLI } from '../lib/precompute-context.js';

interface PrecomputeContextOptions {
  dryRun?: boolean;
  verbose?: boolean;
  api?: boolean;
}

export async function precomputeContext(
  transcriptPath: string,
  options: PrecomputeContextOptions = {}
): Promise<void> {
  await precomputeContextCLI(transcriptPath, {
    dryRun: options.dryRun,
    verbose: options.verbose,
    api: options.api,
  });
}
