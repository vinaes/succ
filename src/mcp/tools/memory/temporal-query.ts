import { TEMPORAL_SUBQUERY_SYSTEM } from '../../../prompts/index.js';
import { logWarn } from '../../../lib/fault-logger.js';
import { getErrorMessage } from '../../../lib/errors.js';

export function extractTemporalSubqueries(query: string): string[] {
  // EN: "between X and Y" / RU: "между X и Y"
  const betweenMatch = query.match(/(?:between|между)\s+(.+?)\s+(?:and|и)\s+(.+?)(?:\?|$)/i);
  if (betweenMatch) {
    return [betweenMatch[1].trim(), betweenMatch[2].trim()];
  }

  // EN: "from X to Y" / RU: "от X до Y" / "с X до Y" / "с X по Y"
  const fromToMatch = query.match(/(?:from|от|с)\s+(.+?)\s+(?:to|до|по)\s+(.+?)(?:\?|$)/i);
  if (fromToMatch) {
    return [fromToMatch[1].trim(), fromToMatch[2].trim()];
  }

  // EN: "after X ... before Y" / "since X ... until Y"
  // RU: "после X ... до Y" / "с тех пор как X ... до Y"
  const afterBeforeMatch = query.match(
    /(?:after|since|после|с тех пор как)\s+(.+?)\s+(?:and|but|и|но)?\s*(?:before|until|до|перед)\s+(.+?)(?:\?|$)/i
  );
  if (afterBeforeMatch) {
    return [afterBeforeMatch[1].trim(), afterBeforeMatch[2].trim()];
  }

  // EN: "first time X ... last time Y"
  // RU: "первый раз X ... последний раз Y" / "впервые X ... в последний раз Y"
  const firstLastMatch = query.match(
    /(?:first\s+(?:time\s+)?|впервые\s+|в первый раз\s+)(.+?)\s+(?:and|,|и)\s*(?:last\s+(?:time\s+)?|в последний раз\s+|последний раз\s+)(.+?)(?:\?|$)/i
  );
  if (firstLastMatch) {
    return [firstLastMatch[1].trim(), firstLastMatch[2].trim()];
  }

  // No decomposition pattern matched — return original
  return [query];
}

/**
 * Async version with LLM fallback for languages not covered by regex.
 * Fast path: regex (sync, 0ms). Slow path: LLM decomposition (any language).
 * Only invokes LLM when query contains non-Latin/Cyrillic characters (likely unsupported language).
 */
export async function extractTemporalSubqueriesAsync(query: string): Promise<string[]> {
  // Fast path: regex handles EN + RU
  const regexResult = extractTemporalSubqueries(query);
  if (regexResult.length > 1) return regexResult;

  // Only invoke LLM if the query contains characters outside Latin/Cyrillic scripts
  // This avoids unnecessary LLM calls for EN/RU queries that simply have no temporal range
  const hasNonLatinCyrillic = /[^\u0020-\u024F\u0400-\u04FF\s\d\p{P}]/u.test(query);
  if (!hasNonLatinCyrillic) return [query];

  // Slow path: LLM decomposition for other languages (CJK, Arabic, etc.)
  try {
    const { callLLMChat } = await import('../../../lib/llm.js');
    const result = await callLLMChat(
      [
        {
          role: 'system',
          content: TEMPORAL_SUBQUERY_SYSTEM,
        },
        { role: 'user', content: query },
      ],
      { maxTokens: 200 }
    );
    const parsed = JSON.parse(result.trim());
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((s: unknown) => typeof s === 'string')
    ) {
      return parsed;
    }
  } catch (error) {
    logWarn('mcp-memory', 'Temporal query LLM decomposition failed', {
      error: getErrorMessage(error),
    });
  }

  return [query];
}
