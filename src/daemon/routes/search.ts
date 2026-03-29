import {
  getMemoriesByTag,
  getPinnedMemories,
  getRecentMemories,
  hybridSearchCode,
  hybridSearchDocs,
  hybridSearchMemories,
  incrementMemoryAccessBatch,
  setMemoryInvariant,
} from '../../lib/storage/index.js';
import { getEmbedding } from '../../lib/embeddings.js';
import { matchRules } from '../../lib/hook-rules.js';
import { getRetrievalConfig } from '../../lib/config.js';
import { classifyQuery } from '../../lib/db/hybrid-search.js';
import type { Memory } from '../../lib/storage/types.js';
import {
  EmptyBodySchema,
  HookRulesSchema,
  parseRequestBody,
  RecallBodySchema,
  RecallByTagSchema,
  SearchBodySchema,
  type RouteContext,
  type RouteMap,
} from './types.js';

const HOOK_RULES_CACHE_TTL = 60_000; // 60s

let hookRulesCache: { memories: Memory[]; timestamp: number } | null = null;

export function resetSearchRoutesState(): void {
  hookRulesCache = null;
}

export function invalidateHookRulesCache(): void {
  hookRulesCache = null;
}

export function searchRoutes(_ctx: RouteContext): RouteMap {
  return {
    'POST /api/search': async (body) => {
      const {
        query,
        limit = 5,
        threshold = 0.3,
      } = parseRequestBody(SearchBodySchema, body, 'query required');
      const queryEmbedding = await getEmbedding(query);
      const rc = getRetrievalConfig();
      const alpha = rc.adaptive_alpha ? classifyQuery(query).alpha : rc.bm25_alpha;
      const results = await hybridSearchDocs(query, queryEmbedding, limit, threshold, alpha);

      const accesses = results.flatMap((result) => {
        if (!result || typeof result !== 'object' || !('memory_id' in result)) {
          return [];
        }
        const memoryId = (result as { memory_id?: unknown }).memory_id;
        return typeof memoryId === 'number' ? [{ memoryId, weight: 0.5 }] : [];
      });
      if (accesses.length > 0) {
        await incrementMemoryAccessBatch(accesses);
      }

      return { results };
    },

    'POST /api/search-code': async (body) => {
      const {
        query,
        limit = 5,
        threshold = 0.3,
      } = parseRequestBody(SearchBodySchema, body, 'query required');
      const queryEmbedding = await getEmbedding(query);
      const rc = getRetrievalConfig();
      const alpha = rc.adaptive_alpha ? classifyQuery(query).alpha : rc.bm25_alpha;
      const results = await hybridSearchCode(query, queryEmbedding, limit, threshold, alpha);
      return { results };
    },

    'POST /api/recall': async (body) => {
      const { query, limit = 5 } = parseRequestBody(RecallBodySchema, body);

      if (!query) {
        const memories = await getRecentMemories(limit);
        return { results: memories };
      }

      const queryEmbedding = await getEmbedding(query);
      const rc = getRetrievalConfig();
      const alpha = rc.adaptive_alpha ? classifyQuery(query).alpha : rc.bm25_alpha;
      const results = await hybridSearchMemories(query, queryEmbedding, limit, 0.3, alpha);

      const accesses = results.flatMap((result) => {
        if (!result || typeof result !== 'object' || !('id' in result)) {
          return [];
        }
        const memoryId = (result as { id?: unknown }).id;
        return typeof memoryId === 'number' ? [{ memoryId, weight: 1.0 }] : [];
      });
      if (accesses.length > 0) {
        await incrementMemoryAccessBatch(accesses);
      }

      return { results };
    },

    'GET /api/pinned': async () => {
      const pinned = await getPinnedMemories();
      return { results: pinned };
    },

    'POST /api/pinned/cleanup': async (body) => {
      parseRequestBody(EmptyBodySchema, body);

      const pinned = await getPinnedMemories();
      let cleaned = 0;
      for (const mem of pinned) {
        if (mem.type === 'observation' && mem.is_invariant) {
          await setMemoryInvariant(mem.id, false);
          cleaned++;
        }
      }
      return { cleaned, total: pinned.length };
    },

    'POST /api/recall-by-tag': async (body) => {
      const { tag, limit = 5 } = parseRequestBody(RecallByTagSchema, body, 'tag required');
      const results = await getMemoriesByTag(tag, limit);
      return { results };
    },

    'POST /api/hook-rules': async (body) => {
      const { tool_name, tool_input: rawInput } = parseRequestBody(
        HookRulesSchema,
        body,
        'tool_name required'
      );
      const tool_input =
        rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
          ? (rawInput as Record<string, unknown>)
          : {};

      const now = Date.now();
      if (!hookRulesCache || now - hookRulesCache.timestamp > HOOK_RULES_CACHE_TTL) {
        const memories = await getMemoriesByTag('hook-rule', 50);
        hookRulesCache = { memories, timestamp: now };
      }

      const rules = matchRules(hookRulesCache.memories, tool_name, tool_input);
      return { rules };
    },
  };
}
