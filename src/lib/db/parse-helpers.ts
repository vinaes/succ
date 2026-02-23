/**
 * Shared SQLite row parsing helpers.
 *
 * Used by memories.ts, global-memories.ts, retention.ts, hybrid-search.ts
 * to parse raw SQLite column values into typed objects at the DB boundary.
 */

import { MEMORY_TYPES, type MemoryType } from './schema.js';
import { logWarn } from '../fault-logger.js';

/** Parse JSON tags column, returning empty array on null/invalid. */
export function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (error) {
    logWarn('db', 'Failed to parse memory tags JSON', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** Parse JSON quality_factors column, returning null on null/invalid. */
export function parseQualityFactors(raw: string | null): Record<string, number> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const factors: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number') {
        factors[key] = value;
      }
    }
    return factors;
  } catch (error) {
    logWarn('db', 'Failed to parse quality_factors JSON', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Validate and cast raw string to MemoryType, returning null on null/undefined/invalid. */
export function parseMemoryType(raw: string | null | undefined): MemoryType | null {
  if (!raw) return null;
  if ((MEMORY_TYPES as readonly string[]).includes(raw)) return raw as MemoryType;
  logWarn('db', `Unknown memory type: "${raw}", returning null`);
  return null;
}
