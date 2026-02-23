import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/llm.js', () => ({
  callLLMChat: vi.fn(async () => '["first event", "second event"]'),
}));

import { callLLMChat } from '../../../lib/llm.js';
import { extractTemporalSubqueries, extractTemporalSubqueriesAsync } from './temporal-query.js';

describe('temporal-query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts english between-pattern subqueries', () => {
    const result = extractTemporalSubqueries(
      'How many days between starting project X and deploying project X?'
    );

    expect(result).toEqual(['starting project X', 'deploying project X']);
  });

  it('returns original query when no pattern matches', () => {
    const query = 'What did we learn from release retro?';
    expect(extractTemporalSubqueries(query)).toEqual([query]);
  });

  it('uses LLM fallback for non-latin/cyrillic query', async () => {
    const result = await extractTemporalSubqueriesAsync('開始からデプロイまで何日でしたか？');

    expect(callLLMChat).toHaveBeenCalledTimes(1);
    expect(result).toEqual(['first event', 'second event']);
  });
});
