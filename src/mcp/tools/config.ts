/**
 * MCP Config tools
 *
 * - succ_config: Show current configuration
 * - succ_config_set: Update configuration values
 * - succ_checkpoint: Create and manage checkpoints
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { closeDb } from '../../lib/storage/index.js';
import { getSuccDir } from '../../lib/config.js';
import { projectPathParam, applyProjectPath } from '../helpers.js';

export function registerConfigTools(server: McpServer) {
  // Tool: succ_config - Show current configuration
  server.tool(
    'succ_config',
    'Get the current succ configuration with all settings and their effective values (with defaults applied). Shows embedding mode, analyze mode, quality scoring, graph settings, idle reflection, etc.',
    {
      project_path: projectPathParam,
    },
    async ({ project_path }) => {
      await applyProjectPath(project_path);
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
  );

  // Tool: succ_config_set - Update configuration values
  server.tool(
    'succ_config_set',
    'Update succ configuration values. Saves to global (~/.succ/config.json) or project (.succ/config.json). Common keys: embedding_mode (local/openrouter/custom), analyze_mode (claude/local/openrouter), openrouter_api_key, embedding_api_url, analyze_api_url, analyze_model, quality_scoring_enabled, sensitive_filter_enabled, graph_auto_link, idle_reflection.enabled, idle_watcher.enabled',
    {
      key: z.string().describe('Config key to set (e.g., "embedding_mode", "analyze_model", "idle_reflection.enabled")'),
      value: z.string().describe('Value to set (strings, numbers, booleans as strings: "true"/"false")'),
      scope: z.enum(['global', 'project']).optional().default('global').describe('Where to save: "global" (~/.succ/config.json) or "project" (.succ/config.json). Default: global'),
      project_path: projectPathParam,
    },
    async ({ key, value, scope, project_path }) => {
      await applyProjectPath(project_path);
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
  );

  // Tool: succ_checkpoint - Create and manage checkpoints (full backup/restore)
  server.tool(
    'succ_checkpoint',
    'Create or list checkpoints (full backup of memories, documents, brain vault). Use "create" to make a backup, "list" to see available checkpoints. Note: Restore requires CLI (succ checkpoint restore <file>).',
    {
      action: z.enum(['create', 'list']).describe('Action: create (new checkpoint) or list (show available)'),
      compress: z.boolean().optional().describe('Compress with gzip (default: false)'),
      include_brain: z.boolean().optional().describe('Include brain vault files (default: true)'),
      include_documents: z.boolean().optional().describe('Include indexed documents (default: true)'),
      project_path: projectPathParam,
    },
    async ({ action, compress, include_brain, include_documents, project_path }) => {
      await applyProjectPath(project_path);
      try {
        const {
          createCheckpoint,
          listCheckpoints,
          formatSize,
        } = await import('../../lib/checkpoint.js');

        if (action === 'create') {
          const { checkpoint: cp, outputPath } = await createCheckpoint({
            includeBrain: include_brain ?? true,
            includeDocuments: include_documents ?? true,
            includeConfig: true,
            compress: compress ?? false,
          });

          const stat = fs.statSync(outputPath);

          return {
            content: [{
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
            }],
          };
        } else {
          // list
          const checkpoints = listCheckpoints();

          if (checkpoints.length === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: 'No checkpoints found. Create one with: succ_checkpoint action="create"',
              }],
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
            content: [{
              type: 'text' as const,
              text: lines.join('\n'),
            }],
          };
        }
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${error.message}`,
          }],
          isError: true,
        };
      } finally {
        closeDb();
      }
    }
  );
}
