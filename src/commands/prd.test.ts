import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prdArchive } from './prd.js';

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

  it('setup complete', () => {
    expect(true).toBe(true);
  });
});
