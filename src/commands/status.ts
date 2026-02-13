import fs from 'fs';
import path from 'path';
import { getDbPath, getClaudeDir, getProjectRoot, getDaemonStatuses } from '../lib/config.js';
import { getStats, getStaleFileCount, closeDb } from '../lib/storage/index.js';
import { getStorageInfo } from '../lib/storage/index.js';
import { logError } from '../lib/fault-logger.js';

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
          console.log(`   Log: succ daemon logs`);
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
      console.log(`   Check: succ daemon logs`);
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
    const stats = await getStats();

    console.log('Status: Initialized');
    console.log();
    console.log(`Total files indexed:  ${stats.total_files}`);
    console.log(`Total chunks:         ${stats.total_documents}`);
    console.log(`Last indexed:         ${stats.last_indexed || 'Never'}`);

    // Show storage backend config
    console.log();
    const storageInfo = getStorageInfo();
    console.log(`Storage backend:      ${storageInfo.backend}`);
    console.log(`Vector backend:       ${storageInfo.vector}`);
    if (storageInfo.backend === 'sqlite') {
      console.log(`Database path:        ${storageInfo.path}`);
      if (storageInfo.globalPath) {
        console.log(`Global DB path:       ${storageInfo.globalPath}`);
      }
    } else if (storageInfo.backend === 'postgresql') {
      console.log(`Connection:           ${storageInfo.path}`);
    }

    // Show embedding config
    console.log();
    try {
      const { getLLMTaskConfig, hasApiKey } = await import('../lib/config.js');
      const embCfg = getLLMTaskConfig('embeddings');
      console.log(`Embedding mode:       ${embCfg.mode}`);
      console.log(`Embedding model:      ${embCfg.model}`);

      if (embCfg.mode === 'api') {
        console.log(`API key:              ${hasApiKey() ? 'Set' : 'Not set'}`);
        console.log(`API URL:              ${embCfg.api_url}`);
      }
    } catch (error: any) {
      // Config validation failed - show the issue
      console.log(`Config status:        ${error.message}`);
    }

    // Index freshness
    try {
      const freshness = await getStaleFileCount(projectRoot);
      if (freshness.stale > 0 || freshness.deleted > 0) {
        console.log();
        console.log('Index freshness:');
        console.log(`  Indexed files:      ${freshness.total}`);
        if (freshness.stale > 0) {
          console.log(`  Stale (modified):   ${freshness.stale}`);
        }
        if (freshness.deleted > 0) {
          console.log(`  Missing (deleted):  ${freshness.deleted}`);
        }
        console.log('  Run `succ reindex` to refresh');
      }
    } catch {
      // Skip freshness check if it fails
    }

    // Daemon statuses
    try {
      const daemons = await getDaemonStatuses();
      console.log();
      console.log('Daemons:');
      for (const d of daemons) {
        const icon = d.running ? '+' : '-';
        const pidInfo = d.running && d.pid ? ` (PID: ${d.pid})` : '';
        console.log(`  [${icon}] ${d.name}: ${d.running ? 'running' : 'stopped'}${pidInfo}`);
      }
    } catch {
      // Skip daemon status if it fails
    }
  } catch (error) {
    logError(
      'status',
      'Error reading database:',
      error instanceof Error ? error : new Error(String(error))
    );

    console.error('Error reading database:', error);
  } finally {
    closeDb();
  }
}
