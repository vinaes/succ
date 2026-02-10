import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePrd } from './parse.js';

// Mock LLM
vi.mock('../llm.js', () => ({
  callLLM: vi.fn(),
  callLLMWithFallback: vi.fn(),
  getLLMConfig: vi.fn().mockReturnValue({ backend: 'local' }),
}));

// Mock codebase context
vi.mock('./codebase-context.js', () => ({
  gatherCodebaseContext: vi.fn().mockResolvedValue({
    file_tree: 'src/\n  lib/\n  commands/',
    code_search_results: '',
    memories: '',
    brain_docs: '',
  }),
  formatContext: vi.fn().mockReturnValue('## File Tree\nsrc/\n  lib/'),
}));

import { callLLM, callLLMWithFallback } from '../llm.js';
const mockCallLLM = vi.mocked(callLLMWithFallback);
const mockCallLLMDirect = vi.mocked(callLLM);

describe('PRD Parser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should parse valid LLM JSON response into tasks', async () => {
    mockCallLLM.mockResolvedValue(JSON.stringify([
      {
        sequence: 1,
        title: 'Add schema',
        description: 'Add schema column to database',
        priority: 'high',
        depends_on: [],
        acceptance_criteria: ['Column exists', 'Migration works'],
        files_to_modify: ['src/db/schema.ts'],
        relevant_files: ['src/db/connection.ts'],
        context_queries: ['database schema'],
      },
      {
        sequence: 2,
        title: 'Add API endpoint',
        description: 'Create REST endpoint',
        priority: 'medium',
        depends_on: ['task_001'],
        acceptance_criteria: ['Endpoint returns 200'],
        files_to_modify: ['src/api/routes.ts'],
        relevant_files: [],
        context_queries: [],
      },
    ]));

    const result = await parsePrd('# PRD\n\nSome content', 'prd_test1234', 'test feature');

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].id).toBe('task_001');
    expect(result.tasks[0].title).toBe('Add schema');
    expect(result.tasks[0].priority).toBe('high');
    expect(result.tasks[0].files_to_modify).toEqual(['src/db/schema.ts']);
    expect(result.tasks[0].depends_on).toEqual([]);

    expect(result.tasks[1].id).toBe('task_002');
    expect(result.tasks[1].depends_on).toEqual(['task_001']);
  });

  it('should handle JSON wrapped in markdown code blocks', async () => {
    mockCallLLM.mockResolvedValue('```json\n[\n  {\n    "sequence": 1,\n    "title": "Task 1",\n    "description": "Do thing"\n  }\n]\n```');

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Task 1');
  });

  it('should normalize sequence-based depends_on to task IDs', async () => {
    mockCallLLM.mockResolvedValue(JSON.stringify([
      { sequence: 1, title: 'First', description: 'First task' },
      { sequence: 2, title: 'Second', description: 'Second task', depends_on: [1] },
    ]));

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    expect(result.tasks[1].depends_on).toEqual(['task_001']);
  });

  it('should warn about missing files_to_modify', async () => {
    mockCallLLM.mockResolvedValue(JSON.stringify([
      { sequence: 1, title: 'Vague task', description: 'Do something' },
    ]));

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    expect(result.warnings.some(w => w.includes('no files_to_modify'))).toBe(true);
  });

  it('should warn about too few tasks', async () => {
    mockCallLLM.mockResolvedValue(JSON.stringify([
      { sequence: 1, title: 'Only one', description: 'Single task' },
    ]));

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    expect(result.warnings.some(w => w.includes('under-decomposed'))).toBe(true);
  });

  it('should warn about file overlap without dependency', async () => {
    mockCallLLM.mockResolvedValue(JSON.stringify([
      { sequence: 1, title: 'Task A', description: 'A', files_to_modify: ['src/shared.ts'] },
      { sequence: 2, title: 'Task B', description: 'B', files_to_modify: ['src/shared.ts'] },
      { sequence: 3, title: 'Task C', description: 'C', files_to_modify: ['src/other.ts'] },
    ]));

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    const overlapWarning = result.warnings.find(w => w.includes('potential conflict'));
    expect(overlapWarning).toBeTruthy();
    expect(overlapWarning).toContain('src/shared.ts');
  });

  it('should not warn about file overlap when dependency exists', async () => {
    mockCallLLM.mockResolvedValue(JSON.stringify([
      { sequence: 1, title: 'Task A', description: 'A', files_to_modify: ['src/shared.ts'] },
      { sequence: 2, title: 'Task B', description: 'B', files_to_modify: ['src/shared.ts'], depends_on: ['task_001'] },
    ]));

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    const overlapWarning = result.warnings.find(w => w.includes('potential conflict'));
    expect(overlapWarning).toBeUndefined();
  });

  it('should warn about invalid dependency references', async () => {
    mockCallLLM.mockResolvedValue(JSON.stringify([
      { sequence: 1, title: 'Task A', description: 'A', depends_on: ['task_099'] },
    ]));

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    expect(result.warnings.some(w => w.includes('non-existent task task_099'))).toBe(true);
  });

  it('should throw on completely invalid LLM response after retry and escalation', async () => {
    // First call returns non-JSON, retry also returns non-JSON
    mockCallLLM
      .mockResolvedValueOnce('This is not JSON at all. Just some text.')
      .mockResolvedValueOnce('Still not JSON.');
    // Escalation backends also fail
    mockCallLLMDirect
      .mockResolvedValueOnce('openrouter garbage')
      .mockResolvedValueOnce('claude garbage');

    await expect(parsePrd('# PRD', 'prd_test1234', 'test'))
      .rejects.toThrow('Failed to parse LLM response');

    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    // Escalation tried openrouter + claude
    expect(mockCallLLMDirect).toHaveBeenCalledTimes(2);
  });

  it('should apply default priority and max_attempts', async () => {
    mockCallLLM.mockResolvedValue(JSON.stringify([
      { sequence: 1, title: 'Basic', description: 'No priority specified' },
    ]));

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    expect(result.tasks[0].priority).toBe('medium');
    expect(result.tasks[0].max_attempts).toBe(3);
  });

  // ============================================================================
  // JSON extraction improvements
  // ============================================================================

  it('should extract tasks from object wrapper like {"tasks":[...]}', async () => {
    mockCallLLM.mockResolvedValue(JSON.stringify({
      tasks: [
        { sequence: 1, title: 'Wrapped task', description: 'Inside object' },
      ],
    }));

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Wrapped task');
  });

  it('should handle JSON with trailing commas', async () => {
    const malformed = `[
      { "sequence": 1, "title": "Task with trailing comma", "description": "Fix me", },
    ]`;
    mockCallLLM.mockResolvedValue(malformed);

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Task with trailing comma');
  });

  it('should handle JSON with single-line comments', async () => {
    const commented = `[
      {
        "sequence": 1,
        "title": "Comment task", // this is a comment
        "description": "Has comments"
      }
    ]`;
    mockCallLLM.mockResolvedValue(commented);

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Comment task');
  });

  it('should extract JSON array embedded in prose text', async () => {
    const prose = `Here are the tasks I've identified:

[{"sequence":1,"title":"Embedded task","description":"Found in prose"}]

Hope this helps!`;
    mockCallLLM.mockResolvedValue(prose);

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Embedded task');
  });

  it('should handle object wrapper inside markdown code block', async () => {
    const response = '```json\n{"tasks": [{"sequence": 1, "title": "Wrapped in block", "description": "test"}]}\n```';
    mockCallLLM.mockResolvedValue(response);

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Wrapped in block');
  });

  // ============================================================================
  // Retry behavior
  // ============================================================================

  it('should retry and succeed when first response is invalid but retry works', async () => {
    mockCallLLM
      .mockResolvedValueOnce('Not JSON — here is my analysis...')
      .mockResolvedValueOnce(JSON.stringify([
        { sequence: 1, title: 'Retry success', description: 'Worked on second try' },
      ]));

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Retry success');
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
  });

  it('should include original response in retry prompt', async () => {
    const badResponse = 'Here are the stories for your PRD...';
    mockCallLLM
      .mockResolvedValueOnce(badResponse)
      .mockResolvedValueOnce(JSON.stringify([
        { sequence: 1, title: 'OK', description: 'OK' },
      ]));

    await parsePrd('# PRD', 'prd_test1234', 'test');

    // Second call should include the bad response in the prompt
    const retryPrompt = mockCallLLM.mock.calls[1][0] as string;
    expect(retryPrompt).toContain('not valid JSON');
    expect(retryPrompt).toContain(badResponse);
  });

  it('should escalate to stronger backend when local LLM fails twice', async () => {
    // Both local attempts return non-JSON
    mockCallLLM
      .mockResolvedValueOnce('Markdown story...')
      .mockResolvedValueOnce('Still markdown...');
    // Escalation to openrouter succeeds
    mockCallLLMDirect.mockResolvedValueOnce(JSON.stringify([
      { sequence: 1, title: 'Escalated task', description: 'From openrouter' },
    ]));

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Escalated task');
    // callLLMWithFallback called twice, callLLM once for escalation
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    expect(mockCallLLMDirect).toHaveBeenCalledTimes(1);
  });
});
