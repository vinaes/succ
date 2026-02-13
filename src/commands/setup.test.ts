import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock child_process before import
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => { throw new Error('not found'); }),
}));

import { setup } from './setup.js';

describe('setup command', () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'succ-setup-'));
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('should show usage when no editor specified', async () => {
    await setup({});
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('should show error for unknown editor', async () => {
    await setup({ editor: 'vim' });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown editor'));
  });

  it('should show available editors for unknown editor', async () => {
    await setup({ editor: 'vim' });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Available editors:')
    );
  });

  it('should configure known editor (cursor)', async () => {
    await setup({ editor: 'cursor' });
    // Should print success message
    const allCalls = consoleSpy.mock.calls.flat().join(' ');
    expect(allCalls).toMatch(/configured|Cursor/i);
  });

  it('should handle --detect mode', async () => {
    await setup({ detect: true });
    // Should either detect editors or say none found
    const allCalls = consoleSpy.mock.calls.flat().join(' ');
    expect(allCalls).toMatch(/detect|editor|supported/i);
  });

  it('should be case-insensitive for editor names', async () => {
    await setup({ editor: 'CURSOR' });
    const allCalls = consoleSpy.mock.calls.flat().join(' ');
    expect(allCalls).toMatch(/configured|Cursor/i);
  });
});
