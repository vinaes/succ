/**
 * MCP Config tool — succ_config with actions: show, set, checkpoint_create, checkpoint_list
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { gateAction } from '../profile.js';
import { closeDb, closeStorageDispatcher } from '../../lib/storage/index.js';
import { getConfig, getSuccDir, getProjectRoot, invalidateConfigCache } from '../../lib/config.js';
import { maskSensitive } from '../../lib/config-display.js';
import {
  projectPathParam,
  applyProjectPath,
  createToolResponse,
  createErrorResponse,
} from '../helpers.js';
import { logWarn } from '../../lib/fault-logger.js';
import { getErrorMessage } from '../../lib/errors.js';
import { syncClaudeSettings } from '../../lib/undercover.js';

/**
 * Helper to normalize error, log warning, and return error response
 */
function handleErrorResponse(
  error: unknown,
  contextMessage: string,
  contextPrefix: string
): ReturnType<typeof createErrorResponse> {
  const msg = getErrorMessage(error);
  logWarn('config', contextMessage, { error: msg });
  return createErrorResponse(`${contextPrefix}${msg}`);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SENSITIVE_PATTERNS = [
  'api_key',
  'apikey',
  'secret',
  'password',
  'token',
  'connection_string',
];

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

      const gated = gateAction('succ_config', action);
      if (gated) return gated;

      switch (action) {
        case 'show': {
          try {
            const { getConfigDisplay, formatConfigDisplay } = await import('../../lib/config.js');
            const display = getConfigDisplay(true); // mask secrets

            return createToolResponse(formatConfigDisplay(display));
          } catch (error) {
            return handleErrorResponse(error, 'Error getting config', 'Error getting config: ');
          }
        }

        case 'set': {
          if (!key || !value) {
            return createErrorResponse('Both "key" and "value" are required for action="set".');
          }

          try {
            const os = await import('os');

            // Determine config path based on scope
            let configDir: string;
            let configPath: string;

            if (scope === 'project') {
              const succDir = getSuccDir();
              if (!fs.existsSync(succDir)) {
                return createErrorResponse(
                  'Project not initialized. Run `succ init` first or use scope="global".'
                );
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
              config = JSON.parse(await readFile(configPath, 'utf-8'));
            }

            // Parse value (handle booleans and numbers)
            let parsedValue: unknown = value;
            if (value === 'true') parsedValue = true;
            else if (value === 'false') parsedValue = false;
            else if (!isNaN(Number(value)) && value.trim() !== '') parsedValue = Number(value);

            // Guard against prototype pollution
            const keys = key.split('.');
            if (keys.some((k) => FORBIDDEN_KEYS.has(k))) {
              return createErrorResponse(
                `Invalid config key: "${key}" contains a reserved property name.`
              );
            }

            // Handle nested keys (e.g., "idle_reflection.enabled")
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

            // Ensure config directory exists (recursive handles existing dirs)
            await mkdir(configDir, { recursive: true });

            // Save config and invalidate cached values
            await writeFile(configPath, JSON.stringify(config, null, 2));
            invalidateConfigCache();

            // Sync Claude settings when undercover key is toggled
            if (key === 'undercover') {
              try {
                const projectRoot = getProjectRoot();
                const hasProjectMarkers = ['.git', '.claude', '.succ'].some((name) =>
                  fs.existsSync(path.join(projectRoot, name))
                );
                if (hasProjectMarkers) {
                  syncClaudeSettings(projectRoot, getConfig().undercover === true);
                } else {
                  logWarn('config', 'Skipping undercover sync: no project root detected');
                }
              } catch (syncErr: unknown) {
                logWarn('config', `Undercover settings sync failed: ${getErrorMessage(syncErr)}`);
              }
            }

            return createToolResponse(
              `Config updated (${scope}): ${key} = ${SENSITIVE_PATTERNS.some((s) => key.toLowerCase().includes(s)) ? maskSensitive(String(parsedValue)) : JSON.stringify(parsedValue)}\nSaved to: ${configPath}`
            );
          } catch (error) {
            return handleErrorResponse(error, 'Error setting config', 'Error setting config: ');
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

            const fileStat = await stat(outputPath);

            return createToolResponse(
              `Checkpoint created successfully!\n\nFile: ${outputPath}\nProject: ${cp.project_name}\nSize: ${formatSize(fileStat.size)}\n\nContents:\n  Memories: ${cp.stats.memories_count}\n  Documents: ${cp.stats.documents_count}\n  Memory links: ${cp.stats.links_count}\n  Centrality scores: ${cp.stats.centrality_count || 0}\n  Brain files: ${cp.stats.brain_files_count}\n\nTo restore: succ checkpoint restore "${outputPath}"`
            );
          } catch (error) {
            return handleErrorResponse(
              error,
              'Error creating checkpoint',
              'Error creating checkpoint: '
            );
          } finally {
            closeDb();
            await closeStorageDispatcher();
          }
        }

        case 'checkpoint_list': {
          try {
            const { listCheckpoints, formatSize } = await import('../../lib/checkpoint.js');

            const checkpoints = listCheckpoints();

            if (checkpoints.length === 0) {
              return createToolResponse(
                'No checkpoints found. Create one with: succ_config action="checkpoint_create"'
              );
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

            return createToolResponse(lines.join('\n'));
          } catch (error) {
            return handleErrorResponse(
              error,
              'Error listing checkpoints',
              'Error listing checkpoints: '
            );
          } finally {
            closeDb();
          }
        }

        default:
          return createErrorResponse(
            `Unknown action: "${action}". Valid actions: show, set, checkpoint_create, checkpoint_list`
          );
      }
    }
  );
}
