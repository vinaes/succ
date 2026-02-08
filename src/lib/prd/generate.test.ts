import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  discoverProjectRoots,
  detectGatesForRoot,
  binaryAvailable,
} from './generate.js';
import type { ProjectRoot } from './generate.js';

// ============================================================================
// binaryAvailable
// ============================================================================

describe('binaryAvailable', () => {
  it('should return true for a common binary', () => {
    // 'node' should always be available in test environment
    expect(binaryAvailable('node')).toBe(true);
  });

  it('should return false for a non-existent binary', () => {
    expect(binaryAvailable('definitely_not_a_real_binary_xyz_123')).toBe(false);
  });
});

// ============================================================================
// discoverProjectRoots
// ============================================================================

describe('discoverProjectRoots', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'succ-gate-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should find config files at root', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    const roots = discoverProjectRoots(tmpDir);
    expect(roots).toHaveLength(1);
    expect(roots[0].relPath).toBe('');
    expect(roots[0].configs.has('tsconfig.json')).toBe(true);
    expect(roots[0].configs.has('package.json')).toBe(true);
  });

  it('should find subdirectory configs at depth 1', () => {
    fs.mkdirSync(path.join(tmpDir, 'frontend'));
    fs.writeFileSync(path.join(tmpDir, 'frontend', 'package.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, 'backend'));
    fs.writeFileSync(path.join(tmpDir, 'backend', 'go.mod'), '');

    const roots = discoverProjectRoots(tmpDir);
    expect(roots).toHaveLength(2);
    const frontend = roots.find(r => r.relPath === 'frontend');
    const backend = roots.find(r => r.relPath === 'backend');
    expect(frontend).toBeDefined();
    expect(frontend!.configs.has('package.json')).toBe(true);
    expect(backend).toBeDefined();
    expect(backend!.configs.has('go.mod')).toBe(true);
  });

  it('should find configs at depth 2', () => {
    fs.mkdirSync(path.join(tmpDir, 'apps', 'web'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'apps', 'web', 'package.json'), '{}');

    const roots = discoverProjectRoots(tmpDir);
    const web = roots.find(r => r.relPath === 'apps/web');
    expect(web).toBeDefined();
    expect(web!.configs.has('package.json')).toBe(true);
  });

  it('should skip ignored directories', () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'package.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, 'dist'));
    fs.writeFileSync(path.join(tmpDir, 'dist', 'tsconfig.json'), '{}');

    const roots = discoverProjectRoots(tmpDir);
    expect(roots).toHaveLength(0);
  });

  it('should skip dot-prefixed directories', () => {
    fs.mkdirSync(path.join(tmpDir, '.hidden'));
    fs.writeFileSync(path.join(tmpDir, '.hidden', 'package.json'), '{}');

    const roots = discoverProjectRoots(tmpDir);
    expect(roots).toHaveLength(0);
  });

  it('should not scan beyond maxDepth', () => {
    fs.mkdirSync(path.join(tmpDir, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'a', 'b', 'c', 'go.mod'), '');

    // depth 2 should NOT reach a/b/c (that's depth 3)
    const roots = discoverProjectRoots(tmpDir, 2);
    const deep = roots.find(r => r.relPath === 'a/b/c');
    expect(deep).toBeUndefined();
  });

  it('should find both root and subdirectory configs', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, 'backend'));
    fs.writeFileSync(path.join(tmpDir, 'backend', 'go.mod'), '');

    const roots = discoverProjectRoots(tmpDir);
    expect(roots).toHaveLength(2);
    expect(roots.find(r => r.relPath === '')).toBeDefined();
    expect(roots.find(r => r.relPath === 'backend')).toBeDefined();
  });

  it('should return empty for a directory with no config files', () => {
    const roots = discoverProjectRoots(tmpDir);
    expect(roots).toHaveLength(0);
  });
});

// ============================================================================
// detectGatesForRoot
// ============================================================================

describe('detectGatesForRoot', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'succ-gate-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should detect TypeScript gate at root', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    const root: ProjectRoot = { relPath: '', configs: new Set(['tsconfig.json']) };
    const gates = detectGatesForRoot(root, tmpDir);

    expect(gates).toHaveLength(1);
    expect(gates[0].type).toBe('typecheck');
    expect(gates[0].command).toBe('npx tsc --noEmit');
  });

  it('should prefix commands for subdirectory', () => {
    fs.mkdirSync(path.join(tmpDir, 'frontend'));
    fs.writeFileSync(path.join(tmpDir, 'frontend', 'tsconfig.json'), '{}');
    const root: ProjectRoot = { relPath: 'frontend', configs: new Set(['tsconfig.json']) };
    const gates = detectGatesForRoot(root, tmpDir);

    expect(gates).toHaveLength(1);
    expect(gates[0].command).toBe('cd "frontend" && npx tsc --noEmit');
  });

  it('should detect Go gates with vet', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), '');
    const root: ProjectRoot = { relPath: '', configs: new Set(['go.mod']) };
    const gates = detectGatesForRoot(root, tmpDir);

    const types = gates.map(g => `${g.type}:${g.command}`);
    expect(types).toContain('build:go build ./...');
    expect(types).toContain('test:go test ./...');
    expect(types).toContain('lint:go vet ./...');
  });

  it('should add golangci-lint as optional when .golangci.yml present', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), '');
    const root: ProjectRoot = {
      relPath: '',
      configs: new Set(['go.mod', '.golangci.yml']),
    };
    const gates = detectGatesForRoot(root, tmpDir);

    const lintGate = gates.find(g => g.command.includes('golangci-lint'));
    expect(lintGate).toBeDefined();
    expect(lintGate!.required).toBe(false);
  });

  it('should detect Go gates with cd prefix in subdirectory', () => {
    fs.mkdirSync(path.join(tmpDir, 'backend'));
    fs.writeFileSync(path.join(tmpDir, 'backend', 'go.mod'), '');
    const root: ProjectRoot = { relPath: 'backend', configs: new Set(['go.mod']) };
    const gates = detectGatesForRoot(root, tmpDir);

    expect(gates.some(g => g.command === 'cd "backend" && go build ./...')).toBe(true);
    expect(gates.some(g => g.command === 'cd "backend" && go test ./...')).toBe(true);
    expect(gates.some(g => g.command === 'cd "backend" && go vet ./...')).toBe(true);
  });

  it('should detect vitest and use npx vitest run', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' } }),
    );
    const root: ProjectRoot = { relPath: '', configs: new Set(['package.json']) };
    const gates = detectGatesForRoot(root, tmpDir);

    expect(gates).toHaveLength(1);
    expect(gates[0].command).toContain('npx vitest run');
  });

  it('should detect vitest in subdirectory with prefix', () => {
    fs.mkdirSync(path.join(tmpDir, 'frontend'));
    fs.writeFileSync(
      path.join(tmpDir, 'frontend', 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' } }),
    );
    const root: ProjectRoot = { relPath: 'frontend', configs: new Set(['package.json']) };
    const gates = detectGatesForRoot(root, tmpDir);

    expect(gates[0].command).toContain('cd "frontend" && npx vitest run');
  });

  it('should detect Python gate', () => {
    const root: ProjectRoot = { relPath: '', configs: new Set(['pyproject.toml']) };
    const gates = detectGatesForRoot(root, tmpDir);

    expect(gates).toHaveLength(1);
    expect(gates[0].command).toBe('pytest');
  });

  it('should detect Rust gates', () => {
    const root: ProjectRoot = { relPath: '', configs: new Set(['Cargo.toml']) };
    const gates = detectGatesForRoot(root, tmpDir);

    expect(gates).toHaveLength(2);
    expect(gates.some(g => g.command === 'cargo build')).toBe(true);
    expect(gates.some(g => g.command === 'cargo test')).toBe(true);
  });

  it('should handle nested path with forward slashes', () => {
    fs.mkdirSync(path.join(tmpDir, 'apps', 'api'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'apps', 'api', 'go.mod'), '');
    const root: ProjectRoot = { relPath: 'apps/api', configs: new Set(['go.mod']) };
    const gates = detectGatesForRoot(root, tmpDir);

    expect(gates.some(g => g.command === 'cd "apps/api" && go build ./...')).toBe(true);
  });

  it('should skip package.json with default npm test placeholder', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    const root: ProjectRoot = { relPath: '', configs: new Set(['package.json']) };
    const gates = detectGatesForRoot(root, tmpDir);

    expect(gates).toHaveLength(0);
  });
});
