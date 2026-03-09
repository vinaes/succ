import { describe, it, expect } from 'vitest';
import {
  parseSessionJSONL,
  classifyContent,
  analyzeSession,
  estimateTokens,
  formatAnalysisReport,
  formatCompactStats,
  type TranscriptEntry,
  type ContentBlock,
} from './session-analyzer.js';

// ── Fixtures ─────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<TranscriptEntry>): TranscriptEntry {
  return { type: 'assistant', ...overrides };
}

function makeUserEntry(text: string, position?: number): TranscriptEntry {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function makeAssistantEntry(text: string): TranscriptEntry {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function makeToolUseEntry(name: string, input: unknown, id: string): TranscriptEntry {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name, input, id }],
    },
  };
}

function makeToolResultEntry(toolUseId: string, result: string): TranscriptEntry {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result }],
    },
  };
}

function makeThinkingEntry(thinking: string): TranscriptEntry {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking },
        { type: 'text', text: 'result' },
      ],
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('divides chars by 4 and rounds up', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(100)).toBe(25);
  });
});

describe('parseSessionJSONL', () => {
  it('parses valid JSONL lines', () => {
    const content = '{"type":"user"}\n{"type":"assistant"}\n';
    const entries = parseSessionJSONL(content);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('user');
    expect(entries[1].type).toBe('assistant');
  });

  it('skips empty lines and malformed JSON', () => {
    const content = '{"type":"user"}\n\nnot-json\n{"type":"system"}\n';
    const entries = parseSessionJSONL(content);
    expect(entries).toHaveLength(2);
  });
});

describe('classifyContent', () => {
  it('classifies string content as text', () => {
    const result = classifyContent('hello world');
    expect(result.text).toBe(11);
    expect(result.total).toBe(11);
    expect(result.tool_use).toBe(0);
  });

  it('classifies null/undefined as zero', () => {
    expect(classifyContent(null).total).toBe(0);
    expect(classifyContent(undefined).total).toBe(0);
  });

  it('classifies text blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ];
    const result = classifyContent(blocks);
    expect(result.text).toBe(10);
    expect(result.total).toBe(10);
  });

  it('classifies tool_use blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', name: 'Bash', id: 'toolu_1', input: { command: 'ls -la' } },
    ];
    const result = classifyContent(blocks);
    expect(result.tool_use).toBeGreaterThan(0);
    expect(result.text).toBe(0);
  });

  it('classifies tool_result blocks with string content', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file1.ts\nfile2.ts' },
    ];
    const result = classifyContent(blocks);
    expect(result.tool_result).toBe(17);
  });

  it('classifies thinking blocks', () => {
    const blocks: ContentBlock[] = [{ type: 'thinking', thinking: 'Let me think about this...' }];
    const result = classifyContent(blocks);
    expect(result.thinking).toBe('Let me think about this...'.length);
  });

  it('classifies image blocks', () => {
    const blocks: ContentBlock[] = [{ type: 'image', source: { type: 'base64' } }];
    const result = classifyContent(blocks);
    expect(result.image).toBeGreaterThan(0);
  });

  it('classifies mixed content correctly', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'here is the answer' },
      { type: 'tool_use', name: 'Read', id: 'x', input: { file_path: '/a.ts' } },
    ];
    const result = classifyContent(blocks);
    expect(result.thinking).toBe(3);
    expect(result.text).toBe(18);
    expect(result.tool_use).toBeGreaterThan(0);
    expect(result.total).toBe(
      result.text +
        result.tool_use +
        result.thinking +
        result.tool_result +
        result.image +
        result.other
    );
  });
});

describe('analyzeSession', () => {
  it('handles empty entries', () => {
    const result = analyzeSession([]);
    expect(result.totalLines).toBe(0);
    expect(result.tokenTotals.total).toBe(0);
    expect(result.toolBreakdown).toHaveLength(0);
    expect(result.cutPoints).toHaveLength(0);
  });

  it('counts text-only conversation', () => {
    const entries = [
      makeUserEntry('What is TypeScript?'),
      makeAssistantEntry('TypeScript is a typed superset of JavaScript.'),
    ];
    const result = analyzeSession(entries);
    expect(result.totalLines).toBe(2);
    expect(result.charTotals.text).toBe(19 + 45);
    expect(result.strippablePercent).toBe(0);
  });

  it('produces cut points at user messages', () => {
    const entries = [
      makeUserEntry('First question'),
      makeAssistantEntry('First answer'),
      makeUserEntry('Second question'),
      makeAssistantEntry('Second answer'),
    ];
    const result = analyzeSession(entries);
    expect(result.cutPoints).toHaveLength(2);
    expect(result.cutPoints[0].position).toBe(0);
    expect(result.cutPoints[0].preview).toBe('First question');
    expect(result.cutPoints[1].position).toBe(2);
    expect(result.cutPoints[1].cumulativeTokens).toBeGreaterThan(
      result.cutPoints[0].cumulativeTokens
    );
  });

  it('tracks tool breakdown by name', () => {
    const entries = [
      makeUserEntry('Read a file'),
      makeToolUseEntry('Read', { file_path: '/src/app.ts' }, 'toolu_read1'),
      makeToolResultEntry('toolu_read1', 'const app = express();'),
      makeToolUseEntry('Bash', { command: 'npm test' }, 'toolu_bash1'),
      makeToolResultEntry('toolu_bash1', 'All 42 tests passed'),
    ];
    const result = analyzeSession(entries);

    expect(result.toolBreakdown.length).toBeGreaterThanOrEqual(2);
    const readTool = result.toolBreakdown.find((t) => t.name === 'Read');
    const bashTool = result.toolBreakdown.find((t) => t.name === 'Bash');
    expect(readTool).toBeDefined();
    expect(readTool!.calls).toBe(1);
    expect(readTool!.resultTokens).toBeGreaterThan(0);
    expect(bashTool).toBeDefined();
    expect(bashTool!.calls).toBe(1);
  });

  it('calculates strippable percentage', () => {
    const entries = [
      makeUserEntry('help'),
      makeThinkingEntry('Let me think carefully about this problem...'),
      makeToolUseEntry('Bash', { command: 'echo hello' }, 'toolu_1'),
      makeToolResultEntry('toolu_1', 'hello'),
    ];
    const result = analyzeSession(entries);
    expect(result.strippablePercent).toBeGreaterThan(0);
    expect(result.strippableTokens).toBeGreaterThan(0);
    // Thinking + tool_use + tool_result should all be strippable
    expect(result.tokenTotals.thinking).toBeGreaterThan(0);
    expect(result.tokenTotals.tool_use).toBeGreaterThan(0);
    expect(result.tokenTotals.tool_result).toBeGreaterThan(0);
  });

  it('sorted tool breakdown by total tokens desc', () => {
    const entries = [
      makeToolUseEntry('Read', { file_path: '/a' }, 'r1'),
      makeToolResultEntry('r1', 'x'.repeat(1000)),
      makeToolUseEntry('Bash', { command: 'ls' }, 'b1'),
      makeToolResultEntry('b1', 'small'),
    ];
    const result = analyzeSession(entries);
    expect(result.toolBreakdown[0].name).toBe('Read');
    expect(result.toolBreakdown[0].totalTokens).toBeGreaterThan(
      result.toolBreakdown[1].totalTokens
    );
  });
});

describe('formatAnalysisReport', () => {
  it('produces non-empty formatted output', () => {
    const entries = [
      makeUserEntry('hello'),
      makeAssistantEntry('hi there'),
      makeToolUseEntry('Bash', { command: 'ls' }, 'b1'),
      makeToolResultEntry('b1', 'file1 file2'),
    ];
    const analysis = analyzeSession(entries);
    const report = formatAnalysisReport(analysis, '/test/session.jsonl');

    expect(report).toContain('SESSION ANALYSIS');
    expect(report).toContain('TOKEN BREAKDOWN BY CONTENT TYPE');
    expect(report).toContain('TOKEN BREAKDOWN BY TOOL NAME');
    expect(report).toContain('CUT POINT CANDIDATES');
    expect(report).toContain('Bash');
    expect(report).toContain('/test/session.jsonl');
  });
});

describe('formatCompactStats', () => {
  it('formats before/after delta', () => {
    const before = {
      tokenTotals: {
        text: 10000,
        tool_use: 5000,
        tool_result: 25000,
        thinking: 8000,
        image: 2000,
        other: 0,
        total: 50000,
      },
      toolBreakdown: [
        { name: 'Read', calls: 10, inputTokens: 1000, resultTokens: 15000, totalTokens: 16000 },
        { name: 'Bash', calls: 5, inputTokens: 2000, resultTokens: 5000, totalTokens: 7000 },
      ],
    };
    const output = formatCompactStats(before, 10000);

    expect(output).toContain('Compact:');
    expect(output).toContain('50.0K');
    expect(output).toContain('10.0K');
    expect(output).toContain('80.0%');
    expect(output).toContain('Read: 16.0K');
    expect(output).toContain('Bash: 7.0K');
  });
});
