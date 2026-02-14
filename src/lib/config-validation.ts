/**
 * Config validation (Zod) and deep merge utility.
 *
 * Validates critical config sections at load time.
 * Unknown keys are preserved (passthrough) for forward compatibility.
 */

import { z } from 'zod';
import { logWarn } from './fault-logger.js';

// ---------- Deep merge ----------

/**
 * Recursively merge `source` into `target`.
 * - Objects are merged recursively (not replaced)
 * - Arrays and primitives from `source` override `target`
 * - `undefined` values in source are skipped
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>
): T {
  const result = { ...target } as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];

    if (srcVal === undefined) continue;

    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }

  return result as T;
}

// ---------- Zod schemas for critical sections ----------

const StorageSchema = z
  .object({
    backend: z.enum(['sqlite', 'postgresql']).optional(),
    vector: z.enum(['builtin', 'qdrant']).optional(),
    sqlite: z
      .object({
        path: z.string().optional(),
        global_path: z.string().optional(),
        wal_mode: z.boolean().optional(),
        busy_timeout: z.number().positive().optional(),
      })
      .passthrough()
      .optional(),
    postgresql: z
      .object({
        connection_string: z.string().optional(),
        host: z.string().optional(),
        port: z.number().int().positive().optional(),
        database: z.string().optional(),
        user: z.string().optional(),
        password: z.string().optional(),
        ssl: z.boolean().optional(),
        pool_size: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    qdrant: z
      .object({
        url: z.string().url().optional(),
        api_key: z.string().optional(),
        collection_prefix: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .optional();

const LLMSchema = z
  .object({
    api_key: z.string().optional(),
    api_url: z.string().optional(),
    type: z.enum(['claude', 'api']).optional(),
    model: z.string().optional(),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    transport: z.enum(['process', 'ws', 'http']).optional(),
  })
  .passthrough()
  .optional();

const ErrorReportingSchema = z
  .object({
    enabled: z.boolean().optional(),
    level: z.enum(['error', 'warn', 'info', 'debug']).optional(),
    max_file_size_mb: z.number().positive().optional(),
    webhook_url: z.string().optional(),
    webhook_headers: z.record(z.string()).optional(),
    sentry_dsn: z.string().optional(),
    sentry_environment: z.string().optional(),
    sentry_sample_rate: z.number().min(0).max(1).optional(),
  })
  .passthrough()
  .optional();

const RetrievalSchema = z
  .object({
    bm25_alpha: z.number().min(0).max(1).optional(),
    default_top_k: z.number().int().positive().optional(),
    quality_boost_weight: z.number().min(0).max(1).optional(),
    mmr_lambda: z.number().min(0).max(1).optional(),
  })
  .passthrough()
  .optional();

/** Top-level config schema — validates critical sections, passes through the rest. */
const SuccConfigSchema = z
  .object({
    chunk_size: z.number().int().positive().optional(),
    chunk_overlap: z.number().int().nonnegative().optional(),
    storage: StorageSchema,
    llm: LLMSchema,
    error_reporting: ErrorReportingSchema,
    retrieval: RetrievalSchema,
  })
  .passthrough();

/**
 * Validate a parsed config object. Logs warnings for invalid fields but
 * never throws — returns the (possibly corrected) config.
 */
export function validateConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const result = SuccConfigSchema.safeParse(raw);

  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      logWarn('config', `Invalid config value at "${path}": ${issue.message}`);
    }
    // Return raw config as-is — don't break on validation failure
    return raw;
  }

  return result.data;
}
