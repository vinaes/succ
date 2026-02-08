/**
 * PRD State Management
 *
 * File-based CRUD for PRD state in .succ/prds/.
 * NOT using StorageBackend — this is file-based like Ralph.
 * .succ/prds/ should be in .gitignore (state management, not code).
 */

import fs from 'fs';
import path from 'path';
import { getSuccDir } from '../config.js';
import type { Prd, PrdExecution, PrdIndexEntry, Task } from './types.js';
import { prdToIndexEntry } from './types.js';

// ============================================================================
// Path helpers
// ============================================================================

function getPrdsDir(): string {
  return path.join(getSuccDir(), 'prds');
}

function getPrdDir(prdId: string): string {
  return path.join(getPrdsDir(), prdId);
}

function getIndexPath(): string {
  return path.join(getPrdsDir(), 'index.json');
}

function getPrdJsonPath(prdId: string): string {
  return path.join(getPrdDir(prdId), 'prd.json');
}

function getPrdMdPath(prdId: string): string {
  return path.join(getPrdDir(prdId), 'prd.md');
}

function getTasksPath(prdId: string): string {
  return path.join(getPrdDir(prdId), 'tasks.json');
}

function getExecutionPath(prdId: string): string {
  return path.join(getPrdDir(prdId), 'execution.json');
}

function getProgressPath(prdId: string): string {
  return path.join(getPrdDir(prdId), 'progress.md');
}

function getLogsDir(prdId: string): string {
  return path.join(getPrdDir(prdId), 'logs');
}

// ============================================================================
// Directory setup
// ============================================================================

/**
 * Ensure .succ/prds/ directory exists
 */
export function ensurePrdsDir(): void {
  const dir = getPrdsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Ensure a specific PRD directory exists with logs subdirectory
 */
function ensurePrdDir(prdId: string): void {
  const dir = getPrdDir(prdId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const logsDir = getLogsDir(prdId);
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

// ============================================================================
// Index operations
// ============================================================================

/**
 * Load the PRD index (list of all PRDs)
 */
export function loadIndex(): PrdIndexEntry[] {
  const indexPath = getIndexPath();
  if (!fs.existsSync(indexPath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
}

/**
 * Save the PRD index
 */
function saveIndex(entries: PrdIndexEntry[]): void {
  ensurePrdsDir();
  fs.writeFileSync(getIndexPath(), JSON.stringify(entries, null, 2));
}

/**
 * Update or add an entry in the index
 */
function upsertIndex(entry: PrdIndexEntry): void {
  const entries = loadIndex();
  const idx = entries.findIndex(e => e.id === entry.id);
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  saveIndex(entries);
}

/**
 * Remove an entry from the index
 */
function removeFromIndex(prdId: string): void {
  const entries = loadIndex().filter(e => e.id !== prdId);
  saveIndex(entries);
}

// ============================================================================
// PRD CRUD
// ============================================================================

/**
 * Save a PRD (creates directory, writes prd.json, updates index)
 */
export function savePrd(prd: Prd): void {
  ensurePrdDir(prd.id);
  prd.updated_at = new Date().toISOString();
  fs.writeFileSync(getPrdJsonPath(prd.id), JSON.stringify(prd, null, 2));
  upsertIndex(prdToIndexEntry(prd));
}

/**
 * Load a PRD by ID
 */
export function loadPrd(prdId: string): Prd | null {
  const jsonPath = getPrdJsonPath(prdId);
  if (!fs.existsSync(jsonPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
}

/**
 * Delete a PRD and all its files
 */
export function deletePrd(prdId: string): void {
  const dir = getPrdDir(prdId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  removeFromIndex(prdId);
}

/**
 * List all PRDs (from index)
 */
export function listPrds(includeArchived = false): PrdIndexEntry[] {
  const entries = loadIndex();
  if (includeArchived) return entries;
  return entries.filter(e => e.status !== 'archived');
}

/**
 * Find the most recent PRD (for commands without explicit ID)
 */
export function findLatestPrd(): PrdIndexEntry | null {
  const entries = loadIndex().filter(e => e.status !== 'archived');
  if (entries.length === 0) return null;
  return entries.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

// ============================================================================
// PRD Markdown
// ============================================================================

/**
 * Save the PRD markdown content
 */
export function savePrdMarkdown(prdId: string, content: string): void {
  ensurePrdDir(prdId);
  fs.writeFileSync(getPrdMdPath(prdId), content, 'utf-8');
}

/**
 * Load the PRD markdown content
 */
export function loadPrdMarkdown(prdId: string): string | null {
  const mdPath = getPrdMdPath(prdId);
  if (!fs.existsSync(mdPath)) return null;
  return fs.readFileSync(mdPath, 'utf-8');
}

// ============================================================================
// Tasks
// ============================================================================

/**
 * Save tasks for a PRD
 */
export function saveTasks(prdId: string, tasks: Task[]): void {
  ensurePrdDir(prdId);
  fs.writeFileSync(getTasksPath(prdId), JSON.stringify(tasks, null, 2));
}

/**
 * Load tasks for a PRD
 */
export function loadTasks(prdId: string): Task[] {
  const tasksPath = getTasksPath(prdId);
  if (!fs.existsSync(tasksPath)) return [];
  return JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));
}

// ============================================================================
// Execution state
// ============================================================================

/**
 * Save execution state
 */
export function saveExecution(execution: PrdExecution): void {
  ensurePrdDir(execution.prd_id);
  fs.writeFileSync(getExecutionPath(execution.prd_id), JSON.stringify(execution, null, 2));
}

/**
 * Load execution state
 */
export function loadExecution(prdId: string): PrdExecution | null {
  const execPath = getExecutionPath(prdId);
  if (!fs.existsSync(execPath)) return null;
  return JSON.parse(fs.readFileSync(execPath, 'utf-8'));
}

// ============================================================================
// Progress log
// ============================================================================

/**
 * Append a line to progress.md
 */
export function appendProgress(prdId: string, line: string): void {
  ensurePrdDir(prdId);
  const progressPath = getProgressPath(prdId);
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  fs.appendFileSync(progressPath, `[${timestamp}] ${line}\n`);
}

/**
 * Load progress.md content
 */
export function loadProgress(prdId: string): string {
  const progressPath = getProgressPath(prdId);
  if (!fs.existsSync(progressPath)) return '';
  return fs.readFileSync(progressPath, 'utf-8');
}

// ============================================================================
// Task logs
// ============================================================================

/**
 * Get the path for a task log file
 */
export function getTaskLogPath(prdId: string, taskId: string): string {
  ensurePrdDir(prdId);
  return path.join(getLogsDir(prdId), `${taskId}.log`);
}

/**
 * Append output to a task log
 */
export function appendTaskLog(prdId: string, taskId: string, content: string): void {
  const logPath = getTaskLogPath(prdId, taskId);
  fs.appendFileSync(logPath, content);
}
