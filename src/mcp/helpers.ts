/**
 * MCP Server helper utilities
 *
 * Shared helpers used across MCP tool and resource handlers:
 * - setupGracefulShutdown: Process signal handlers
 * - trackTokenSavings: Track RAG query token savings
 * - trackMemoryAccess: Track memory access for retention decay
 * - getBrainPath: Get brain vault directory path
 * - parseRelativeDate: Parse relative date strings
 * - createToolResponse / createErrorResponse: DRY response helpers
 */

import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { closeDb, closeGlobalDb, closeStorageDispatcher, initStorageDispatcher, incrementMemoryAccessBatch, recordTokenStat, getStorageDispatcher, type TokenEventType } from '../lib/storage/index.js';
import { getProjectRoot, getSuccDir, invalidateConfigCache } from '../lib/config.js';
import { cleanupEmbeddings } from '../lib/embeddings.js';
import { cleanupQualityScoring } from '../lib/quality.js';
import { countTokens, countTokensArray } from '../lib/token-counter.js';
import { estimateSavings, getCurrentModel } from '../lib/pricing.js';
import type { SearchResult, ToolResponse } from './types.js';

// Shared Zod param for project_path — add to every tool schema
export const projectPathParam = z.string().optional()
  .describe('Project directory path. Pass cwd of your project to use project-local data instead of global.');

// Track current project to avoid redundant reinit
let _currentProject: string | null = null;

/**
 * Set the current project (called once after initStorageDispatcher at startup)
 */
export function setCurrentProject(projectPath: string) {
  _currentProject = path.resolve(projectPath);
}

/**
 * Apply project_path from tool call params.
 * If provided and different from current project, sets SUCC_PROJECT_ROOT
 * and reinitializes storage dispatcher to use the correct database.
 */
export async function applyProjectPath(projectPath?: string): Promise<void> {
  if (!projectPath) return;

  // Normalize: forward slashes to OS separators, trim whitespace
  const normalized = projectPath.trim().replace(/\//g, path.sep);
  const resolved = path.resolve(normalized);
  if (resolved === _currentProject) return;

  // Validate: must have .succ/ dir
  if (!fs.existsSync(path.join(resolved, '.succ'))) return;

  process.env.SUCC_PROJECT_ROOT = resolved;
  invalidateConfigCache();

  // Reinit storage if we already had a different project OR this is first time
  if (_currentProject !== null) {
    try { const d = await getStorageDispatcher(); await d.flushSessionCounters('mcp-project-switch'); } catch (_) { /* ignore */ }
    closeDb();
    closeGlobalDb();
    await closeStorageDispatcher();
  }

  // Always init storage dispatcher to ensure config is applied
  await initStorageDispatcher();

  _currentProject = resolved;
}

// Graceful shutdown handler
export function setupGracefulShutdown() {
  const cleanup = async () => {
    try { const d = await getStorageDispatcher(); await d.flushSessionCounters('mcp-session'); } catch (_) { /* ignore */ }
    await closeStorageDispatcher();
    cleanupEmbeddings();
    cleanupQualityScoring();
    closeDb();
    closeGlobalDb();
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  // SIGHUP only exists on Unix
  if (process.platform !== 'win32') {
    process.on('SIGHUP', cleanup);
  }
}

// Helper: Track token savings for RAG queries
export async function trackTokenSavings(
  eventType: TokenEventType,
  query: string,
  results: SearchResult[]
): Promise<void> {
  if (results.length === 0) return;

  try {
    // Count tokens in returned chunks
    const returnedTokens = countTokensArray(results.map((r) => r.content));

    // Get unique file paths
    const uniqueFiles = [...new Set(results.map((r) => r.file_path))];

    // For documents/code: read full files and count tokens
    // For memories: full_source = returned (no file to compare)
    let fullSourceTokens = returnedTokens; // default for memories

    if (eventType === 'search' || eventType === 'search_code') {
      const projectRoot = getProjectRoot();
      const succDir = getSuccDir();

      fullSourceTokens = 0;
      for (const filePath of uniqueFiles) {
        try {
          // Handle code: prefix
          const cleanPath = filePath.replace(/^code:/, '');

          // Try multiple locations: project root, brain dir
          const candidates = [
            path.join(projectRoot, cleanPath),
            path.join(succDir, 'brain', cleanPath),
            cleanPath, // absolute path
          ];

          for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
              const content = fs.readFileSync(candidate, 'utf-8');
              fullSourceTokens += countTokens(content);
              break;
            }
          }
        } catch {
          // File not readable, skip
        }
      }

      // If we couldn't read any files, use returned as estimate
      if (fullSourceTokens === 0) {
        fullSourceTokens = returnedTokens;
      }
    }

    const savingsTokens = Math.max(0, fullSourceTokens - returnedTokens);
    const model = getCurrentModel();
    const estimatedCost = estimateSavings(savingsTokens, model);

    await recordTokenStat({
      event_type: eventType,
      query,
      returned_tokens: returnedTokens,
      full_source_tokens: fullSourceTokens,
      savings_tokens: savingsTokens,
      files_count: uniqueFiles.length,
      chunks_count: results.length,
      model,
      estimated_cost: estimatedCost,
    });
  } catch {
    // Don't fail the search if tracking fails
  }
}

/**
 * Track memory access for retention decay.
 * Memories that are frequently accessed will have higher effective scores.
 *
 * @param memoryIds - Array of memory IDs that were returned
 * @param limit - The search limit (top N results)
 * @param totalResults - Total number of results before limit
 */
export async function trackMemoryAccess(
  memoryIds: number[],
  limit: number,
  totalResults: number
): Promise<void> {
  if (memoryIds.length === 0) return;

  try {
    const accesses: Array<{ memoryId: number; weight: number }> = [];

    for (let i = 0; i < memoryIds.length; i++) {
      // Top results (within limit) get full weight (1.0 = exact match)
      // Results beyond limit would get 0.5 (similarity hit) but we only track returned results
      // Weight decreases slightly by position: top result = 1.0, 2nd = 0.95, etc.
      const positionPenalty = Math.max(0, 0.05 * i);
      const weight = i < limit ? Math.max(0.5, 1.0 - positionPenalty) : 0.5;

      accesses.push({ memoryId: memoryIds[i], weight });
    }

    await incrementMemoryAccessBatch(accesses);
  } catch {
    // Don't fail the search if tracking fails
  }
}

// Get brain vault path
export function getBrainPath(): string {
  return path.join(getSuccDir(), 'brain');
}

/**
 * Parse relative date strings like "30d", "1w", "3m"
 */
export function parseRelativeDate(input: string): Date | null {
  const now = new Date();

  const match = input.match(/^(\d+)([dwmy])$/i);
  if (match) {
    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case 'd':
        return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
      case 'w':
        return new Date(now.getTime() - amount * 7 * 24 * 60 * 60 * 1000);
      case 'm':
        return new Date(now.getTime() - amount * 30 * 24 * 60 * 60 * 1000);
      case 'y':
        return new Date(now.getTime() - amount * 365 * 24 * 60 * 60 * 1000);
    }
  }

  const date = new Date(input);
  if (!isNaN(date.getTime())) {
    return date;
  }

  return null;
}

// DRY response helpers
export function createToolResponse(text: string): ToolResponse {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

export function createErrorResponse(text: string): ToolResponse {
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}
