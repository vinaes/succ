import fs from 'fs';
import path from 'path';
import { getDbPath, getClaudeDir, getProjectRoot } from '../lib/config.js';
import { getStats, closeDb } from '../lib/db.js';

export async function status(): Promise<void> {
  const projectRoot = getProjectRoot();
  const claudeDir = getClaudeDir();
  const dbPath = getDbPath();
  const logFile = path.join(claudeDir, 'analyze.log');

  console.log('succ status\n');
  console.log(`Project root: ${projectRoot}`);
  console.log(`Claude dir:   ${claudeDir}`);
  console.log(`Database:     ${dbPath}`);
  console.log();

  // Check for background analysis progress
  const progressFile = path.join(claudeDir, 'analyze.progress.json');
  if (fs.existsSync(progressFile)) {
    try {
      const progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
      const updatedAt = new Date(progress.updatedAt);
      const age = Date.now() - updatedAt.getTime();
      const isRecent = age < 10 * 60 * 1000; // Less than 10 minutes old

      if (isRecent && progress.status !== 'completed') {
        console.log('📊 Analysis in progress');
        console.log(`   Status: ${progress.status}`);
        console.log(`   Progress: ${progress.completed}/${progress.total} agents`);
        if (progress.current) {
          console.log(`   Current: ${progress.current}`);
        }
        console.log(`   Updated: ${Math.round(age / 1000)}s ago`);
        if (fs.existsSync(logFile)) {
          console.log(`   Log: tail -f "${logFile}"`);
        }
        console.log();
      } else if (progress.status === 'completed') {
        console.log('✅ Last analysis completed');
        console.log(`   Finished: ${updatedAt.toLocaleString()}`);
        console.log();
      }
    } catch {
      // Ignore JSON parse errors
    }
  } else if (fs.existsSync(logFile)) {
    const logStat = fs.statSync(logFile);
    const logAge = Date.now() - logStat.mtimeMs;
    const isRecent = logAge < 10 * 60 * 1000;

    if (isRecent) {
      console.log('📊 Background analysis may be running');
      console.log(`   Log file: ${logFile}`);
      console.log(`   Last update: ${Math.round(logAge / 1000)}s ago`);
      console.log(`   Check: tail -f "${logFile}"`);
      console.log();
    }
  }

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
