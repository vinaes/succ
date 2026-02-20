/**
 * MCP Config tool — succ_config with actions: show, set, checkpoint_create, checkpoint_list
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { closeDb } from '../../lib/storage/index.js';
import { getSuccDir } from '../../lib/config.js';
import { projectPathParam, applyProjectPath } from '../helpers.js';

export function registerConfigTools(server: McpServer) {
  server.registerTool(
    'succ_config',
    {
      description:
        'View or update succ configuration, or manage checkpoints (backups).\n\nExamples:\n- Show config: succ_config()\n- Set value: succ_config(action="set", key="llm.api_key", value="sk-...")\n- Create backup: succ_config(action="checkpoint_create", compress=true)\n- List backups: succ_config(action="checkpoint_list")',
      inputSchema: {
        action: z
          .enum(['show', 'set', 'checkpoint_create', 'checkpoint_list'])
          .optional()
          .default('show')
          .describe(
            'show = display config, set = update value, checkpoint_create = backup, checkpoint_list = list backups'
          ),
        key: z
          .string()
          .optional()
          .describe(
            'Config key to set (e.g., "llm.api_key", "llm.embeddings.mode", "idle_reflection.enabled")'
          ),
        value: z
          .string()
          .optional()
          .describe('Value to set (strings, numbers, booleans as strings: "true"/"false")'),
        scope: z
          .enum(['global', 'project'])
          .optional()
          .default('global')
          .describe(
            'Where to save: "global" (~/.succ/config.json) or "project" (.succ/config.json). Default: global'
          ),
        compress: z.boolean().optional().describe('Compress with gzip (default: false)'),
        include_brain: z.boolean().optional().describe('Include brain vault files (default: true)'),
        include_documents: z
          .boolean()
          .optional()
          .describe('Include indexed documents (default: true)'),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      action,
      key,
      value,
      scope,
      compress,
      include_brain,
      include_documents,
      project_path,
    }) => {
      await applyProjectPath(project_path);

      switch (action) {
        case 'show': {
          try {
            const { getConfigDisplay, formatConfigDisplay } = await import('../../lib/config.js');
            const display = getConfigDisplay(true); // mask secrets

            return {
              content: [
                {
                  type: 'text' as const,
                  text: formatConfigDisplay(display),
                },
              ],
            };
          } catch (error: any) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error getting config: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'set': {
          if (!key || !value) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Both "key" and "value" are required for action="set".',
                },
              ],
              isError: true,
            };
          }

          try {
            const os = await import('os');

            // Determine config path based on scope
            let configDir: string;
            let configPath: string;

            if (scope === 'project') {
              const succDir = getSuccDir();
              if (!fs.existsSync(succDir)) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: 'Project not initialized. Run `succ init` first or use scope="global".',
                    },
                  ],
                  isError: true,
                };
              }
              configDir = succDir;
              configPath = path.join(succDir, 'config.json');
            } else {
              configDir = path.join(os.homedir(), '.succ');
              configPath = path.join(configDir, 'config.json');
            }

            // Load existing config
            let config: Record<string, unknown> = {};
            if (fs.existsSync(configPath)) {
              config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            }

            // Parse value (handle booleans and numbers)
            let parsedValue: unknown = value;
            if (value === 'true') parsedValue = true;
            else if (value === 'false') parsedValue = false;
            else if (!isNaN(Number(value)) && value.trim() !== '') parsedValue = Number(value);

            // Handle nested keys (e.g., "idle_reflection.enabled")
            const keys = key.split('.');
            if (keys.length === 1) {
              config[key] = parsedValue;
            } else {
              // Navigate/create nested object
              let current: Record<string, unknown> = config;
              for (let i = 0; i < keys.length - 1; i++) {
                if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
                  current[keys[i]] = {};
                }
                current = current[keys[i]] as Record<string, unknown>;
              }
              current[keys[keys.length - 1]] = parsedValue;
            }

            // Ensure config directory exists
            if (!fs.existsSync(configDir)) {
              fs.mkdirSync(configDir, { recursive: true });
            }

            // Save config
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Config updated (${scope}): ${key} = ${JSON.stringify(parsedValue)}\nSaved to: ${configPath}`,
                },
              ],
            };
          } catch (error: any) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error setting config: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'checkpoint_create': {
          try {
            const { createCheckpoint, formatSize } = await import('../../lib/checkpoint.js');

            const { checkpoint: cp, outputPath } = await createCheckpoint({
              includeBrain: include_brain ?? true,
              includeDocuments: include_documents ?? true,
              includeConfig: true,
              compress: compress ?? false,
            });

            const stat = fs.statSync(outputPath);

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Checkpoint created successfully!

File: ${outputPath}
Project: ${cp.project_name}
Size: ${formatSize(stat.size)}

Contents:
  Memories: ${cp.stats.memories_count}
  Documents: ${cp.stats.documents_count}
  Memory links: ${cp.stats.links_count}
  Centrality scores: ${cp.stats.centrality_count || 0}
  Brain files: ${cp.stats.brain_files_count}

To restore: succ checkpoint restore "${outputPath}"`,
                },
              ],
            };
          } catch (error: any) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error: ${error.message}`,
                },
              ],
              isError: true,
            };
          } finally {
            closeDb();
          }
        }

        case 'checkpoint_list': {
          try {
            const { listCheckpoints, formatSize } = await import('../../lib/checkpoint.js');

            const checkpoints = listCheckpoints();

            if (checkpoints.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'No checkpoints found. Create one with: succ_config action="checkpoint_create"',
                  },
                ],
              };
            }

            const lines = ['Available checkpoints:\n'];
            for (const cp of checkpoints) {
              const compressed = cp.compressed ? ' (compressed)' : '';
              const date = cp.created_at ? new Date(cp.created_at).toLocaleString() : 'unknown';
              lines.push(`  ${cp.name}${compressed}`);
              lines.push(`    Created: ${date}`);
              lines.push(`    Size: ${formatSize(cp.size)}`);
              lines.push('');
            }
            lines.push(`Total: ${checkpoints.length} checkpoint(s)`);

            return {
              content: [
                {
                  type: 'text' as const,
                  text: lines.join('\n'),
                },
              ],
            };
          } catch (error: any) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error: ${error.message}`,
                },
              ],
              isError: true,
            };
          } finally {
            closeDb();
          }
        }

        default:
          return {
            content: [
              {
                type: 'text' as const,
                text: `Unknown action: "${action}". Valid actions: show, set, checkpoint_create, checkpoint_list`,
              },
            ],
            isError: true,
          };
      }
    }
  );
}
