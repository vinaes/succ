/**
 * PRD Pipeline CLI Commands
 *
 * Commands: generate, parse, run, list, status
 */

import fs from 'fs';
import { generatePrd } from '../lib/prd/generate.js';
import { parsePrd } from '../lib/prd/parse.js';
import { runPrd } from '../lib/prd/runner.js';
import {
  loadPrd,
  loadPrdMarkdown,
  loadTasks,
  savePrd,
  saveTasks,
  listPrds,
  findLatestPrd,
  appendProgress,
} from '../lib/prd/state.js';
import { exportPrdToObsidian, exportAllPrds } from '../lib/prd/export.js';
import { computeStats } from '../lib/prd/types.js';
import type { ExecutionMode } from '../lib/prd/types.js';
import { logError } from '../lib/fault-logger.js';

// ============================================================================
// Options interfaces
// ============================================================================

interface GenerateOptions {
  mode?: string;
  gates?: string;
  model?: string;
  autoParse?: boolean;
}

interface ParseOptions {
  prdId?: string;
  dryRun?: boolean;
}

interface StatusOptions {
  json?: boolean;
  verbose?: boolean;
}

interface RunCmdOptions {
  mode?: string;
  concurrency?: string;
  resume?: boolean;
  task?: string;
  dryRun?: boolean;
  maxIterations?: string;
  noBranch?: boolean;
  model?: string;
  force?: boolean;
}

interface ListOptions {
  all?: boolean;
}

// ============================================================================
// generate
// ============================================================================

export async function prdGenerate(
  description: string,
  options: GenerateOptions = {}
): Promise<void> {
  try {
    console.log(`Generating PRD from: "${description}"\n`);
    console.log('Gathering codebase context...');

    const result = await generatePrd(description, {
      mode: (options.mode as ExecutionMode) ?? 'loop',
      gates: options.gates,
      autoParse: options.autoParse,
    });

    console.log(`\nPRD created: ${result.prd.id}`);
    console.log(`  Title: ${result.prd.title}`);
    console.log(`  Status: ${result.prd.status}`);
    console.log(`  Mode: ${result.prd.execution_mode}`);
    console.log(`  Gates: ${result.prd.quality_gates.map((g) => g.type).join(', ') || 'none'}`);

    if (result.tasks) {
      console.log(`\n  Tasks: ${result.tasks.length}`);
      for (const task of result.tasks) {
        const deps = task.depends_on.length > 0 ? ` (depends: ${task.depends_on.join(', ')})` : '';
        console.log(`    ${task.id}: ${task.title}${deps}`);
      }
      if (result.parseWarnings && result.parseWarnings.length > 0) {
        console.log('\n  Warnings:');
        for (const w of result.parseWarnings) {
          console.log(`    - ${w}`);
        }
      }
    } else {
      console.log(`\nNext: succ prd parse ${result.prd.id}`);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logError('prd', `Error generating PRD: ${msg}`);

    console.error(`Error generating PRD: ${msg}`);
    process.exit(1);
  }
}

// ============================================================================
// parse
// ============================================================================

export async function prdParse(fileOrId: string, options: ParseOptions = {}): Promise<void> {
  try {
    let prdContent: string;
    let prdId: string;
    let description: string;

    // Determine if input is a file path or PRD ID
    if (fileOrId.startsWith('prd_') || fileOrId.match(/^prd_[a-f0-9]+$/)) {
      // It's a PRD ID — load from state
      prdId = fileOrId;
      const prd = loadPrd(prdId);
      if (!prd) {
        logError('prd', `PRD not found: ${prdId}`);

        console.error(`PRD not found: ${prdId}`);
        process.exit(1);
      }
      prdContent = loadPrdMarkdown(prdId) ?? '';
      if (!prdContent) {
        logError('prd', `PRD markdown not found for: ${prdId}`);

        console.error(`PRD markdown not found for: ${prdId}`);
        process.exit(1);
      }
      description = prd.description;
    } else if (fs.existsSync(fileOrId)) {
      // It's a file path — read it
      prdContent = fs.readFileSync(fileOrId, 'utf-8');
      description = prdContent.slice(0, 200); // Use beginning as description for context

      if (options.prdId) {
        prdId = options.prdId;
      } else {
        // Create a new PRD from this file
        const { createPrd } = await import('../lib/prd/types.js');
        const { savePrd, savePrdMarkdown } = await import('../lib/prd/state.js');
        const title = extractTitleFromMarkdown(prdContent);
        const prd = createPrd({ title, description });
        savePrd(prd);
        savePrdMarkdown(prd.id, prdContent);
        prdId = prd.id;
        console.log(`Created PRD ${prdId} from file: ${fileOrId}`);
      }
    } else {
      logError('prd', `Not found: ${fileOrId} (expected PRD ID or file path)`);

      console.error(`Not found: ${fileOrId} (expected PRD ID or file path)`);
      process.exit(1);
    }

    console.log(`Parsing PRD ${prdId} into tasks...`);
    console.log('Gathering codebase context...');

    const result = await parsePrd(prdContent, prdId, description);

    if (options.dryRun) {
      console.log(`\n[DRY RUN] Would create ${result.tasks.length} tasks:\n`);
    } else {
      // Save tasks
      saveTasks(prdId, result.tasks);

      // Update PRD status
      const prd = loadPrd(prdId);
      if (prd) {
        prd.status = 'ready';
        prd.stats = computeStats(result.tasks);
        savePrd(prd);
      }

      appendProgress(prdId, `Parsed PRD into ${result.tasks.length} tasks`);
      console.log(`\nCreated ${result.tasks.length} tasks for ${prdId}:\n`);
    }

    // Display tasks
    for (const task of result.tasks) {
      const deps = task.depends_on.length > 0 ? ` -> depends: ${task.depends_on.join(', ')}` : '';
      const files = task.files_to_modify.length > 0 ? ` [${task.files_to_modify.join(', ')}]` : '';
      console.log(`  ${task.id} [${task.priority}] ${task.title}${deps}`);
      if (files) console.log(`    files: ${task.files_to_modify.join(', ')}`);
    }

    // Warnings
    if (result.warnings.length > 0) {
      console.log('\nWarnings:');
      for (const w of result.warnings) {
        console.log(`  - ${w}`);
      }
    }

    if (!options.dryRun) {
      console.log(`\nNext: succ prd status ${prdId}`);
      console.log(`Run:  succ prd run ${prdId}`);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logError('prd', `Error parsing PRD: ${msg}`);

    console.error(`Error parsing PRD: ${msg}`);
    process.exit(1);
  }
}

// ============================================================================
// run
// ============================================================================

export async function prdRun(prdIdArg?: string, options: RunCmdOptions = {}): Promise<void> {
  try {
    // Find PRD
    let prdId = prdIdArg;
    if (!prdId) {
      const latest = findLatestPrd();
      if (!latest) {
        console.log('No PRDs found. Create one with: succ prd generate "description"');
        return;
      }
      prdId = latest.id;
    }

    console.log(`Running PRD: ${prdId}`);

    const result = await runPrd(prdId, {
      mode: (options.mode as 'loop' | 'team') ?? 'loop',
      concurrency: options.concurrency ? parseInt(options.concurrency, 10) : undefined,
      resume: options.resume,
      taskId: options.task,
      dryRun: options.dryRun,
      maxIterations: options.maxIterations ? parseInt(options.maxIterations, 10) : undefined,
      noBranch: options.noBranch,
      model: options.model,
      force: options.force,
    });

    if (!options.dryRun) {
      process.exit(result.success ? 0 : 1);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logError('prd', `Error running PRD: ${msg}`);

    console.error(`Error running PRD: ${msg}`);
    process.exit(1);
  }
}

// ============================================================================
// list
// ============================================================================

export async function prdList(options: ListOptions = {}): Promise<void> {
  const entries = listPrds(options.all);

  if (entries.length === 0) {
    console.log('No PRDs found. Create one with: succ prd generate "description"');
    return;
  }

  console.log(`PRDs (${entries.length}):\n`);

  for (const entry of entries) {
    const statusIcon = getStatusIcon(entry.status);
    const created = entry.created_at.slice(0, 10);
    console.log(`  ${statusIcon} ${entry.id}  ${entry.title}`);
    console.log(
      `    status: ${entry.status} | mode: ${entry.execution_mode} | created: ${created}`
    );
  }
}

// ============================================================================
// status
// ============================================================================

export async function prdStatus(prdIdArg?: string, options: StatusOptions = {}): Promise<void> {
  // Find PRD
  let prdId = prdIdArg;
  if (!prdId) {
    const latest = findLatestPrd();
    if (!latest) {
      console.log('No PRDs found. Create one with: succ prd generate "description"');
      return;
    }
    prdId = latest.id;
  }

  const prd = loadPrd(prdId);
  if (!prd) {
    logError('prd', `PRD not found: ${prdId}`);

    console.error(`PRD not found: ${prdId}`);
    process.exit(1);
  }

  const tasks = loadTasks(prdId);

  if (options.json) {
    console.log(JSON.stringify({ prd, tasks }, null, 2));
    return;
  }

  // Header
  const statusIcon = getStatusIcon(prd.status);
  console.log(`${statusIcon} PRD: ${prd.title}`);
  console.log(`  ID: ${prd.id}`);
  console.log(`  Status: ${prd.status}`);
  console.log(`  Mode: ${prd.execution_mode}`);
  console.log(`  Created: ${prd.created_at.slice(0, 19).replace('T', ' ')}`);

  if (prd.goals.length > 0) {
    console.log(`  Goals:`);
    for (const g of prd.goals) {
      console.log(`    - ${g}`);
    }
  }

  if (prd.quality_gates.length > 0) {
    console.log(`  Gates: ${prd.quality_gates.map((g) => `${g.type}(${g.command})`).join(', ')}`);
  }

  // Tasks
  if (tasks.length === 0) {
    console.log('\n  No tasks yet. Parse with: succ prd parse ' + prdId);
    return;
  }

  // Stats
  const stats = computeStats(tasks);
  console.log(`\n  Tasks: ${stats.completed_tasks}/${stats.total_tasks} completed`);
  if (stats.failed_tasks > 0) console.log(`  Failed: ${stats.failed_tasks}`);
  if (stats.skipped_tasks > 0) console.log(`  Skipped: ${stats.skipped_tasks}`);

  // Task list
  console.log('');
  for (const task of tasks) {
    const icon = getTaskStatusIcon(task.status);
    const deps = task.depends_on.length > 0 ? ` (deps: ${task.depends_on.join(', ')})` : '';
    console.log(`  ${icon} ${task.id}: ${task.title}${deps}`);

    if (options.verbose) {
      console.log(`    Priority: ${task.priority}`);
      if (task.files_to_modify.length > 0) {
        console.log(`    Files: ${task.files_to_modify.join(', ')}`);
      }
      if (task.acceptance_criteria.length > 0) {
        console.log('    Criteria:');
        for (const c of task.acceptance_criteria) {
          console.log(`      - ${c}`);
        }
      }
      if (task.attempts.length > 0) {
        console.log(`    Attempts: ${task.attempts.length}`);
        const lastAttempt = task.attempts[task.attempts.length - 1];
        console.log(
          `    Last: ${lastAttempt.status}${lastAttempt.error ? ' — ' + lastAttempt.error : ''}`
        );
      }
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getStatusIcon(status: string): string {
  switch (status) {
    case 'draft':
      return '[.]';
    case 'ready':
      return '[>]';
    case 'in_progress':
      return '[~]';
    case 'completed':
      return '[+]';
    case 'failed':
      return '[x]';
    case 'archived':
      return '[-]';
    default:
      return '[ ]';
  }
}

function getTaskStatusIcon(status: string): string {
  switch (status) {
    case 'pending':
      return '[ ]';
    case 'in_progress':
      return '[~]';
    case 'completed':
      return '[+]';
    case 'failed':
      return '[x]';
    case 'skipped':
      return '[-]';
    default:
      return '[ ]';
  }
}

function extractTitleFromMarkdown(markdown: string): string {
  const match = markdown.match(/^#\s+(?:PRD:\s*)?(.+)$/m);
  if (match) return match[1].trim();
  return 'Untitled PRD';
}

export async function prdArchive(
  prdIdArg?: string,
  _options: Record<string, unknown> = {}
): Promise<void> {
  let prdId = prdIdArg;
  if (!prdId) {
    const latest = findLatestPrd();
    if (!latest) {
      console.error('No PRDs found. Create one with: succ prd generate "description"');
      process.exit(1);
    }
    prdId = latest.id;
  }

  const prd = loadPrd(prdId);
  if (!prd) {
    logError('prd', `PRD not found: ${prdId}`);

    console.error(`PRD not found: ${prdId}`);
    process.exit(1);
  }

  try {
    prd.status = 'archived';
    savePrd(prd);
    console.log(`Archived PRD: ${prd.title} (${prdId})`);
  } catch (error) {
    logError(
      'prd',
      `Failed to archive PRD: ${error instanceof Error ? error.message : String(error)}`
    );

    console.error(
      `Failed to archive PRD: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

// ============================================================================
// Export
// ============================================================================

interface ExportOptions {
  output?: string;
  all?: boolean;
}

export async function prdExport(prdIdArg?: string, options: ExportOptions = {}): Promise<void> {
  try {
    if (options.all) {
      const results = exportAllPrds(options.output);
      if (results.length === 0) {
        console.log('No PRDs to export.');
        return;
      }
      for (const result of results) {
        console.log(`Exported ${result.prdId}: ${result.filesCreated} files → ${result.outputDir}`);
      }
      console.log(`Total: ${results.length} PRDs exported.`);
    } else {
      const result = exportPrdToObsidian(prdIdArg, options.output);
      console.log(`Exported ${result.prdId}: ${result.filesCreated} files → ${result.outputDir}`);
    }
  } catch (error) {
    logError('prd', `Export failed: ${error instanceof Error ? error.message : String(error)}`);

    console.error(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
