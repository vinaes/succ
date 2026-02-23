import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../helpers.js', () => ({
  projectPathParam: {} as any,
  applyProjectPath: vi.fn(async () => {}),
}));

vi.mock('../../lib/prd/generate.js', () => ({
  generatePrd: vi.fn(async () => ({
    prd: {
      id: 'prd_123',
      title: 'Add auth',
      status: 'generated',
      quality_gates: [{ type: 'test', command: 'npm test' }],
    },
    tasks: [
      { id: 'task_001', title: 'Create middleware', priority: 'high' },
      { id: 'task_002', title: 'Add tests', priority: 'medium' },
    ],
  })),
}));

vi.mock('../../lib/prd/runner.js', () => ({
  runPrd: vi.fn(async () => ({
    prd: { status: 'completed', stats: { total_tasks: 2 } },
    tasksCompleted: 2,
    tasksFailed: 0,
    branch: 'prd/prd_123',
  })),
}));

vi.mock('../../lib/prd/export.js', () => ({
  exportPrdToObsidian: vi.fn(() => ({
    prdId: 'prd_123',
    filesCreated: 4,
    outputDir: '.succ/brain/prd/prd_123',
  })),
  exportAllPrds: vi.fn(() => []),
}));

vi.mock('../../lib/prd/state.js', () => ({
  loadPrd: vi.fn(() => null),
  loadTasks: vi.fn(() => []),
  listPrds: vi.fn(() => []),
  findLatestPrd: vi.fn(() => null),
}));

import { registerPrdTools } from './prd.js';
import { generatePrd } from '../../lib/prd/generate.js';
import { runPrd } from '../../lib/prd/runner.js';
import { exportAllPrds, exportPrdToObsidian } from '../../lib/prd/export.js';
import { findLatestPrd, listPrds, loadPrd, loadTasks } from '../../lib/prd/state.js';

type ToolHandler = (args: Record<string, any>) => Promise<any>;

function createMockServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: vi.fn((name: string, _config: any, handler: ToolHandler) => {
      handlers.set(name, handler);
    }),
  };
  return { server, handlers };
}

describe('prd tool module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findLatestPrd).mockReturnValue(null as any);
    vi.mocked(listPrds).mockReturnValue([]);
    vi.mocked(loadPrd).mockReturnValue(null as any);
    vi.mocked(loadTasks).mockReturnValue([]);
  });

  it('registers succ_prd', () => {
    const { server, handlers } = createMockServer();
    registerPrdTools(server as any);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(handlers.has('succ_prd')).toBe(true);
  });

  it('requires description for generate action', async () => {
    const { server, handlers } = createMockServer();
    registerPrdTools(server as any);
    const handler = handlers.get('succ_prd')!;

    const result = await handler({ action: 'generate' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"description" is required');
  });

  it('generates PRD and reports tasks', async () => {
    const { server, handlers } = createMockServer();
    registerPrdTools(server as any);
    const handler = handlers.get('succ_prd')!;

    const result = await handler({
      action: 'generate',
      description: 'Add JWT authentication',
      mode: 'loop',
      auto_parse: true,
    });

    expect(generatePrd).toHaveBeenCalled();
    expect(result.content[0].text).toContain('PRD generated: prd_123');
    expect(result.content[0].text).toContain('task_001');
  });

  it('returns empty list message when no PRDs are present', async () => {
    const { server, handlers } = createMockServer();
    registerPrdTools(server as any);
    const handler = handlers.get('succ_prd')!;

    const result = await handler({ action: 'list' });
    expect(result.content[0].text).toContain('No PRDs found');
  });

  it('shows status for latest PRD when prd_id is omitted', async () => {
    vi.mocked(findLatestPrd).mockReturnValue({ id: 'prd_latest' } as any);
    vi.mocked(loadPrd).mockReturnValue({
      id: 'prd_latest',
      title: 'Latest PRD',
      status: 'in_progress',
      execution_mode: 'loop',
      quality_gates: [{ type: 'test', command: 'npm test' }],
      stats: { completed_tasks: 1, total_tasks: 2, failed_tasks: 0 },
    } as any);
    vi.mocked(loadTasks).mockReturnValue([
      { id: 'task_001', title: 'Setup', status: 'completed', attempts: [{}] },
      { id: 'task_002', title: 'Implement', status: 'in_progress', attempts: [] },
    ] as any);

    const { server, handlers } = createMockServer();
    registerPrdTools(server as any);
    const handler = handlers.get('succ_prd')!;

    const result = await handler({ action: 'status' });
    expect(result.content[0].text).toContain('Latest PRD');
    expect(result.content[0].text).toContain('Resume: succ prd run prd_latest --resume');
  });

  it('returns run errors cleanly', async () => {
    vi.mocked(findLatestPrd).mockReturnValue({ id: 'prd_123' } as any);
    vi.mocked(runPrd).mockRejectedValueOnce(new Error('runner crashed'));

    const { server, handlers } = createMockServer();
    registerPrdTools(server as any);
    const handler = handlers.get('succ_prd')!;

    const result = await handler({ action: 'run' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('runner crashed');
  });

  it('exports all PRDs when all=true', async () => {
    vi.mocked(exportAllPrds).mockReturnValueOnce([
      { prdId: 'prd_1', filesCreated: 4, outputDir: '.succ/brain/prd/prd_1' },
      { prdId: 'prd_2', filesCreated: 3, outputDir: '.succ/brain/prd/prd_2' },
    ] as any);

    const { server, handlers } = createMockServer();
    registerPrdTools(server as any);
    const handler = handlers.get('succ_prd')!;

    const result = await handler({ action: 'export', all: true });
    expect(result.content[0].text).toContain('Exported 2 PRDs');
    expect(exportPrdToObsidian).not.toHaveBeenCalled();
  });
});
