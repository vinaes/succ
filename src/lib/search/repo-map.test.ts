import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('../fault-logger.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectRoot: vi.fn(() => '/test/project'),
}));

// ---------------------------------------------------------------------------
// Mock fs at module level (ESM-compatible — vi.spyOn on namespace fails)
// ---------------------------------------------------------------------------

const readdirSyncMock = vi.fn<(...args: unknown[]) => unknown>();
const readFileSyncMock = vi.fn<(...args: unknown[]) => unknown>();
const existsSyncMock = vi.fn<(...args: unknown[]) => unknown>(() => false);
const watchMock = vi.fn(() => ({ close: vi.fn() }));

vi.mock('fs', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    readdirSync: (...args: unknown[]) => readdirSyncMock(...args),
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    watch: (...args: unknown[]) => watchMock(...args),
    default: {
      ...(orig.default as Record<string, unknown>),
      readdirSync: (...args: unknown[]) => readdirSyncMock(...args),
      readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
      existsSync: (...args: unknown[]) => existsSyncMock(...args),
      watch: (...args: unknown[]) => watchMock(...args),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers: configure mock fs for a flat file tree
// ---------------------------------------------------------------------------

interface MockDirent {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
}

function buildFsMock(files: Record<string, string>) {
  readdirSyncMock.mockImplementation((dir: unknown, opts?: unknown) => {
    const dirStr = String(dir).replace(/\\/g, '/');
    const prefix = dirStr.endsWith('/') ? dirStr : dirStr + '/';

    const directChildren = new Map<string, 'file' | 'dir'>();
    for (const p of Object.keys(files)) {
      const normalized = p.replace(/\\/g, '/');
      if (normalized.startsWith(prefix)) {
        const rest = normalized.slice(prefix.length);
        const seg = rest.split('/')[0];
        if (!seg) continue;
        if (rest.includes('/')) {
          directChildren.set(seg, 'dir');
        } else if (!directChildren.has(seg)) {
          directChildren.set(seg, 'file');
        }
      }
    }

    if (opts && typeof opts === 'object' && (opts as Record<string, unknown>).withFileTypes) {
      return Array.from(directChildren.entries()).map(
        ([name, kind]): MockDirent => ({
          name,
          isDirectory: () => kind === 'dir',
          isFile: () => kind === 'file',
        })
      );
    }

    return Array.from(directChildren.keys());
  });

  readFileSyncMock.mockImplementation((p: unknown) => {
    const content = files[String(p).replace(/\\/g, '/')];
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return content;
  });

  existsSyncMock.mockImplementation((p: unknown) => String(p).replace(/\\/g, '/') in files);
}

// ---------------------------------------------------------------------------
// Import subject under test
// ---------------------------------------------------------------------------
import { generateRepoMap } from './repo-map.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateRepoMap', () => {
  beforeEach(() => {
    readdirSyncMock.mockReset();
    readFileSyncMock.mockReset();
    existsSyncMock.mockReset();
    watchMock.mockClear();
  });

  it('returns an empty result for an empty directory', async () => {
    buildFsMock({});
    const result = await generateRepoMap('/empty');
    expect(result.totalFiles).toBe(0);
    expect(result.totalSymbols).toBe(0);
    expect(result.entries).toHaveLength(0);
    expect(result.text).toBe('');
  });

  it('extracts TypeScript exported symbols', async () => {
    buildFsMock({
      '/project/src/auth.ts': [
        'export async function hashPassword(pw: string): string { return ""; }',
        'export const SECRET_KEY = "test";',
        'export class AuthService {}',
        'export interface AuthConfig {}',
        'export type AuthToken = string;',
        'export enum Role { Admin, User }',
        'function privateFunc() {}',
      ].join('\n'),
    });

    const result = await generateRepoMap('/project');

    expect(result.totalFiles).toBe(1);
    const symbols = result.entries[0].symbols;
    expect(symbols).toContain('hashPassword');
    expect(symbols).toContain('SECRET_KEY');
    expect(symbols).toContain('AuthService');
    expect(symbols).toContain('AuthConfig');
    expect(symbols).toContain('AuthToken');
    expect(symbols).toContain('Role');
    // Private symbol must NOT appear
    expect(symbols).not.toContain('privateFunc');
  });

  it('extracts Python symbols, skipping private ones', async () => {
    buildFsMock({
      '/project/app.py': [
        'def public_func():',
        '    pass',
        '',
        'class MyClass:',
        '    pass',
        '',
        'def _private_func():',
        '    pass',
      ].join('\n'),
    });

    const result = await generateRepoMap('/project');

    expect(result.totalFiles).toBe(1);
    const symbols = result.entries[0].symbols;
    expect(symbols).toContain('public_func');
    expect(symbols).toContain('MyClass');
    expect(symbols).not.toContain('_private_func');
  });

  it('extracts Go exported symbols only', async () => {
    buildFsMock({
      '/project/main.go': [
        'func PublicFunc() error { return nil }',
        'func privateFunc() {}',
        'type MyStruct struct {}',
        'type myPrivateStruct struct {}',
        'type Handler interface {}',
      ].join('\n'),
    });

    const result = await generateRepoMap('/project');

    const symbols = result.entries[0].symbols;
    expect(symbols).toContain('PublicFunc');
    expect(symbols).toContain('MyStruct');
    expect(symbols).toContain('Handler');
    expect(symbols).not.toContain('privateFunc');
    expect(symbols).not.toContain('myPrivateStruct');
  });

  it('extracts Rust pub symbols', async () => {
    buildFsMock({
      '/project/lib.rs': [
        'pub fn process_data() -> Result<()> {}',
        'fn private_fn() {}',
        'pub struct Config {}',
        'pub enum Status { Active, Inactive }',
        'pub trait Handler {}',
      ].join('\n'),
    });

    const result = await generateRepoMap('/project');

    const symbols = result.entries[0].symbols;
    expect(symbols).toContain('process_data');
    expect(symbols).toContain('Config');
    expect(symbols).toContain('Status');
    expect(symbols).toContain('Handler');
    expect(symbols).not.toContain('private_fn');
  });

  it('respects the include glob filter', async () => {
    buildFsMock({
      '/project/src/auth.ts': 'export function login() {}',
      '/project/src/utils.ts': 'export function helper() {}',
    });

    const result = await generateRepoMap('/project', {
      include: ['src/auth.ts'],
    });

    expect(result.totalFiles).toBe(1);
    expect(result.entries[0].symbols).toContain('login');
    const names = result.entries.map((e) => path.basename(e.filePath));
    expect(names).not.toContain('utils.ts');
  });

  it('respects the symbolTypes filter — returns only functions', async () => {
    buildFsMock({
      '/project/worker.ts': [
        'export function doWork() {}',
        'export class Worker {}',
        'export interface IWorker {}',
        'export type WorkerId = string;',
      ].join('\n'),
    });

    const result = await generateRepoMap('/project', {
      symbolTypes: ['function'],
    });

    expect(result.entries[0].symbols).toEqual(['doWork']);
  });

  it('respects maxSymbolsPerFile', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `export function fn${i}() {}`).join('\n');

    buildFsMock({ '/project/big.ts': many });

    const result = await generateRepoMap('/project', { maxSymbolsPerFile: 5 });

    expect(result.entries[0].symbols.length).toBeLessThanOrEqual(5);
  });

  it('generates a correctly formatted text map', async () => {
    buildFsMock({
      '/project/src/a.ts': 'export function alpha() {}',
    });

    const result = await generateRepoMap('/project');

    expect(result.text).toMatch(/src\/a\.ts: alpha/);
    expect(result.totalSymbols).toBe(1);
  });
});
