/**
 * MCP PRD Pipeline tool — succ_prd with actions: generate, list, status, run, export
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { projectPathParam, applyProjectPath } from '../helpers.js';
import { generatePrd } from '../../lib/prd/generate.js';
import { runPrd } from '../../lib/prd/runner.js';
import { exportPrdToObsidian, exportAllPrds } from '../../lib/prd/export.js';
import { loadPrd, loadTasks, listPrds, findLatestPrd } from '../../lib/prd/state.js';
import type { ExecutionMode } from '../../lib/prd/types.js';

export function registerPrdTools(server: McpServer) {
  server.registerTool(
    'succ_prd',
    {
      description:
        'PRD pipeline: generate, list, check status, execute, or export PRDs.\n\nExamples:\n- Generate: succ_prd(action="generate", description="Add user auth with JWT")\n- List: succ_prd(action="list")\n- Status: succ_prd(action="status")\n- Run: succ_prd(action="run")\n- Export: succ_prd(action="export")',
      inputSchema: {
        action: z
          .enum(['generate', 'list', 'status', 'run', 'export'])
          .describe(
            'generate = create PRD, list = show all PRDs, status = PRD details, run = execute, export = Obsidian export'
          ),
        description: z
          .string()
          .optional()
          .describe('Feature description (e.g., "Add user authentication with JWT")'),
        mode: z
          .enum(['loop', 'team'])
          .optional()
          .default('loop')
          .describe('Execution mode (default: loop)'),
        gates: z
          .string()
          .optional()
          .describe(
            'Custom quality gates as comma-separated specs (e.g., "test:npm test,lint:eslint .")'
          ),
        auto_parse: z
          .boolean()
          .optional()
          .default(true)
          .describe('Automatically parse PRD into tasks (default: true)'),
        model: z.string().optional().describe('LLM model override'),
        prd_id: z
          .string()
          .optional()
          .describe('PRD ID (e.g., "prd_abc12345"). If omitted, uses latest PRD.'),
        all: z.boolean().optional().default(false).describe('Include archived PRDs'),
        resume: z
          .boolean()
          .optional()
          .default(false)
          .describe('Resume from previous execution instead of starting fresh'),
        task_id: z.string().optional().describe('Run a specific task only (e.g., "task_001")'),
        dry_run: z
          .boolean()
          .optional()
          .default(false)
          .describe('Show execution plan without running'),
        max_iterations: z.number().optional().describe('Max full-PRD retries (default: 3)'),
        no_branch: z
          .boolean()
          .optional()
          .default(false)
          .describe('Skip branch isolation, run in current branch'),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe('Force resume even if another runner may be active'),
        concurrency: z
          .number()
          .optional()
          .describe('Max parallel workers in team mode (default: 3)'),
        output: z.string().optional().describe('Output directory (default: .succ/brain/prd)'),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      action,
      description,
      mode,
      gates,
      auto_parse,
      model,
      prd_id,
      all,
      resume,
      task_id,
      dry_run,
      max_iterations,
      no_branch,
      force,
      concurrency,
      output,
      project_path,
    }) => {
      await applyProjectPath(project_path);

      switch (action) {
        case 'generate': {
          if (!description) {
            return {
              content: [
                { type: 'text' as const, text: '"description" is required for action="generate"' },
              ],
              isError: true,
            };
          }
          try {
            const result = await generatePrd(description, {
              mode: mode as ExecutionMode,
              gates,
              autoParse: auto_parse,
              model,
            });

            let text = `PRD generated: ${result.prd.id}\nTitle: ${result.prd.title}\nStatus: ${result.prd.status}`;
            text += `\nQuality gates: ${result.prd.quality_gates.map((g) => `${g.type}: ${g.command}`).join(', ')}`;

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
            return {
              content: [{ type: 'text' as const, text: `Error generating PRD: ${msg}` }],
              isError: true,
            };
          }
        }

        case 'list': {
          try {
            const entries = listPrds(all);
            if (entries.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'No PRDs found. Create one with succ_prd(action="generate").',
                  },
                ],
              };
            }

            const lines = entries.map((e) => `${e.id} | ${e.status.padEnd(11)} | ${e.title}`);
            return { content: [{ type: 'text' as const, text: `PRDs:\n${lines.join('\n')}` }] };
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: 'text' as const, text: `Error listing PRDs: ${msg}` }],
              isError: true,
            };
          }
        }

        case 'status': {
          try {
            let id = prd_id;
            if (!id) {
              const latest = findLatestPrd();
              if (!latest) return { content: [{ type: 'text' as const, text: 'No PRDs found.' }] };
              id = latest.id;
            }

            const prd = loadPrd(id);
            if (!prd)
              return {
                content: [{ type: 'text' as const, text: `PRD not found: ${id}` }],
                isError: true,
              };

            const tasks = loadTasks(id);
            let text = `PRD: ${prd.title} (${prd.id})\nStatus: ${prd.status}\nMode: ${prd.execution_mode}`;
            text += `\nGates: ${prd.quality_gates.map((g) => g.type).join(', ') || 'none'}`;
            text += `\nStats: ${prd.stats.completed_tasks}/${prd.stats.total_tasks} completed`;
            if (prd.stats.failed_tasks > 0) text += `, ${prd.stats.failed_tasks} failed`;

            if (tasks.length > 0) {
              text += '\n\nTasks:';
              for (const t of tasks) {
                const icon =
                  t.status === 'completed'
                    ? '[+]'
                    : t.status === 'failed'
                      ? '[x]'
                      : t.status === 'in_progress'
                        ? '[~]'
                        : '[ ]';
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

        case 'run': {
          try {
            let id = prd_id;
            if (!id) {
              const latest = findLatestPrd();
              if (!latest)
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: 'No PRDs found. Create one with succ_prd(action="generate").',
                    },
                  ],
                };
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
            return {
              content: [{ type: 'text' as const, text: `Error running PRD: ${msg}` }],
              isError: true,
            };
          }
        }

        case 'export': {
          try {
            if (all) {
              const results = exportAllPrds(output);
              if (results.length === 0) {
                return { content: [{ type: 'text' as const, text: 'No PRDs found.' }] };
              }
              const lines = results.map(
                (r) => `${r.prdId}: ${r.filesCreated} files → ${r.outputDir}`
              );
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Exported ${results.length} PRDs:\n${lines.join('\n')}`,
                  },
                ],
              };
            }

            const result = exportPrdToObsidian(prd_id, output);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Exported ${result.prdId}: ${result.filesCreated} files → ${result.outputDir}\n\nGenerated:\n- Overview.md (summary + embedded dependency graph)\n- Timeline.md (Mermaid Gantt chart)\n- Dependencies.md (Mermaid flowchart DAG)\n- Tasks/*.md (per-task detail pages)`,
                },
              ],
            };
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: 'text' as const, text: `Error exporting PRD: ${msg}` }],
              isError: true,
            };
          }
        }

        default:
          return {
            content: [{ type: 'text' as const, text: `Unknown action: ${action}` }],
            isError: true,
          };
      }
    }
  );
}
