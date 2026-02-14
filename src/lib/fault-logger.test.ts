import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { logFault, logError, logWarn, logInfo, _resetSentryState } from './fault-logger.js';
import type { FaultEntry } from './fault-logger.js';

// Mock config
const mockConfig = {
  enabled: true,
  level: 'warn' as 'error' | 'warn' | 'info' | 'debug',
  max_file_size_mb: 5,
  webhook_url: '',
  webhook_headers: {} as Record<string, string>,
  sentry_dsn: '',
  sentry_environment: 'production',
  sentry_sample_rate: 1.0,
};

vi.mock('./config.js', () => ({
  getSuccDir: () => '/tmp/succ-test-faults',
  getErrorReportingConfig: () => ({ ...mockConfig }),
}));

describe('fault-logger', () => {
  const testDir = '/tmp/succ-test-faults';
  const logPath = path.join(testDir, 'brain-faults.log');
  const backupPath = logPath + '.1';

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    // Reset config to defaults
    mockConfig.enabled = true;
    mockConfig.level = 'warn';
    mockConfig.max_file_size_mb = 5;
    mockConfig.webhook_url = '';
    mockConfig.webhook_headers = {};
    mockConfig.sentry_dsn = '';
    mockConfig.sentry_environment = 'production';
    mockConfig.sentry_sample_rate = 1.0;

    _resetSentryState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  // -------------------------------------------------------------------------
  // Local file channel
  // -------------------------------------------------------------------------

  describe('local file channel', () => {
    it('writes JSON line to brain-faults.log', () => {
      logFault('error', 'test', 'something broke');
      const content = fs.readFileSync(logPath, 'utf-8').trim();
      const entry: FaultEntry = JSON.parse(content);
      expect(entry.level).toBe('error');
      expect(entry.component).toBe('test');
      expect(entry.message).toBe('something broke');
      expect(entry.timestamp).toBeTruthy();
    });

    it('includes stack trace from Error', () => {
      const err = new Error('boom');
      logFault('error', 'test', 'crash', { error: err });
      const entry: FaultEntry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
      expect(entry.stack).toContain('Error: boom');
    });

    it('includes context object', () => {
      logFault('error', 'mcp', 'failed', { context: { tool: 'recall', query: 'test' } });
      const entry: FaultEntry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
      expect(entry.context).toEqual({ tool: 'recall', query: 'test' });
    });

    it('creates .succ/ directory if missing', () => {
      fs.rmSync(testDir, { recursive: true });
      logFault('error', 'test', 'no dir');
      expect(fs.existsSync(logPath)).toBe(true);
    });

    it('respects level filter — skips debug when level=warn', () => {
      logFault('debug', 'test', 'debug msg');
      logFault('info', 'test', 'info msg');
      expect(fs.existsSync(logPath)).toBe(false);
    });

    it('respects level filter — writes warn when level=warn', () => {
      logFault('warn', 'test', 'warn msg');
      expect(fs.existsSync(logPath)).toBe(true);
    });

    it('respects enabled=false', () => {
      mockConfig.enabled = false;
      logFault('error', 'test', 'should not log');
      expect(fs.existsSync(logPath)).toBe(false);
    });

    it('appends multiple entries as JSON lines', () => {
      logFault('error', 'a', 'first');
      logFault('warn', 'b', 'second');
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).message).toBe('first');
      expect(JSON.parse(lines[1]).message).toBe('second');
    });
  });

  // -------------------------------------------------------------------------
  // Rotation
  // -------------------------------------------------------------------------

  describe('rotation', () => {
    it('rotates when file exceeds max size', () => {
      mockConfig.max_file_size_mb = 0.0001; // ~100 bytes threshold
      // Write enough to exceed threshold
      logFault('error', 'test', 'a'.repeat(200));
      // Next write should trigger rotation
      logFault('error', 'test', 'after rotation');

      expect(fs.existsSync(backupPath)).toBe(true);
      const current = fs.readFileSync(logPath, 'utf-8').trim();
      expect(JSON.parse(current).message).toBe('after rotation');
    });

    it('overwrites .1 backup on second rotation', () => {
      mockConfig.max_file_size_mb = 0.0001;
      logFault('error', 'test', 'a'.repeat(200));
      logFault('error', 'test', 'b'.repeat(200));
      logFault('error', 'test', 'final');

      // .1 should contain the second rotation content, not the first
      const backup = fs.readFileSync(backupPath, 'utf-8').trim();
      const backupEntry = JSON.parse(backup.split('\n').pop()!);
      expect(backupEntry.message).toContain('bbb');
    });
  });

  // -------------------------------------------------------------------------
  // Webhook channel
  // -------------------------------------------------------------------------

  describe('webhook channel', () => {
    it('POSTs to webhook URL', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      mockConfig.webhook_url = 'https://example.com/errors';

      logFault('error', 'test', 'webhook test');

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://example.com/errors');
      expect(opts!.method).toBe('POST');
      const body = JSON.parse(opts!.body as string);
      expect(body.message).toBe('webhook test');
      expect(body.version).toBeTruthy();
    });

    it('sends custom headers', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
      mockConfig.webhook_url = 'https://example.com/errors';
      mockConfig.webhook_headers = { Authorization: 'Bearer token123' };

      logFault('error', 'test', 'with auth');

      const [, opts] = fetchSpy.mock.calls[0];
      expect((opts!.headers as Record<string, string>)['Authorization']).toBe('Bearer token123');
    });

    it('does not call fetch when no webhook_url', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      logFault('error', 'test', 'no webhook');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does not throw on fetch failure', () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
      mockConfig.webhook_url = 'https://example.com/errors';
      expect(() => logFault('error', 'test', 'should not throw')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Sentry channel
  // -------------------------------------------------------------------------

  describe('sentry channel', () => {
    it('does not try to load sentry when no DSN', () => {
      logFault('error', 'test', 'no sentry');
      // Just verifying no crash — sentry_dsn is empty
    });

    it('handles missing @sentry/node gracefully', () => {
      mockConfig.sentry_dsn = 'https://key@sentry.example.com/1';
      expect(() => logFault('error', 'test', 'sentry missing')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Convenience wrappers
  // -------------------------------------------------------------------------

  describe('convenience wrappers', () => {
    it('logError logs at error level', () => {
      logError('mcp', 'tool failed');
      const entry: FaultEntry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
      expect(entry.level).toBe('error');
      expect(entry.component).toBe('mcp');
    });

    it('logError includes error and context', () => {
      const err = new Error('oops');
      logError('mcp', 'tool failed', err, { tool: 'recall' });
      const entry: FaultEntry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
      expect(entry.stack).toContain('Error: oops');
      expect(entry.context).toEqual({ tool: 'recall' });
    });

    it('logWarn logs at warn level', () => {
      logWarn('embeddings', 'slow batch');
      const entry: FaultEntry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
      expect(entry.level).toBe('warn');
      expect(entry.component).toBe('embeddings');
    });

    it('logInfo logs at info level when level=info', () => {
      mockConfig.level = 'info';
      logInfo('daemon', 'started');
      const entry: FaultEntry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
      expect(entry.level).toBe('info');
    });

    it('logInfo is filtered out when level=warn', () => {
      logInfo('daemon', 'should be filtered');
      expect(fs.existsSync(logPath)).toBe(false);
    });
  });
});
