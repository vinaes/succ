/**
 * Checkpoint Command
 *
 * Create and restore full backups of succ state.
 *
 * Usage:
 *   succ checkpoint create              - Create checkpoint
 *   succ checkpoint create -o backup.json
 *   succ checkpoint restore backup.json
 *   succ checkpoint list                - List checkpoints
 *   succ checkpoint info backup.json    - Show checkpoint details
 */

import path from 'path';
import {
  createCheckpoint,
  readCheckpoint,
  restoreCheckpoint,
  listCheckpoints,
  formatSize,
} from '../lib/checkpoint.js';
import { logError } from '../lib/fault-logger.js';

export interface CheckpointOptions {
  action: 'create' | 'restore' | 'list' | 'info';
  file?: string;
  output?: string;
  compress?: boolean;
  includeBrain?: boolean;
  includeDocuments?: boolean;
  includeConfig?: boolean;
  overwrite?: boolean;
  restoreBrain?: boolean;
  restoreDocuments?: boolean;
  restoreConfig?: boolean;
}

export async function checkpoint(options: CheckpointOptions): Promise<void> {
  switch (options.action) {
    case 'create':
      await doCreate(options);
      break;
    case 'restore':
      await doRestore(options);
      break;
    case 'list':
      await doList();
      break;
    case 'info':
      await doInfo(options);
      break;
    default:
      logError('checkpoint', `Unknown action: ${options.action}`);

      console.error(`Unknown action: ${options.action}`);
      console.log('Usage: succ checkpoint <create|restore|list|info>');
  }
}

async function doCreate(options: CheckpointOptions): Promise<void> {
  console.log('Creating checkpoint...\n');

  try {
    const { checkpoint: cp, outputPath } = await createCheckpoint({
      includeBrain: options.includeBrain ?? true,
      includeDocuments: options.includeDocuments ?? true,
      includeConfig: options.includeConfig ?? true,
      compress: options.compress ?? false,
      outputPath: options.output,
    });

    console.log('Checkpoint created successfully!\n');
    console.log(`  File: ${outputPath}`);
    console.log(`  Project: ${cp.project_name}`);
    console.log(`  Version: ${cp.succ_version}`);
    console.log('');
    console.log('Contents:');
    console.log(`  Memories: ${cp.stats.memories_count}`);
    console.log(`  Documents: ${cp.stats.documents_count}`);
    console.log(`  Memory links: ${cp.stats.links_count}`);
    console.log(`  Brain files: ${cp.stats.brain_files_count}`);
    console.log('');

    // Show file size
    const fs = await import('fs');
    const stat = fs.statSync(outputPath);
    console.log(`  Size: ${formatSize(stat.size)}`);

  } catch (error) {
    logError('checkpoint', 'Failed to create checkpoint', error instanceof Error ? error : new Error(String(error)));
    console.error('Failed to create checkpoint:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function doRestore(options: CheckpointOptions): Promise<void> {
  if (!options.file) {
    logError('checkpoint', 'No checkpoint file specified');
    console.error('Error: No checkpoint file specified');
    console.log('Usage: succ checkpoint restore <file>');
    process.exit(1);
  }

  const filePath = path.resolve(options.file);

  console.log(`Reading checkpoint: ${filePath}\n`);

  try {
    const cp = readCheckpoint(filePath);

    console.log('Checkpoint info:');
    console.log(`  Project: ${cp.project_name}`);
    console.log(`  Created: ${cp.created_at}`);
    console.log(`  succ version: ${cp.succ_version}`);
    console.log('');
    console.log('Contents:');
    console.log(`  Memories: ${cp.stats.memories_count}`);
    console.log(`  Documents: ${cp.stats.documents_count}`);
    console.log(`  Memory links: ${cp.stats.links_count}`);
    console.log(`  Brain files: ${cp.stats.brain_files_count}`);
    console.log('');

    if (!options.overwrite) {
      console.log('Note: Use --overwrite to replace existing data');
      console.log('      Without --overwrite, data will be merged (may create duplicates)');
      console.log('');
    }

    console.log('Restoring...\n');

    const result = await restoreCheckpoint(cp, {
      overwrite: options.overwrite ?? false,
      restoreBrain: options.restoreBrain ?? true,
      restoreDocuments: options.restoreDocuments ?? true,
      restoreConfig: options.restoreConfig ?? false,
    });

    console.log('Restore complete!\n');
    console.log('Restored:');
    console.log(`  Memories: ${result.memoriesRestored}`);
    console.log(`  Documents: ${result.documentsRestored}`);
    console.log(`  Memory links: ${result.linksRestored}`);
    console.log(`  Brain files: ${result.brainFilesRestored}`);

  } catch (error) {
    logError('checkpoint', 'Failed to restore checkpoint', error instanceof Error ? error : new Error(String(error)));
    console.error('Failed to restore checkpoint:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function doList(): Promise<void> {
  const checkpoints = listCheckpoints();

  if (checkpoints.length === 0) {
    console.log('No checkpoints found.');
    console.log('Create one with: succ checkpoint create');
    return;
  }

  console.log('Available checkpoints:\n');

  for (const cp of checkpoints) {
    const compressed = cp.compressed ? ' (compressed)' : '';
    const date = cp.created_at ? new Date(cp.created_at).toLocaleString() : 'unknown';
    console.log(`  ${cp.name}${compressed}`);
    console.log(`    Created: ${date}`);
    console.log(`    Size: ${formatSize(cp.size)}`);
    console.log('');
  }

  console.log(`Total: ${checkpoints.length} checkpoint(s)`);
}

async function doInfo(options: CheckpointOptions): Promise<void> {
  if (!options.file) {
    logError('checkpoint', 'No checkpoint file specified for info command');
    console.error('Error: No checkpoint file specified');
    console.log('Usage: succ checkpoint info <file>');
    process.exit(1);
  }

  const filePath = path.resolve(options.file);

  try {
    const cp = readCheckpoint(filePath);

    console.log('## Checkpoint Info\n');
    console.log(`File: ${filePath}`);
    console.log(`Version: ${cp.version}`);
    console.log(`Created: ${cp.created_at}`);
    console.log(`Project: ${cp.project_name}`);
    console.log(`succ version: ${cp.succ_version}`);
    console.log('');

    console.log('## Contents\n');
    console.log(`Memories: ${cp.stats.memories_count}`);
    console.log(`Documents: ${cp.stats.documents_count}`);
    console.log(`Memory links: ${cp.stats.links_count}`);
    console.log(`Brain files: ${cp.stats.brain_files_count}`);
    console.log('');

    // Show brain vault structure
    if (cp.data.brain_vault.length > 0) {
      console.log('## Brain Vault Files\n');
      for (const file of cp.data.brain_vault.slice(0, 20)) {
        console.log(`  ${file.path}`);
      }
      if (cp.data.brain_vault.length > 20) {
        console.log(`  ... and ${cp.data.brain_vault.length - 20} more`);
      }
      console.log('');
    }

    // Show config keys (not values for security)
    if (Object.keys(cp.data.config).length > 0) {
      console.log('## Config Keys\n');
      for (const key of Object.keys(cp.data.config)) {
        console.log(`  ${key}`);
      }
    }

  } catch (error) {
    logError('checkpoint', 'Failed to read checkpoint', error instanceof Error ? error : new Error(String(error)));
    console.error('Failed to read checkpoint:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
