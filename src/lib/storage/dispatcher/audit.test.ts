import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageDispatcher, getStorageDispatcher, resetStorageDispatcher } from './index.js';

vi.mock('../../config.js', () => ({
  getConfig: vi.fn(() => ({ storage: {} })),
  getProjectRoot: vi.fn(() => '/test/project'),
  getSuccDir: vi.fn(() => '/test/project/.succ'),
  getStorageConfig: vi.fn(() => ({ backend: 'sqlite', vector: 'builtin' })),
  invalidateConfigCache: vi.fn(),
}));

// Note: These tests cover the SQLite path only. PostgreSQL audit coverage is
// provided by the integration test suite (requires a running PG instance).
describe('Memory Audit Trail', () => {
  let dispatcher: StorageDispatcher;
  const mockPrepareRun = vi.fn(() => ({ changes: 1 }));
  const mockPrepareAll = vi.fn(() => [
    {
      id: 1,
      memory_id: 42,
      event_type: 'create',
      old_content: null,
      new_content: 'test',
      changed_by: 'user',
      created_at: '2026-03-27T10:00:00.000Z',
    },
    {
      id: 2,
      memory_id: 42,
      event_type: 'update',
      old_content: 'test',
      new_content: 'updated',
      changed_by: 'hook',
      created_at: '2026-03-27T11:00:00.000Z',
    },
  ]);
  const mockPrepare = vi.fn(() => ({ run: mockPrepareRun, all: mockPrepareAll }));
  const sqliteMock: Record<string, any> = {
    getDb: vi.fn(() => ({ prepare: mockPrepare })),
    getGlobalDb: vi.fn(() => ({ prepare: mockPrepare })),
  };

  beforeEach(async () => {
    resetStorageDispatcher();
    dispatcher = await getStorageDispatcher();
    // Patch private _sqliteFns directly — StorageDispatcher lazily initializes its SQLite
    // backend and exposes no public setter or DI mechanism for tests. A full refactor to
    // constructor injection would touch 124 dispatcher methods, so we cast to `any` here
    // as the pragmatic alternative for unit-level isolation.
    (dispatcher as any)._sqliteFns = sqliteMock;
    vi.clearAllMocks();
  });

  describe('recordAuditEvent', () => {
    it('should insert an audit event via SQLite', async () => {
      await dispatcher.recordAuditEvent(42, 'create', null, 'test content', 'user');
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO memory_audit'));
      expect(mockPrepareRun).toHaveBeenCalledWith(42, 'create', null, 'test content', 'user');
    });
    it('should not throw on failure', async () => {
      mockPrepareRun.mockImplementationOnce(() => {
        throw new Error('DB write failed');
      });
      await expect(
        dispatcher.recordAuditEvent(42, 'create', null, 'test', 'user')
      ).resolves.toBeUndefined();
    });
    it('should use global db when global=true', async () => {
      await dispatcher.recordAuditEvent(42, 'create', null, 'test', 'user', true);
      expect(sqliteMock.getGlobalDb).toHaveBeenCalled();
    });
  });

  describe('getAuditHistory', () => {
    it('should return audit events for a memory', async () => {
      const history = await dispatcher.getAuditHistory(42);
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('SELECT id, memory_id'));
      expect(history).toHaveLength(2);
      expect(history[0].event_type).toBe('create');
    });
    it('should return empty array on failure', async () => {
      mockPrepareAll.mockImplementationOnce(() => {
        throw new Error('DB read failed');
      });
      expect(await dispatcher.getAuditHistory(42)).toEqual([]);
    });
    it('should use global db when global=true', async () => {
      await dispatcher.getAuditHistory(42, true);
      expect(sqliteMock.getGlobalDb).toHaveBeenCalled();
    });
  });

  describe('pruneAuditTrail', () => {
    it('should delete old audit records', async () => {
      const deleted = await dispatcher.pruneAuditTrail(90);
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM memory_audit'));
      expect(deleted).toBe(1);
    });
    it('should return 0 on failure', async () => {
      mockPrepareRun.mockImplementationOnce(() => {
        throw new Error('DB delete failed');
      });
      expect(await dispatcher.pruneAuditTrail(30)).toBe(0);
    });
    it('should use global db when global=true', async () => {
      await dispatcher.pruneAuditTrail(90, true);
      expect(sqliteMock.getGlobalDb).toHaveBeenCalled();
    });
  });
});

describe('Audit Types', () => {
  it('should export AUDIT_EVENT_TYPES', async () => {
    const { AUDIT_EVENT_TYPES } = await import('../types.js');
    expect(AUDIT_EVENT_TYPES).toContain('create');
    expect(AUDIT_EVENT_TYPES).toContain('delete');
  });
  it('should export AUDIT_CHANGED_BY', async () => {
    const { AUDIT_CHANGED_BY } = await import('../types.js');
    expect(AUDIT_CHANGED_BY).toContain('hook');
    expect(AUDIT_CHANGED_BY).toContain('consolidation');
  });
});
