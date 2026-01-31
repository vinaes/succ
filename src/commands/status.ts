import fs from 'fs';
import { getDbPath, getClaudeDir, getProjectRoot } from '../lib/config.js';
import { getStats, closeDb } from '../lib/db.js';

export async function status(): Promise<void> {
  const projectRoot = getProjectRoot();
  const claudeDir = getClaudeDir();
  const dbPath = getDbPath();

  console.log('succ status\n');
  console.log(`Project root: ${projectRoot}`);
  console.log(`Claude dir:   ${claudeDir}`);
  console.log(`Database:     ${dbPath}`);
  console.log();

  // Check if initialized
  if (!fs.existsSync(dbPath)) {
    console.log('Status: Not initialized');
    console.log('\nRun `succ init` to initialize.');
    return;
  }

  try {
    const stats = getStats();

    console.log('Status: Initialized');
    console.log();
    console.log(`Total files indexed:  ${stats.total_files}`);
    console.log(`Total chunks:         ${stats.total_documents}`);
    console.log(`Last indexed:         ${stats.last_indexed || 'Never'}`);

    // Check for API key
    const hasApiKey = !!process.env.OPENROUTER_API_KEY;
    console.log();
    console.log(`OpenRouter API key:   ${hasApiKey ? 'Set' : 'Not set'}`);

    if (!hasApiKey) {
      console.log('\nWarning: Set OPENROUTER_API_KEY to enable indexing and search.');
    }
  } catch (error) {
    console.error('Error reading database:', error);
  } finally {
    closeDb();
  }
}
