/**
 * Embedding management CLI commands.
 *
 * - info: Show current embedding model, dimensions, and backend status
 * - migrate: Change embedding model/dimensions with automatic config update
 */

import { getConfig, getLLMTaskConfig, invalidateConfigCache } from '../lib/config.js';
import { getEmbeddingInfo, getEmbedding, getModelDimension } from '../lib/embeddings.js';
import {
  initStorageDispatcher,
  getStoredEmbeddingDimension,
  getMemoryCount,
  getMemoryEmbeddingCount,
} from '../lib/storage/index.js';
import { configSet } from './config.js';

/**
 * Show current embedding configuration and status.
 */
export async function embeddingInfo(): Promise<void> {
  const info = getEmbeddingInfo();
  const config = getConfig();
  const taskCfg = getLLMTaskConfig('embeddings');

  console.log('Embedding Configuration');
  console.log('=======================');
  console.log(`  Mode:       ${info.mode}`);
  console.log(`  Model:      ${info.model}`);
  console.log(`  Dimensions: ${info.dimensions ?? 'auto (model default)'}`);
  console.log(`  API URL:    ${taskCfg.api_url || '(local)'}`);

  const nativeDims = getModelDimension(info.model);
  const configDims = config.llm?.embeddings?.dimensions;
  if (nativeDims && configDims && configDims !== nativeDims) {
    console.log(`  MRL:        ${nativeDims} -> ${configDims} (Matryoshka truncation)`);
  }

  // Test embedding
  console.log('\nConnectivity Test');
  console.log('-----------------');
  try {
    const testEmb = await getEmbedding('test');
    console.log(`  API call:   OK (${testEmb.length} dims returned)`);
  } catch (err) {
    console.log(`  API call:   FAILED - ${(err as Error).message}`);
  }

  // Storage status
  console.log('\nStorage Status');
  console.log('--------------');
  const backend = config.storage?.backend ?? 'sqlite';
  console.log(`  Backend:    ${backend}`);

  try {
    await initStorageDispatcher();
    const storedDim = await getStoredEmbeddingDimension();
    const memTotal = await getMemoryCount();
    const memWithEmb = await getMemoryEmbeddingCount();

    console.log(`  Stored dim: ${storedDim ?? 'none (empty index)'}`);
    console.log(`  Memories:   ${memWithEmb}/${memTotal} have embeddings`);

    if (storedDim && info.dimensions && storedDim !== info.dimensions) {
      console.log(
        `\n  WARNING: Dimension mismatch! Stored=${storedDim}, Config=${info.dimensions}`
      );
      console.log('  Run: succ index --force && succ index --memories');
    }
  } catch (err) {
    console.log(`  Status:     Error - ${(err as Error).message}`);
  }
}

interface MigrateOptions {
  model?: string;
  dims?: string;
  apiUrl?: string;
  apiKey?: string;
  mode?: string;
  yes?: boolean;
  project?: boolean;
}

/**
 * Migrate embedding model/dimensions.
 * Updates config in both global and project scope, then tests connectivity.
 */
export async function embeddingMigrate(options: MigrateOptions): Promise<void> {
  const currentInfo = getEmbeddingInfo();

  const newModel = options.model;
  const newDims = options.dims ? parseInt(options.dims, 10) : undefined;
  const newMode = options.mode;
  const newApiUrl = options.apiUrl;
  const newApiKey = options.apiKey;

  // Validate dimensions
  if (newDims !== undefined && (isNaN(newDims) || newDims < 1)) {
    console.error('Invalid dimensions. Must be a positive integer.');
    process.exitCode = 1;
    return;
  }

  // Must specify at least something
  if (!newModel && !newDims && !newMode && !newApiUrl && !newApiKey) {
    console.log('Usage: succ embedding migrate [options]');
    console.log('');
    console.log('Options:');
    console.log('  --model <model>     Embedding model ID (e.g., qwen/qwen3-embedding-8b)');
    console.log('  --dims <number>     Output dimensions (MRL truncation)');
    console.log('  --mode <mode>       Embedding mode (local|api)');
    console.log('  --api-url <url>     API endpoint URL');
    console.log('  --api-key <key>     API key');
    console.log('  --project           Apply to project config only (default: both)');
    console.log('  -y, --yes           Skip confirmation');
    console.log('');
    console.log('Current:');
    console.log(
      `  Model: ${currentInfo.model} (${currentInfo.dimensions ?? '?'} dims, mode: ${currentInfo.mode})`
    );
    return;
  }

  // Get effective dims
  const nativeDims = newModel ? getModelDimension(newModel) : getModelDimension(currentInfo.model);
  const effectiveModel = newModel ?? currentInfo.model;
  const effectiveDims = newDims ?? nativeDims ?? currentInfo.dimensions;

  console.log('Embedding Migration');
  console.log('===================');
  console.log(
    `  Current: ${currentInfo.model} (${currentInfo.dimensions ?? '?'} dims, mode: ${currentInfo.mode})`
  );
  console.log(
    `  New:     ${effectiveModel} (${effectiveDims ?? '?'} dims${newMode ? `, mode: ${newMode}` : ''})`
  );

  if (nativeDims && newDims && newDims !== nativeDims) {
    console.log(`  MRL:     ${nativeDims} native -> ${newDims} truncated`);
  }

  // Confirm
  if (!options.yes) {
    const inquirer = await import('inquirer');
    const { confirm } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Apply changes? You will need to reindex after this.',
        default: true,
      },
    ]);
    if (!confirm) {
      console.log('Cancelled.');
      return;
    }
  }

  // Build config changes
  const changes: Array<[string, string]> = [];
  if (newModel) changes.push(['llm.embeddings.model', newModel]);
  if (newDims !== undefined) changes.push(['llm.embeddings.dimensions', String(newDims)]);
  if (newMode) changes.push(['llm.embeddings.mode', newMode]);
  if (newApiUrl) changes.push(['llm.embeddings.api_url', newApiUrl]);
  if (newApiKey) changes.push(['llm.embeddings.api_key', newApiKey]);

  // Apply to global config
  console.log('\nUpdating global config...');
  for (const [key, value] of changes) {
    await configSet(key, value, {});
  }

  // Also apply to project config (unless --project-only was not specified, apply to both)
  if (!options.project) {
    console.log('Updating project config...');
    for (const [key, value] of changes) {
      await configSet(key, value, { project: true });
    }
  }

  invalidateConfigCache();

  // Test new embedding model
  console.log('\nTesting new embedding model...');
  try {
    const testEmb = await getEmbedding('migration test');
    console.log(`  OK: ${testEmb.length} dimensions returned`);

    if (effectiveDims && testEmb.length !== effectiveDims) {
      console.warn(`  WARNING: Expected ${effectiveDims} dims, got ${testEmb.length}`);
    }
  } catch (err) {
    console.error(`  FAILED: ${(err as Error).message}`);
    console.error('  Config was updated but the new model may not work.');
    console.error(
      '  Fix the issue or revert with: succ embedding migrate --model <old-model> --dims <old-dims>'
    );
    return;
  }

  // Show next steps
  console.log('\nNext steps (reindexing required):');
  console.log('  succ index --force           # Reindex brain vault');
  console.log('  succ index --memories         # Re-embed all memories');
  console.log('  succ index-code --force       # Reindex source code (if used)');
  console.log('\nPostgreSQL/Qdrant dimension migration happens automatically on next startup.');
}
