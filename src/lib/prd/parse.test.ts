import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePrd } from './parse.js';

// Mock LLM
vi.mock('../llm.js', () => ({
  callLLM: vi.fn(),
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

import { callLLM } from '../llm.js';
const mockCallLLM = vi.mocked(callLLM);

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

  it('should throw on completely invalid LLM response', async () => {
    mockCallLLM.mockResolvedValue('This is not JSON at all. Just some text.');

    await expect(parsePrd('# PRD', 'prd_test1234', 'test'))
      .rejects.toThrow('Failed to parse LLM response');
  });

  it('should apply default priority and max_attempts', async () => {
    mockCallLLM.mockResolvedValue(JSON.stringify([
      { sequence: 1, title: 'Basic', description: 'No priority specified' },
    ]));

    const result = await parsePrd('# PRD', 'prd_test1234', 'test');
    expect(result.tasks[0].priority).toBe('medium');
    expect(result.tasks[0].max_attempts).toBe(3);
  });
});
