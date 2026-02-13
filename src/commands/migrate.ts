/**
 * Migrate command - migrate data between storage backends.
 *
 * Supports:
 * - SQLite to PostgreSQL
 * - PostgreSQL to SQLite
 * - Export to JSON file (backup)
 * - Import from JSON file (restore)
 */

import fs from 'fs';
import path from 'path';
import { getStorageInfo } from '../lib/storage/index.js';
import {
  exportData,
  exportToFile,
  importFromFile,
  getExportStats,
} from '../lib/storage/migration/export-import.js';
import { logError } from '../lib/fault-logger.js';

interface MigrateOptions {
  to?: 'sqlite' | 'postgresql';
  export?: string;
  import?: string;
  dryRun?: boolean;
  force?: boolean;
}

export async function migrate(options: MigrateOptions): Promise<void> {
  const storageInfo = getStorageInfo();

  // Export to file
  if (options.export) {
    console.log('Exporting data...\n');
    console.log(`Current backend: ${storageInfo.backend} + ${storageInfo.vector}`);

    if (options.dryRun) {
      const data = exportData();
      console.log('\nDry run - would export:');
      console.log(`  Documents: ${data.documents.length}`);
      console.log(`  Memories: ${data.memories.length}`);
      console.log(`  Memory links: ${data.memoryLinks.length}`);
      console.log(`  Global memories: ${data.globalMemories.length}`);
      console.log(`  Token frequencies: ${data.tokenFrequencies.length}`);
      console.log(`  Token stats: ${data.tokenStats.length}`);
      console.log(`\nWould write to: ${options.export}`);
      return;
    }

    exportToFile(options.export);
    const stats = getExportStats(options.export);
    const fileSize = fs.statSync(options.export).size;

    console.log('\nExport complete!');
    console.log(`  File: ${options.export}`);
    console.log(`  Size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Documents: ${stats.counts.documents}`);
    console.log(`  Memories: ${stats.counts.memories}`);
    console.log(`  Memory links: ${stats.counts.memoryLinks}`);
    console.log(`  Global memories: ${stats.counts.globalMemories}`);
    return;
  }

  // Import from file
  if (options.import) {
    if (!fs.existsSync(options.import)) {
      logError('migrate', `Error: File not found: ${options.import}`);
      console.error(`Error: File not found: ${options.import}`);
      process.exit(1);
    }

    const stats = getExportStats(options.import);
    console.log('Import data preview:\n');
    console.log(`  Version: ${stats.version}`);
    console.log(`  Exported at: ${stats.exportedAt}`);
    console.log(`  Source backend: ${stats.backend}`);
    console.log(`  Embedding model: ${stats.embeddingModel || 'unknown'}`);
    console.log(`\n  Documents: ${stats.counts.documents}`);
    console.log(`  Memories: ${stats.counts.memories}`);
    console.log(`  Memory links: ${stats.counts.memoryLinks}`);
    console.log(`  Global memories: ${stats.counts.globalMemories}`);

    console.log(`\nTarget backend: ${storageInfo.backend} + ${storageInfo.vector}`);

    if (options.dryRun) {
      console.log('\nDry run - no data was imported.');
      return;
    }

    if (!options.force) {
      console.log('\nWarning: This will REPLACE all existing data in the target backend.');
      console.log('Use --force to confirm, or --dry-run to preview.');
      process.exit(1);
    }

    console.log('\nImporting data...');
    const result = importFromFile(options.import);

    console.log('\nImport complete!');
    console.log(`  Documents: ${result.documents}`);
    console.log(`  Memories: ${result.memories}`);
    console.log(`  Memory links: ${result.memoryLinks}`);
    console.log(`  Global memories: ${result.globalMemories}`);
    return;
  }

  // Migrate to a different backend
  if (options.to) {
    if (options.to === storageInfo.backend) {
      console.log(`Already using ${options.to} backend. Nothing to migrate.`);
      return;
    }

    console.log(`Migrate from ${storageInfo.backend} to ${options.to}\n`);

    // Step 1: Export from current backend
    console.log('Step 1: Exporting from current backend...');
    const data = exportData();
    console.log(`  Documents: ${data.documents.length}`);
    console.log(`  Memories: ${data.memories.length}`);
    console.log(`  Memory links: ${data.memoryLinks.length}`);
    console.log(`  Global memories: ${data.globalMemories.length}`);

    if (options.dryRun) {
      console.log('\nDry run - would migrate to ' + options.to);
      console.log('\nTo complete migration:');
      console.log('1. Update config.json to set storage.backend = "' + options.to + '"');
      console.log('2. Run: succ migrate --import <backup.json>');
      return;
    }

    // Step 2: Create backup file
    const backupPath = path.join(process.cwd(), `.succ/migrate-backup-${Date.now()}.json`);
    console.log('\nStep 2: Creating backup...');
    exportToFile(backupPath);
    console.log(`  Backup saved: ${backupPath}`);

    // Step 3: Instructions for completing migration
    console.log('\nStep 3: Update configuration');
    console.log('To complete the migration:');
    console.log('');
    console.log(`1. Edit .succ/config.json and set:`);

    if (options.to === 'postgresql') {
      console.log('   {');
      console.log('     "storage": {');
      console.log('       "backend": "postgresql",');
      console.log('       "postgresql": {');
      console.log('         "connection_string": "postgresql://user:pass@localhost:5432/succ"');
      console.log('       }');
      console.log('     }');
      console.log('   }');
    } else {
      console.log('   {');
      console.log('     "storage": {');
      console.log('       "backend": "sqlite"');
      console.log('     }');
      console.log('   }');
    }

    console.log('');
    console.log(`2. Run: succ migrate --import "${backupPath}" --force`);
    console.log('');
    console.log('3. Verify data: succ status');
    console.log('');
    console.log('4. (Optional) Delete backup: rm "' + backupPath + '"');

    return;
  }

  // No action specified - show help
  console.log('succ migrate - Migrate data between storage backends\n');
  console.log('Current configuration:');
  console.log(`  Backend: ${storageInfo.backend}`);
  console.log(`  Vector: ${storageInfo.vector}`);
  if (storageInfo.path) {
    console.log(`  Path: ${storageInfo.path}`);
  }

  console.log('\nUsage:');
  console.log('  succ migrate --export <file.json>    Export data to JSON file');
  console.log('  succ migrate --import <file.json>    Import data from JSON file');
  console.log('  succ migrate --to postgresql         Migrate to PostgreSQL');
  console.log('  succ migrate --to sqlite             Migrate to SQLite');
  console.log('\nOptions:');
  console.log('  --dry-run    Preview without making changes');
  console.log('  --force      Confirm destructive operations');
}
