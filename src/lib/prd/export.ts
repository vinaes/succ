/**
 * PRD Export — Obsidian-compatible Mermaid workflow visualization
 *
 * Generates markdown files with Mermaid diagrams (Gantt timeline, dependency DAG)
 * and per-task detail pages from PRD execution data.
 */

import fs from 'fs';
import path from 'path';
import { getSuccDir } from '../config.js';
import { logError } from '../fault-logger.js';
import {
  loadPrd,
  loadTasks,
  loadExecution,
  findLatestPrd,
  listPrds,
} from './state.js';
import type { Prd, Task, PrdExecution } from './types.js';
import { NotFoundError } from '../errors.js';

// ============================================================================
// Public API
// ============================================================================

export interface ExportResult {
  prdId: string;
  filesCreated: number;
  outputDir: string;
}

/**
 * Export a single PRD to Obsidian-compatible markdown with Mermaid diagrams.
 * If prdId is not given, uses the latest PRD.
 */
export function exportPrdToObsidian(
  prdId?: string,
  outputDir?: string
): ExportResult {
  const resolvedId = resolvePrdId(prdId);
  const prd = loadPrd(resolvedId);
  if (!prd) {
    throw new NotFoundError(`PRD not found: ${resolvedId}`);
  }

  const tasks = loadTasks(resolvedId);
  const execution = loadExecution(resolvedId);

  const prdDir = getPrdExportDir(prd, outputDir);
  fs.mkdirSync(path.join(prdDir, 'Tasks'), { recursive: true });

  let filesCreated = 0;

  // Overview.md
  fs.writeFileSync(path.join(prdDir, 'Overview.md'), generateOverview(prd, tasks, execution));
  filesCreated++;

  // Dependencies.md
  fs.writeFileSync(path.join(prdDir, 'Dependencies.md'), generateDependencies(prd, tasks));
  filesCreated++;

  // Timeline.md (only if tasks have attempts with timestamps)
  const hasTimestamps = tasks.some(t => t.attempts.length > 0 && t.attempts[0].started_at);
  if (hasTimestamps) {
    fs.writeFileSync(
      path.join(prdDir, 'Timeline.md'),
      generateTimeline(prd, tasks, execution)
    );
    filesCreated++;
  }

  // Per-task pages
  for (const task of tasks) {
    fs.writeFileSync(
      path.join(prdDir, 'Tasks', `${task.id}.md`),
      generateTaskPage(prd, task)
    );
    filesCreated++;
  }

  return { prdId: resolvedId, filesCreated, outputDir: prdDir };
}

/**
 * Export all PRDs to Obsidian.
 */
export function exportAllPrds(
  outputDir?: string,
  includeArchived = true
): ExportResult[] {
  const entries = listPrds(includeArchived);
  const results: ExportResult[] = [];
  for (const entry of entries) {
    try {
      results.push(exportPrdToObsidian(entry.id, outputDir));
    } catch (err) {
      logError('prd', `Skipped ${entry.id}: ${err instanceof Error ? err.message : String(err)}`, err instanceof Error ? err : undefined);
    }
  }
  return results;
}

// ============================================================================
// Mermaid: Gantt Timeline
// ============================================================================

/**
 * Generate Mermaid gantt chart for task execution timeline.
 * Exported for testing.
 */
export function generateGanttChart(
  prd: Prd,
  tasks: Task[],
  execution: PrdExecution | null
): string {
  const mode = execution?.mode ?? prd.execution_mode;
  const title = sanitizeMermaid(prd.title);

  const lines: string[] = [
    'gantt',
    `    title PRD: ${title}`,
    '    dateFormat YYYY-MM-DDTHH:mm:ss',
    '    axisFormat %H:%M',
    '',
  ];

  // Collect all task entries with timestamps
  const entries = buildGanttEntries(tasks);

  if (entries.length === 0) {
    return lines.join('\n');
  }

  if (mode === 'team') {
    const concurrency = execution?.concurrency ?? 3;
    const workerGroups = assignToWorkers(entries, concurrency);
    for (const [workerIdx, workerEntries] of workerGroups.entries()) {
      lines.push(`    section Worker ${workerIdx + 1}`);
      for (const entry of workerEntries) {
        lines.push(`    ${entry.line}`);
      }
      lines.push('');
    }
  } else {
    lines.push('    section Tasks');
    for (const entry of entries) {
      lines.push(`    ${entry.line}`);
    }
  }

  return lines.join('\n');
}

interface GanttEntry {
  taskId: string;
  line: string;
  start: Date;
  end: Date;
}

function buildGanttEntries(tasks: Task[]): GanttEntry[] {
  const entries: GanttEntry[] = [];

  for (const task of tasks) {
    if (task.attempts.length === 0) continue;

    // Show each attempt for failed tasks with retries
    if (task.attempts.length > 1) {
      for (const attempt of task.attempts) {
        if (!attempt.started_at || !attempt.completed_at) continue;
        const label = sanitizeMermaid(`${task.id} ${task.title}`.slice(0, 40));
        const tag = statusToGanttTag(attempt.status === 'passed' ? 'completed' : 'failed');
        const alias = `${task.id}_a${attempt.attempt_number}`;
        const start = attempt.started_at.slice(0, 19);
        const end = attempt.completed_at.slice(0, 19);
        entries.push({
          taskId: task.id,
          line: `${label} (${attempt.attempt_number}) ${tag} ${alias}, ${start}, ${end}`,
          start: new Date(attempt.started_at),
          end: new Date(attempt.completed_at),
        });
      }
    } else {
      const attempt = task.attempts[0];
      if (!attempt.started_at) continue;
      const label = sanitizeMermaid(`${task.id} ${task.title}`.slice(0, 40));
      const tag = statusToGanttTag(task.status);
      const alias = task.id.replace('task_', 't');
      const start = attempt.started_at.slice(0, 19);
      const end = attempt.completed_at
        ? attempt.completed_at.slice(0, 19)
        : start; // still running
      entries.push({
        taskId: task.id,
        line: `${label} ${tag} ${alias}, ${start}, ${end}`,
        start: new Date(attempt.started_at),
        end: new Date(attempt.completed_at || attempt.started_at),
      });
    }
  }

  return entries;
}

function assignToWorkers(entries: GanttEntry[], concurrency: number): GanttEntry[][] {
  // Sort by start time
  const sorted = [...entries].sort((a, b) => a.start.getTime() - b.start.getTime());
  const workers: { entries: GanttEntry[]; freeAt: number }[] = [];

  for (let i = 0; i < concurrency; i++) {
    workers.push({ entries: [], freeAt: 0 });
  }

  for (const entry of sorted) {
    // Find first worker that's free at entry start time
    let assigned = false;
    for (const worker of workers) {
      if (worker.freeAt <= entry.start.getTime()) {
        worker.entries.push(entry);
        worker.freeAt = entry.end.getTime();
        assigned = true;
        break;
      }
    }
    // If no worker free, add to least-busy one
    if (!assigned) {
      const leastBusy = workers.reduce((a, b) => (a.freeAt <= b.freeAt ? a : b));
      leastBusy.entries.push(entry);
      leastBusy.freeAt = entry.end.getTime();
    }
  }

  return workers.filter(w => w.entries.length > 0).map(w => w.entries);
}

function statusToGanttTag(status: string): string {
  switch (status) {
    case 'completed': return ':done,';
    case 'failed': return ':crit,';
    default: return ':active,';
  }
}

// ============================================================================
// Mermaid: Dependency Graph
// ============================================================================

/**
 * Generate Mermaid flowchart for task dependencies.
 * Exported for testing.
 */
export function generateDependencyGraph(tasks: Task[]): string {
  const lines: string[] = ['flowchart TD'];

  // Node definitions
  for (const task of tasks) {
    const title = sanitizeMermaid(task.title.slice(0, 40));
    const emoji = statusEmoji(task.status);
    const duration = getTaskDuration(task);
    const durationStr = duration ? formatDuration(duration) : '';
    const label = `${task.id}<br/>${title}<br/>${emoji} ${durationStr}`.replace(/<br\/>$/, '');
    lines.push(`    ${task.id}["${label}"]`);
  }

  lines.push('');

  // Edges
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      lines.push(`    ${dep} --> ${task.id}`);
    }
  }

  lines.push('');

  // Style classes
  lines.push('    classDef done fill:#2ea043,color:#fff');
  lines.push('    classDef failed fill:#f85149,color:#fff');
  lines.push('    classDef skipped fill:#8b949e,color:#fff');
  lines.push('    classDef pending fill:#58a6ff,color:#fff');

  // Assign classes by status
  const byStatus: Record<string, string[]> = {};
  for (const task of tasks) {
    const cls = statusToClass(task.status);
    if (!byStatus[cls]) byStatus[cls] = [];
    byStatus[cls].push(task.id);
  }
  for (const [cls, ids] of Object.entries(byStatus)) {
    lines.push(`    class ${ids.join(',')} ${cls}`);
  }

  return lines.join('\n');
}

function statusEmoji(status: string): string {
  switch (status) {
    case 'completed': return '✅';
    case 'failed': return '❌';
    case 'skipped': return '⏭️';
    case 'in_progress': return '🔄';
    default: return '⏳';
  }
}

function statusToClass(status: string): string {
  switch (status) {
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'skipped': return 'skipped';
    default: return 'pending';
  }
}

// ============================================================================
// Markdown Generation
// ============================================================================

function generateOverview(prd: Prd, tasks: Task[], execution: PrdExecution | null): string {
  const mode = execution?.mode ?? prd.execution_mode;
  const duration = prd.stats.total_duration_ms;

  const completedLine = prd.completed_at ? `\ncompleted: ${prd.completed_at.slice(0, 19)}` : '';
  let md = `---
prd_id: ${prd.id}
title: "${escapeFrontmatter(prd.title)}"
status: ${prd.status}
mode: ${mode}
created: ${prd.created_at.slice(0, 19)}${completedLine}
duration_ms: ${duration}
tasks_total: ${prd.stats.total_tasks}
tasks_completed: ${prd.stats.completed_tasks}
tasks_failed: ${prd.stats.failed_tasks}
---

# ${prd.title}

${prd.description}

## Stats

| Metric | Value |
|--------|-------|
| Status | ${prd.status} |
| Mode | ${mode} |
| Tasks | ${prd.stats.completed_tasks}/${prd.stats.total_tasks} completed |
| Failed | ${prd.stats.failed_tasks} |
| Skipped | ${prd.stats.skipped_tasks} |
| Attempts | ${prd.stats.total_attempts} |
| Duration | ${formatDuration(duration)} |
`;

  if (prd.quality_gates.length > 0) {
    md += `
## Quality Gates

| Type | Command | Required |
|------|---------|----------|
`;
    for (const gate of prd.quality_gates) {
      md += `| ${gate.type} | \`${gate.command}\` | ${gate.required ? 'Yes' : 'No'} |\n`;
    }
  }

  if (prd.goals.length > 0) {
    md += `\n## Goals\n\n`;
    for (const goal of prd.goals) {
      md += `- ${goal}\n`;
    }
  }

  if (prd.out_of_scope.length > 0) {
    md += `\n## Out of Scope\n\n`;
    for (const item of prd.out_of_scope) {
      md += `- ${item}\n`;
    }
  }

  // Embedded dependency graph
  md += `\n## Dependency Graph\n\n\`\`\`mermaid\n${generateDependencyGraph(tasks)}\n\`\`\`\n`;

  // Links
  md += `\n## Pages\n\n`;
  md += `- [[Timeline]]\n`;
  md += `- [[Dependencies]]\n`;
  for (const task of tasks) {
    md += `- [[Tasks/${task.id}|${task.id}: ${task.title}]]\n`;
  }

  md += `\n---\n*Exported: ${new Date().toISOString().slice(0, 19)}*\n`;

  return md;
}

function generateDependencies(prd: Prd, tasks: Task[]): string {
  return `---
prd_id: ${prd.id}
title: "Dependencies — ${escapeFrontmatter(prd.title)}"
---

# Dependencies: ${prd.title}

\`\`\`mermaid
${generateDependencyGraph(tasks)}
\`\`\`

## Task List

| Task | Status | Priority | Depends On |
|------|--------|----------|------------|
${tasks.map(t => `| [[Tasks/${t.id}\\|${t.id}]] | ${statusEmoji(t.status)} ${t.status} | ${t.priority} | ${t.depends_on.length > 0 ? t.depends_on.map(d => `[[Tasks/${d}\\|${d}]]`).join(', ') : '—'} |`).join('\n')}

← [[Overview]]
`;
}

function generateTimeline(prd: Prd, tasks: Task[], execution: PrdExecution | null): string {
  const gantt = generateGanttChart(prd, tasks, execution);

  return `---
prd_id: ${prd.id}
title: "Timeline — ${escapeFrontmatter(prd.title)}"
---

# Timeline: ${prd.title}

\`\`\`mermaid
${gantt}
\`\`\`

## Execution Details

| Task | Started | Completed | Duration | Attempts | Status |
|------|---------|-----------|----------|----------|--------|
${tasks.filter(t => t.attempts.length > 0).map(t => {
  const firstAttempt = t.attempts[0];
  const lastAttempt = t.attempts[t.attempts.length - 1];
  const dur = getTaskDuration(t);
  return `| [[Tasks/${t.id}\\|${t.id}]] | ${firstAttempt.started_at.slice(11, 19)} | ${lastAttempt.completed_at?.slice(11, 19) ?? '—'} | ${dur ? formatDuration(dur) : '—'} | ${t.attempts.length} | ${statusEmoji(t.status)} |`;
}).join('\n')}

← [[Overview]]
`;
}

function generateTaskPage(prd: Prd, task: Task): string {
  const duration = getTaskDuration(task);

  const durationLine = duration !== null ? `\nduration_ms: ${duration}` : '';
  let md = `---
task_id: ${task.id}
prd_id: ${prd.id}
sequence: ${task.sequence}
status: ${task.status}
priority: ${task.priority}
attempts: ${task.attempts.length}${durationLine}
---

# ${task.id}: ${task.title}

${task.description}

## Acceptance Criteria

${task.acceptance_criteria.map(c => `- [ ] ${c}`).join('\n') || '— none specified —'}

`;

  if (task.depends_on.length > 0) {
    md += `## Dependencies\n\n`;
    for (const dep of task.depends_on) {
      md += `- [[Tasks/${dep}|${dep}]]\n`;
    }
    md += '\n';
  }

  // Files
  if (task.files_to_modify.length > 0 || task.attempts.some(a => a.files_actually_modified.length > 0)) {
    md += `## Files\n\n`;
    md += `**Predicted:** ${task.files_to_modify.join(', ') || '—'}\n\n`;
    const lastAttempt = task.attempts[task.attempts.length - 1];
    if (lastAttempt?.files_actually_modified.length > 0) {
      md += `**Actually modified:** ${lastAttempt.files_actually_modified.join(', ')}\n\n`;
    }
  }

  // Attempts
  if (task.attempts.length > 0) {
    md += `## Attempts\n\n`;
    md += `| # | Started | Completed | Status | Gates |\n`;
    md += `|---|---------|-----------|--------|-------|\n`;
    for (const attempt of task.attempts) {
      const gatesSummary = attempt.gate_results.length > 0
        ? attempt.gate_results.map(g => `${g.passed ? '✅' : '❌'}${g.gate.type}`).join(' ')
        : '—';
      md += `| ${attempt.attempt_number} | ${attempt.started_at.slice(11, 19)} | ${attempt.completed_at?.slice(11, 19) ?? '—'} | ${attempt.status} | ${gatesSummary} |\n`;
    }
    md += '\n';

    // Detailed gate results for last attempt
    const lastAttempt = task.attempts[task.attempts.length - 1];
    if (lastAttempt.gate_results.length > 0) {
      md += `### Gate Results (attempt ${lastAttempt.attempt_number})\n\n`;
      md += `| Gate | Passed | Duration |\n`;
      md += `|------|--------|----------|\n`;
      for (const gr of lastAttempt.gate_results) {
        md += `| ${gr.gate.type} | ${gr.passed ? '✅' : '❌'} | ${formatDuration(gr.duration_ms)} |\n`;
      }
      md += '\n';
    }

    // Error info
    if (task.status === 'failed') {
      const failedAttempt = task.attempts.find(a => a.status === 'failed' && a.error);
      if (failedAttempt?.error) {
        md += `## Error\n\n\`\`\`\n${failedAttempt.error}\n\`\`\`\n\n`;
      }
    }
  }

  md += `← [[Overview]] | [[Dependencies]] | [[Timeline]]\n`;

  return md;
}

// ============================================================================
// Utilities
// ============================================================================

function resolvePrdId(prdId?: string): string {
  if (prdId) return prdId;
  const latest = findLatestPrd();
  if (!latest) {
    throw new NotFoundError('No PRDs found. Create one with: succ prd generate "description"');
  }
  return latest.id;
}

function getPrdExportDir(prd: Prd, outputDir?: string): string {
  const base = outputDir || path.join(getSuccDir(), 'brain', '04_PRD');
  let safeName = prd.title
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (!safeName) safeName = prd.id;
  return path.join(base, safeName);
}

function getTaskDuration(task: Task): number | null {
  if (task.attempts.length === 0) return null;
  let total = 0;
  for (const attempt of task.attempts) {
    if (!attempt.completed_at) continue;
    total += new Date(attempt.completed_at).getTime() - new Date(attempt.started_at).getTime();
  }
  return total > 0 ? total : null;
}

/**
 * Format ms duration as human-readable string. Exported for testing.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Sanitize text for use in Mermaid diagrams. Exported for testing.
 */
export function sanitizeMermaid(text: string): string {
  return text
    .replace(/"/g, "'")
    .replace(/[<>]/g, '')
    .replace(/[#;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeFrontmatter(text: string): string {
  return text.replace(/"/g, '\\"');
}
