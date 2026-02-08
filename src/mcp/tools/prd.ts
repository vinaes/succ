/**
 * MCP PRD Pipeline tools
 *
 * succ_prd_generate: Generate a PRD from a description
 * succ_prd_list: List existing PRDs
 * succ_prd_status: Show PRD and task status
 * succ_prd_run: Execute or resume a PRD
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { projectPathParam, applyProjectPath } from '../helpers.js';
import { generatePrd } from '../../lib/prd/generate.js';
import { runPrd } from '../../lib/prd/runner.js';
import {
  loadPrd,
  loadTasks,
  listPrds,
  findLatestPrd,
} from '../../lib/prd/state.js';
import type { ExecutionMode } from '../../lib/prd/types.js';

export function registerPrdTools(server: McpServer) {
  // --------------------------------------------------------------------------
  // succ_prd_generate
  // --------------------------------------------------------------------------
  server.tool(
    'succ_prd_generate',
    'Generate a PRD (Product Requirements Document) from a feature description. Auto-detects quality gates from project files. Returns PRD ID and parsed tasks.',
    {
      description: z.string().describe('Feature description (e.g., "Add user authentication with JWT")'),
      mode: z.enum(['loop', 'team']).optional().default('loop').describe('Execution mode (default: loop)'),
      gates: z.string().optional().describe('Custom quality gates as comma-separated specs (e.g., "test:npm test,lint:eslint .")'),
      auto_parse: z.boolean().optional().default(true).describe('Automatically parse PRD into tasks (default: true)'),
      model: z.string().optional().describe('LLM model override'),
      project_path: projectPathParam,
    },
    async ({ description, mode, gates, auto_parse, model, project_path }) => {
      await applyProjectPath(project_path);
      try {
        const result = await generatePrd(description, {
          mode: mode as ExecutionMode,
          gates,
          autoParse: auto_parse,
          model,
        });

        let text = `PRD generated: ${result.prd.id}\nTitle: ${result.prd.title}\nStatus: ${result.prd.status}`;
        text += `\nQuality gates: ${result.prd.quality_gates.map(g => `${g.type}: ${g.command}`).join(', ')}`;

        if (result.tasks) {
          text += `\n\nTasks (${result.tasks.length}):`;
          for (const task of result.tasks) {
            text += `\n  ${task.id}: ${task.title} [${task.priority}]`;
          }
        }

        text += `\n\nNext: succ prd run ${result.prd.id}`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Error generating PRD: ${msg}` }], isError: true };
      }
    }
  );

  // --------------------------------------------------------------------------
  // succ_prd_list
  // --------------------------------------------------------------------------
  server.tool(
    'succ_prd_list',
    'List all PRDs in the project. Shows ID, title, status, and task counts.',
    {
      all: z.boolean().optional().default(false).describe('Include archived PRDs'),
      project_path: projectPathParam,
    },
    async ({ all, project_path }) => {
      await applyProjectPath(project_path);
      try {
        const entries = listPrds(all);
        if (entries.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No PRDs found. Create one with succ_prd_generate.' }] };
        }

        const lines = entries.map(e =>
          `${e.id} | ${e.status.padEnd(11)} | ${e.title}`
        );
        return { content: [{ type: 'text' as const, text: `PRDs:\n${lines.join('\n')}` }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Error listing PRDs: ${msg}` }], isError: true };
      }
    }
  );

  // --------------------------------------------------------------------------
  // succ_prd_status
  // --------------------------------------------------------------------------
  server.tool(
    'succ_prd_status',
    'Show detailed status of a PRD and its tasks. If no ID given, shows the latest PRD.',
    {
      prd_id: z.string().optional().describe('PRD ID (e.g., "prd_abc12345"). If omitted, uses latest PRD.'),
      project_path: projectPathParam,
    },
    async ({ prd_id, project_path }) => {
      await applyProjectPath(project_path);
      try {
        let id = prd_id;
        if (!id) {
          const latest = findLatestPrd();
          if (!latest) return { content: [{ type: 'text' as const, text: 'No PRDs found.' }] };
          id = latest.id;
        }

        const prd = loadPrd(id);
        if (!prd) return { content: [{ type: 'text' as const, text: `PRD not found: ${id}` }], isError: true };

        const tasks = loadTasks(id);
        let text = `PRD: ${prd.title} (${prd.id})\nStatus: ${prd.status}\nMode: ${prd.execution_mode}`;
        text += `\nGates: ${prd.quality_gates.map(g => g.type).join(', ') || 'none'}`;
        text += `\nStats: ${prd.stats.completed_tasks}/${prd.stats.total_tasks} completed`;
        if (prd.stats.failed_tasks > 0) text += `, ${prd.stats.failed_tasks} failed`;

        if (tasks.length > 0) {
          text += '\n\nTasks:';
          for (const t of tasks) {
            const icon = t.status === 'completed' ? '[+]' : t.status === 'failed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
            text += `\n  ${icon} ${t.id}: ${t.title} (${t.status}, ${t.attempts.length} attempts)`;
          }
        }

        if (prd.status === 'in_progress' || prd.status === 'failed') {
          text += `\n\nResume: succ prd run ${id} --resume`;
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // --------------------------------------------------------------------------
  // succ_prd_run
  // --------------------------------------------------------------------------
  server.tool(
    'succ_prd_run',
    'Execute or resume a PRD. Runs tasks in order with quality gates, branch isolation, and auto-commit. Use resume=true to continue an interrupted run.',
    {
      prd_id: z.string().optional().describe('PRD ID. If omitted, uses latest PRD.'),
      resume: z.boolean().optional().default(false).describe('Resume from previous execution instead of starting fresh'),
      task_id: z.string().optional().describe('Run a specific task only (e.g., "task_001")'),
      dry_run: z.boolean().optional().default(false).describe('Show execution plan without running'),
      max_iterations: z.number().optional().describe('Max full-PRD retries (default: 3)'),
      no_branch: z.boolean().optional().default(false).describe('Skip branch isolation, run in current branch'),
      model: z.string().optional().describe('Claude model override (default: sonnet)'),
      force: z.boolean().optional().default(false).describe('Force resume even if another runner may be active'),
      mode: z.enum(['loop', 'team']).optional().default('loop').describe('Execution mode: loop (sequential) or team (parallel)'),
      concurrency: z.number().optional().describe('Max parallel workers in team mode (default: 3)'),
      project_path: projectPathParam,
    },
    async ({ prd_id, resume, task_id, dry_run, max_iterations, no_branch, model, force, mode, concurrency, project_path }) => {
      await applyProjectPath(project_path);
      try {
        let id = prd_id;
        if (!id) {
          const latest = findLatestPrd();
          if (!latest) return { content: [{ type: 'text' as const, text: 'No PRDs found. Create one with succ_prd_generate.' }] };
          id = latest.id;
        }

        const result = await runPrd(id, {
          mode: (mode as 'loop' | 'team') ?? 'loop',
          concurrency,
          resume,
          taskId: task_id,
          dryRun: dry_run,
          maxIterations: max_iterations,
          noBranch: no_branch,
          model,
          force,
        });

        let text = `PRD ${id}: ${result.prd.status}`;
        text += `\nCompleted: ${result.tasksCompleted}/${result.prd.stats.total_tasks}`;
        if (result.tasksFailed > 0) text += `\nFailed: ${result.tasksFailed}`;
        if (result.branch) {
          text += `\n\nBranch: ${result.branch}`;
          text += `\nMerge: git merge ${result.branch}`;
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Error running PRD: ${msg}` }], isError: true };
      }
    }
  );
}
