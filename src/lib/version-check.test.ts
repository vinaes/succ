import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

// Mock config
vi.mock('./config.js', () => ({
  getErrorReportingConfig: vi.fn().mockReturnValue({ enabled: false }),
  getSuccDir: vi.fn(() => '/tmp/test-succ'),
  getConfig: vi.fn(() => ({})),
}));

// Mock fault-logger
vi.mock('./fault-logger.js', () => ({
  logWarn: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock fs
vi.mock('fs');

describe('version-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUCC_NO_UPDATE_CHECK;
    delete process.env.CI;
    delete process.env.NO_UPDATE_NOTIFIER;

    // Default: .tmp dir exists, no cache file
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.endsWith('.tmp')) return true;
      return false;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getCachedUpdate', () => {
    it('returns null when cache file does not exist', async () => {
      const { getCachedUpdate } = await import('./version-check.js');
      expect(getCachedUpdate()).toBeNull();
    });

    it('returns cached result when valid', async () => {
      const cache = {
        latest: '2.0.0',
        current: '1.0.0',
        checked_at: new Date().toISOString(),
        update_available: true,
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cache));

      const { getCachedUpdate } = await import('./version-check.js');
      const result = getCachedUpdate();
      expect(result).toEqual(cache);
    });

    it('returns null for expired cache (>48h)', async () => {
      const cache = {
        latest: '2.0.0',
        current: '1.0.0',
        checked_at: new Date(Date.now() - 49 * 3600_000).toISOString(),
        update_available: true,
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cache));

      const { getCachedUpdate } = await import('./version-check.js');
      expect(getCachedUpdate()).toBeNull();
    });

    it('returns null for malformed cache', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not json');

      const { getCachedUpdate } = await import('./version-check.js');
      expect(getCachedUpdate()).toBeNull();
    });

    it('returns null for cache with missing fields', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ latest: '2.0.0' }));

      const { getCachedUpdate } = await import('./version-check.js');
      expect(getCachedUpdate()).toBeNull();
    });
  });

  describe('checkForUpdate', () => {
    it('returns null when SUCC_NO_UPDATE_CHECK=1', async () => {
      process.env.SUCC_NO_UPDATE_CHECK = '1';
      const { checkForUpdate } = await import('./version-check.js');
      const result = await checkForUpdate();
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null when CI=true', async () => {
      process.env.CI = 'true';
      const { checkForUpdate } = await import('./version-check.js');
      const result = await checkForUpdate();
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null when NO_UPDATE_NOTIFIER=1', async () => {
      process.env.NO_UPDATE_NOTIFIER = '1';
      const { checkForUpdate } = await import('./version-check.js');
      const result = await checkForUpdate();
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns cached result within TTL without fetching (update_available: true)', async () => {
      const cache = {
        latest: '99.0.0',
        current: '1.0.0',
        checked_at: new Date(Date.now() - 1 * 3600_000).toISOString(), // 1h ago — within 24h TTL
        update_available: true,
      };

      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        if (s.endsWith('.tmp') || s.endsWith('version-check.json')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cache));

      const { checkForUpdate } = await import('./version-check.js');
      const result = await checkForUpdate();

      expect(result).toEqual(cache);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null within TTL when cached update_available is false', async () => {
      const cache = {
        latest: '1.0.0',
        current: '1.0.0',
        checked_at: new Date(Date.now() - 1 * 3600_000).toISOString(), // 1h ago — within 24h TTL
        update_available: false,
      };

      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        if (s.endsWith('.tmp') || s.endsWith('version-check.json')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cache));

      const { checkForUpdate } = await import('./version-check.js');
      const result = await checkForUpdate();

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetches registry and returns result when update available', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ version: '99.0.0' }),
      });

      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      const { checkForUpdate } = await import('./version-check.js');
      const result = await checkForUpdate();

      expect(result).not.toBeNull();
      expect(result!.latest).toBe('99.0.0');
      expect(result!.update_available).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://registry.npmjs.org/@vinaes/succ/latest',
        expect.objectContaining({ headers: { Accept: 'application/json' } })
      );
    });

    it('returns null when current version is up to date', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ version: '0.0.1' }),
      });

      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      const { checkForUpdate } = await import('./version-check.js');
      const result = await checkForUpdate();
      expect(result).toBeNull();
    });

    it('returns null on fetch error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network error'));

      const { checkForUpdate } = await import('./version-check.js');
      const result = await checkForUpdate();
      expect(result).toBeNull();
    });

    it('returns null on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const { checkForUpdate } = await import('./version-check.js');
      const result = await checkForUpdate();
      expect(result).toBeNull();
    });
  });

  describe('formatUpdateNotification', () => {
    it('formats box-drawing notification', async () => {
      const { formatUpdateNotification } = await import('./version-check.js');
      const output = formatUpdateNotification({
        latest: '2.0.0',
        current: '1.0.0',
        checked_at: new Date().toISOString(),
        update_available: true,
      });

      expect(output).toContain('1.0.0');
      expect(output).toContain('2.0.0');
      expect(output).toContain('npm update -g @vinaes/succ');
      expect(output).toContain('\u256D'); // box corner
      expect(output).toContain('\u256F'); // box corner
    });
  });

  describe('getCurrentVersion', () => {
    it('returns a semver string', async () => {
      const { getCurrentVersion } = await import('./version-check.js');
      expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+/);
    });
  });
});
