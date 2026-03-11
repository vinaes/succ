import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  trimToolContent,
  trimThinking,
  trimAll,
  compactBefore,
  extractDialogue,
} from './session-surgeon.js';
import type { TranscriptEntry } from './session-analyzer.js';

// ── Test helpers ─────────────────────────────────────────────────────

let testDir: string;
let testFile: string;

beforeEach(() => {
  testDir = tmpdir();
  testFile = join(testDir, `succ-test-${randomUUID()}.jsonl`);
});

afterEach(async () => {
  try {
    await unlink(testFile);
  } catch {
    /* ok */
  }
  try {
    await unlink(testFile + '.bak');
  } catch {
    /* ok */
  }
});

function makeJSONL(entries: Record<string, unknown>[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function entry(
  uuid: string,
  parentUuid: string | null,
  type: string,
  content: unknown[]
): Record<string, unknown> {
  return {
    uuid,
    parentUuid,
    type,
    message: { role: type === 'user' ? 'user' : 'assistant', content },
  };
}

// ── trimToolContent ──────────────────────────────────────────────────

describe('trimToolContent', () => {
  it('trims tool_use inputs and tool_result content', async () => {
    const jsonl = makeJSONL([
      entry('u1', null, 'user', [{ type: 'text', text: 'Read a file' }]),
      entry('a1', 'u1', 'assistant', [
        { type: 'tool_use', name: 'Read', id: 'toolu_1', input: { file_path: '/src/big-file.ts' } },
      ]),
      entry('u2', 'a1', 'user', [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(500) },
      ]),
    ]);
    await writeFile(testFile, jsonl);

    const result = await trimToolContent(testFile, { noBackup: true });
    expect(result.entriesModified).toBe(2);
    expect(result.charsRemoved).toBeGreaterThan(400);
    expect(result.tokensFreed).toBeGreaterThan(0);

    // Verify file was modified
    const modified = await readFile(testFile, 'utf-8');
    expect(modified).toContain('[trimmed by succ]');
    expect(modified).not.toContain('x'.repeat(500));
  });

  it('respects --tools filter', async () => {
    const jsonl = makeJSONL([
      entry('a1', null, 'assistant', [
        { type: 'tool_use', name: 'Read', id: 'r1', input: { file_path: '/a.ts' } },
      ]),
      entry('u1', 'a1', 'user', [
        { type: 'tool_result', tool_use_id: 'r1', content: 'read-result' },
      ]),
      entry('a2', 'u1', 'assistant', [
        { type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'ls' } },
      ]),
      entry('u2', 'a2', 'user', [
        { type: 'tool_result', tool_use_id: 'b1', content: 'bash-result' },
      ]),
    ]);
    await writeFile(testFile, jsonl);

    await trimToolContent(testFile, { tools: ['Bash'], noBackup: true });

    const modified = await readFile(testFile, 'utf-8');
    // Read results should be untouched
    expect(modified).toContain('read-result');
    // Bash results should be trimmed
    expect(modified).not.toContain('bash-result');
  });

  it('respects --only-inputs', async () => {
    const jsonl = makeJSONL([
      entry('a1', null, 'assistant', [
        { type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'npm test' } },
      ]),
      entry('u1', 'a1', 'user', [
        { type: 'tool_result', tool_use_id: 'b1', content: 'All tests passed' },
      ]),
    ]);
    await writeFile(testFile, jsonl);

    await trimToolContent(testFile, { onlyInputs: true, noBackup: true });

    const modified = await readFile(testFile, 'utf-8');
    // Results should be preserved
    expect(modified).toContain('All tests passed');
    // Inputs should be cleared
    expect(modified).not.toContain('npm test');
  });

  it('respects --only-results', async () => {
    const jsonl = makeJSONL([
      entry('a1', null, 'assistant', [
        { type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'npm test' } },
      ]),
      entry('u1', 'a1', 'user', [
        { type: 'tool_result', tool_use_id: 'b1', content: 'All tests passed' },
      ]),
    ]);
    await writeFile(testFile, jsonl);

    await trimToolContent(testFile, { onlyResults: true, noBackup: true });

    const modified = await readFile(testFile, 'utf-8');
    // Inputs should be preserved
    expect(modified).toContain('npm test');
    // Results should be trimmed
    expect(modified).not.toContain('All tests passed');
  });

  it('respects --keep-last-lines', async () => {
    const resultContent = 'line1\nline2\nline3\nERROR: something broke\nstack trace here';
    const jsonl = makeJSONL([
      entry('a1', null, 'assistant', [
        { type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'test' } },
      ]),
      entry('u1', 'a1', 'user', [
        { type: 'tool_result', tool_use_id: 'b1', content: resultContent },
      ]),
    ]);
    await writeFile(testFile, jsonl);

    await trimToolContent(testFile, { keepLastLines: 2, noBackup: true });

    const modified = await readFile(testFile, 'utf-8');
    expect(modified).toContain('ERROR: something broke');
    expect(modified).toContain('stack trace here');
    expect(modified).not.toContain('line1');
  });

  it('dry run does not modify file', async () => {
    const jsonl = makeJSONL([
      entry('a1', null, 'assistant', [
        { type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'ls' } },
      ]),
      entry('u1', 'a1', 'user', [{ type: 'tool_result', tool_use_id: 'b1', content: 'output' }]),
    ]);
    await writeFile(testFile, jsonl);

    const result = await trimToolContent(testFile, { dryRun: true });
    expect(result.charsRemoved).toBeGreaterThan(0);

    const unchanged = await readFile(testFile, 'utf-8');
    expect(unchanged).toContain('output');
  });

  it('creates backup by default', async () => {
    const jsonl = makeJSONL([
      entry('a1', null, 'assistant', [
        { type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'ls' } },
      ]),
    ]);
    await writeFile(testFile, jsonl);

    const result = await trimToolContent(testFile);
    expect(result.backupPath).toBe(testFile + '.bak');

    const backup = await readFile(testFile + '.bak', 'utf-8');
    expect(backup).toContain('"command":"ls"');
  });
});

// ── trimThinking ─────────────────────────────────────────────────────

describe('trimThinking', () => {
  it('trims thinking blocks', async () => {
    const jsonl = makeJSONL([
      entry('a1', null, 'assistant', [
        { type: 'thinking', thinking: 'Let me think carefully about this problem...' },
        { type: 'text', text: 'Here is my answer.' },
      ]),
    ]);
    await writeFile(testFile, jsonl);

    const result = await trimThinking(testFile, { noBackup: true });
    expect(result.entriesModified).toBe(1);
    // charsRemoved = original length - replacement ('[trimmed by succ]') length
    expect(result.charsRemoved).toBe(
      'Let me think carefully about this problem...'.length - '[trimmed by succ]'.length
    );

    const modified = await readFile(testFile, 'utf-8');
    expect(modified).toContain('[trimmed by succ]');
    expect(modified).toContain('Here is my answer.');
    expect(modified).not.toContain('Let me think carefully');
  });
});

// ── trimAll ──────────────────────────────────────────────────────────

describe('trimAll', () => {
  it('trims tool content, thinking, and images', async () => {
    const jsonl = makeJSONL([
      entry('u1', null, 'user', [{ type: 'text', text: 'Do everything' }]),
      entry('a1', 'u1', 'assistant', [
        { type: 'thinking', thinking: 'Processing...' },
        { type: 'text', text: 'Sure!' },
        { type: 'tool_use', name: 'Read', id: 'r1', input: { file_path: '/x.ts' } },
      ]),
      entry('u2', 'a1', 'user', [
        { type: 'tool_result', tool_use_id: 'r1', content: 'const x = 1;' },
      ]),
      entry('a2', 'u2', 'assistant', [
        { type: 'image', source: { type: 'base64', data: 'AAAA'.repeat(100) } },
        { type: 'text', text: 'Here is the screenshot.' },
      ]),
    ]);
    await writeFile(testFile, jsonl);

    const result = await trimAll(testFile, { noBackup: true });
    expect(result.entriesModified).toBe(3); // a1, u2, a2

    const modified = await readFile(testFile, 'utf-8');
    // Text should survive
    expect(modified).toContain('Do everything');
    expect(modified).toContain('Sure!');
    expect(modified).toContain('Here is the screenshot.');
    // Everything else should be trimmed
    expect(modified).not.toContain('Processing...');
    expect(modified).not.toContain('const x = 1');
    expect(modified).not.toContain('AAAA');
  });
});

// ── extractDialogue ──────────────────────────────────────────────────

describe('extractDialogue', () => {
  it('extracts user/assistant text, skips tools and commands', () => {
    const entries: TranscriptEntry[] = [
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'What is TypeScript?' }] },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'It is a typed superset of JS.' }],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', id: 'b1', input: {} }],
        },
      },
      { type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Thanks!' }] } },
    ];

    const result = extractDialogue(entries);
    expect(result).toContain('User: What is TypeScript?');
    expect(result).toContain('Assistant: It is a typed superset of JS.');
    expect(result).toContain('User: Thanks!');
    expect(result).not.toContain('/model');
    expect(result).not.toContain('Bash');
  });
});

// ── compactBefore ────────────────────────────────────────────────────

describe('compactBefore', () => {
  it('compacts entries before position into dialogue summary', async () => {
    const jsonl = makeJSONL([
      entry('u1', null, 'user', [{ type: 'text', text: 'First question' }]),
      entry('a1', 'u1', 'assistant', [{ type: 'text', text: 'First answer' }]),
      entry('u2', 'a1', 'user', [{ type: 'text', text: 'Second question' }]),
      entry('a2', 'u2', 'assistant', [{ type: 'text', text: 'Second answer' }]),
    ]);
    await writeFile(testFile, jsonl);

    const compactOut = testFile.replace('.jsonl', '-out.jsonl');
    const result = await compactBefore(testFile, 2, { noBackup: true, outputPath: compactOut });

    expect(result.preCutMessages).toBe(2);
    expect(result.postCutMessages).toBe(2);
    expect(result.summaryChars).toBeGreaterThan(0);
    expect(result.chainVerified).toBe(true);

    // Read output and verify structure
    const output = await readFile(compactOut, 'utf-8');
    const lines = output
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    // Line 0: compact_boundary
    expect(lines[0].subtype).toBe('compact_boundary');
    expect(lines[0].parentUuid).toBeNull();

    // Line 1: summary
    expect(lines[1].isCompactSummary).toBe(true);
    expect(lines[1].message.content).toContain('First question');
    expect(lines[1].message.content).toContain('First answer');

    // Lines 2-3: post-cut with fresh UUIDs
    expect(lines[2].parentUuid).toBe(lines[1].uuid);
    expect(lines[3].parentUuid).toBe(lines[2].uuid);

    // All share same slug and sessionId
    const slugs = new Set(lines.map((l: Record<string, unknown>) => l.slug));
    expect(slugs.size).toBe(1);

    // Cleanup
    try {
      await unlink(compactOut);
    } catch {
      /* ok */
    }
  });

  it('rejects invalid positions', async () => {
    const jsonl = makeJSONL([entry('u1', null, 'user', [{ type: 'text', text: 'only entry' }])]);
    await writeFile(testFile, jsonl);

    await expect(compactBefore(testFile, 0)).rejects.toThrow('Invalid beforePos');
    await expect(compactBefore(testFile, 5)).rejects.toThrow('Invalid beforePos');
  });
});
