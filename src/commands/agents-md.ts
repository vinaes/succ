/**
 * AGENTS.md Command
 *
 * Generate .claude/AGENTS.md from project memories.
 *
 * Usage:
 *   succ agents-md             - Generate AGENTS.md
 *   succ agents-md --preview   - Preview without writing
 *   succ agents-md --path X    - Custom output path
 */

import { generateAgentsMd, writeAgentsMd } from '../lib/agents-md-generator.js';
import { closeDb } from '../lib/db/index.js';

export interface AgentsMdOptions {
  preview?: boolean;
  path?: string;
}

export async function agentsMd(options: AgentsMdOptions = {}): Promise<void> {
  try {
    if (options.preview) {
      const content = generateAgentsMd();
      console.log(content);
      return;
    }

    const result = writeAgentsMd(options.path ? { output_path: options.path } : undefined);
    console.log(`Generated ${result.path} (${result.entries} entries)`);
  } catch (error: any) {
    console.error(`Error generating AGENTS.md: ${error.message}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}
