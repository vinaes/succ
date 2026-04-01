import { ValidationError } from '../../lib/errors.js';
import { getEmbedding } from '../../lib/embeddings.js';
import { getConfig } from '../../lib/config.js';
import { scoreMemory, passesQualityThreshold } from '../../lib/quality.js';
import { scanSensitive } from '../../lib/sensitive-filter.js';
import { saveGlobalMemory, saveMemory } from '../../lib/storage/index.js';
import { invalidateHookRulesCache } from './search.js';
import {
  parseRequestBody,
  RememberBodySchema,
  type RememberInFlightResult,
  type RouteContext,
  type RouteMap,
} from './types.js';

const REMEMBER_DEDUP_TTL_MS = 5000;

const rememberInFlight = new Map<string, Promise<RememberInFlightResult>>();

export function resetMemoryRoutesState(): void {
  rememberInFlight.clear();
}

export function memoryRoutes(_ctx: RouteContext): RouteMap {
  return {
    'POST /api/remember': async (body) => {
      const {
        content,
        tags = [],
        type = 'observation',
        source,
        global = false,
        valid_from,
        valid_until,
        source_context,
      } = parseRequestBody(RememberBodySchema, body, 'content required');

      const contentHash = content.slice(0, 200) + '|' + (tags || []).join(',');
      const existing = rememberInFlight.get(contentHash);
      if (existing) {
        const result = await existing;
        return { success: false, id: result.id, isDuplicate: true, reason: 'in-flight dedup' };
      }

      const processRemember = async (): Promise<RememberInFlightResult> => {
        const config = getConfig();
        let finalContent = content;
        let finalSourceContext = source_context;
        if (config.sensitive_filter_enabled !== false) {
          const scanResult = scanSensitive(content);
          if (scanResult.hasSensitive) {
            if (config.sensitive_auto_redact) {
              finalContent = scanResult.redactedText;
            } else {
              throw new ValidationError('Content contains sensitive information');
            }
          }
          // Scan source_context for sensitive info with same policy
          if (finalSourceContext) {
            const ctxScan = scanSensitive(finalSourceContext);
            if (ctxScan.hasSensitive) {
              if (config.sensitive_auto_redact) {
                finalSourceContext = ctxScan.redactedText;
              } else {
                throw new ValidationError('source_context contains sensitive information');
              }
            }
          }
        }

        const embedding = await getEmbedding(finalContent);
        const qualityResult = await scoreMemory(finalContent);
        if (!passesQualityThreshold(qualityResult)) {
          return { success: false, reason: 'Below quality threshold', score: qualityResult.score };
        }

        let result;
        if (global) {
          result = await saveGlobalMemory(finalContent, embedding, tags, type, {
            sourceContext: finalSourceContext,
          });
        } else {
          result = await saveMemory(finalContent, embedding, tags, source ?? type, {
            qualityScore: { score: qualityResult.score, factors: qualityResult.factors },
            validFrom: valid_from,
            validUntil: valid_until,
            sourceContext: finalSourceContext,
          });
        }

        if (Array.isArray(tags) && tags.includes('hook-rule')) {
          invalidateHookRulesCache();
        }

        return { success: !result.isDuplicate, id: result.id, isDuplicate: result.isDuplicate };
      };

      const promise = processRemember();
      rememberInFlight.set(contentHash, promise);
      setTimeout(() => rememberInFlight.delete(contentHash), REMEMBER_DEDUP_TTL_MS);

      try {
        return await promise;
      } finally {
        rememberInFlight.delete(contentHash);
      }
    },
  };
}
