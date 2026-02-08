import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prdArchive } from './prd.js';
import { loadPrd, savePrd, findLatestPrd } from '../lib/prd/state.js';
import type { Prd } from '../lib/prd/types.js';

vi.mock('../lib/prd/state.js', () => ({
  loadPrd: vi.fn(),
  savePrd: vi.fn(),
  findLatestPrd: vi.fn(),
}));

describe('prdArchive', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should archive PRD when valid ID is provided', async () => {
    const mockPrd: Prd = {
      id: 'prd_test123',
      version: 1,
      title: 'Test PRD',
      description: 'Test description',
      status: 'ready',
      execution_mode: 'loop',
      source_file: 'prd.md',
      goals: ['Goal 1'],
      out_of_scope: ['Out of scope'],
      quality_gates: [],
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      started_at: null,
      completed_at: null,
      stats: {
        total_tasks: 0,
        completed_tasks: 0,
        failed_tasks: 0,
        skipped_tasks: 0,
        total_attempts: 0,
        total_duration_ms: 0,
      },
    };

    vi.mocked(loadPrd).mockReturnValue(mockPrd);

    await prdArchive('prd_test123');

    expect(loadPrd).toHaveBeenCalledWith('prd_test123');
    expect(savePrd).toHaveBeenCalledWith(expect.objectContaining({
      id: 'prd_test123',
      status: 'archived',
      version: 1,
      title: 'Test PRD',
      description: 'Test description',
      execution_mode: 'loop',
      source_file: 'prd.md',
      goals: ['Goal 1'],
      out_of_scope: ['Out of scope'],
    }));
    expect(consoleLogSpy).toHaveBeenCalledWith('Archived PRD: Test PRD (prd_test123)');
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should archive latest PRD when no ID provided', async () => {
    const mockLatestPrd: Prd = {
      id: 'prd_latest',
      version: 1,
      title: 'Latest PRD',
      description: 'Latest description',
      status: 'completed',
      execution_mode: 'loop',
      source_file: 'prd.md',
      goals: [],
      out_of_scope: [],
      quality_gates: [],
      created_at: '2024-01-02T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
      started_at: null,
      completed_at: null,
      stats: {
        total_tasks: 0,
        completed_tasks: 0,
        failed_tasks: 0,
        skipped_tasks: 0,
        total_attempts: 0,
        total_duration_ms: 0,
      },
    };

    vi.mocked(findLatestPrd).mockReturnValue({
      id: 'prd_latest',
      title: 'Latest PRD',
      status: 'completed',
      execution_mode: 'loop',
      created_at: '2024-01-02T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
    });
    vi.mocked(loadPrd).mockReturnValue(mockLatestPrd);

    await prdArchive();

    expect(findLatestPrd).toHaveBeenCalled();
    expect(loadPrd).toHaveBeenCalledWith('prd_latest');
    expect(savePrd).toHaveBeenCalledWith(expect.objectContaining({
      id: 'prd_latest',
      status: 'archived',
      version: 1,
      title: 'Latest PRD',
      description: 'Latest description',
      execution_mode: 'loop',
    }));
    expect(consoleLogSpy).toHaveBeenCalledWith('Archived PRD: Latest PRD (prd_latest)');
    expect(processExitSpy).not.toHaveBeenCalled();
  });
});
