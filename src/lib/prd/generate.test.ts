import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  discoverProjectRoots,
  detectGatesForRoot,
  detectQualityGates,
  binaryAvailable,
} from './generate.js';
import type { ProjectRoot } from './generate.js';
import type { QualityGatesConfig } from '../config.js';

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
    const frontend = roots.find((r) => r.relPath === 'frontend');
    const backend = roots.find((r) => r.relPath === 'backend');
    expect(frontend).toBeDefined();
    expect(frontend!.configs.has('package.json')).toBe(true);
    expect(backend).toBeDefined();
    expect(backend!.configs.has('go.mod')).toBe(true);
  });

  it('should find configs at depth 2', () => {
    fs.mkdirSync(path.join(tmpDir, 'apps', 'web'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'apps', 'web', 'package.json'), '{}');

    const roots = discoverProjectRoots(tmpDir);
    const web = roots.find((r) => r.relPath === 'apps/web');
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
    const deep = roots.find((r) => r.relPath === 'a/b/c');
    expect(deep).toBeUndefined();
  });

  it('should find both root and subdirectory configs', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, 'backend'));
    fs.writeFileSync(path.join(tmpDir, 'backend', 'go.mod'), '');

    const roots = discoverProjectRoots(tmpDir);
    expect(roots).toHaveLength(2);
    expect(roots.find((r) => r.relPath === '')).toBeDefined();
    expect(roots.find((r) => r.relPath === 'backend')).toBeDefined();
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

    const types = gates.map((g) => `${g.type}:${g.command}`);
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

    const lintGate = gates.find((g) => g.command.includes('golangci-lint'));
    expect(lintGate).toBeDefined();
    expect(lintGate!.required).toBe(false);
  });

  it('should detect Go gates with cd prefix in subdirectory', () => {
    fs.mkdirSync(path.join(tmpDir, 'backend'));
    fs.writeFileSync(path.join(tmpDir, 'backend', 'go.mod'), '');
    const root: ProjectRoot = { relPath: 'backend', configs: new Set(['go.mod']) };
    const gates = detectGatesForRoot(root, tmpDir);

    expect(gates.some((g) => g.command === 'cd "backend" && go build ./...')).toBe(true);
    expect(gates.some((g) => g.command === 'cd "backend" && go test ./...')).toBe(true);
    expect(gates.some((g) => g.command === 'cd "backend" && go vet ./...')).toBe(true);
  });

  it('should detect vitest and use npx vitest run', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' } })
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
      JSON.stringify({ scripts: { test: 'vitest' } })
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
    expect(gates.some((g) => g.command === 'cargo build')).toBe(true);
    expect(gates.some((g) => g.command === 'cargo test')).toBe(true);
  });

  it('should handle nested path with forward slashes', () => {
    fs.mkdirSync(path.join(tmpDir, 'apps', 'api'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'apps', 'api', 'go.mod'), '');
    const root: ProjectRoot = { relPath: 'apps/api', configs: new Set(['go.mod']) };
    const gates = detectGatesForRoot(root, tmpDir);

    expect(gates.some((g) => g.command === 'cd "apps/api" && go build ./...')).toBe(true);
  });

  it('should skip package.json with default npm test placeholder', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } })
    );
    const root: ProjectRoot = { relPath: '', configs: new Set(['package.json']) };
    const gates = detectGatesForRoot(root, tmpDir);

    expect(gates).toHaveLength(0);
  });
});

// ============================================================================
// detectQualityGates (config-driven)
// ============================================================================

vi.mock('../config.js', () => {
  let _projectRoot = '';
  let _config: Record<string, unknown> = {};
  return {
    getProjectRoot: () => _projectRoot,
    getConfig: () => _config,
    __setProjectRoot: (root: string) => {
      _projectRoot = root;
    },
    __setConfig: (cfg: Record<string, unknown>) => {
      _config = cfg;
    },
  };
});

// Import mocked helpers — the cast is needed because these are test-only exports

const configMock: any = await import('../config.js');
const __setProjectRoot: (r: string) => void = configMock.__setProjectRoot;
const __setConfig: (c: Record<string, unknown>) => void = configMock.__setConfig;

describe('detectQualityGates (config-driven)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'succ-gate-cfg-'));
    __setProjectRoot(tmpDir);
    __setConfig({});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should auto-detect with no config (backward compat)', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    const gates = detectQualityGates();

    expect(gates.some((g) => g.type === 'typecheck')).toBe(true);
  });

  it('should add config gates alongside auto-detected', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    const cfg: QualityGatesConfig = {
      gates: [{ type: 'build', command: 'dotnet build' }],
    };
    const gates = detectQualityGates(cfg);

    expect(gates.some((g) => g.type === 'typecheck')).toBe(true);
    expect(gates.some((g) => g.command === 'dotnet build')).toBe(true);
  });

  it('should skip auto-detect when auto_detect is false', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    const cfg: QualityGatesConfig = {
      auto_detect: false,
      gates: [{ type: 'test', command: 'dotnet test' }],
    };
    const gates = detectQualityGates(cfg);

    expect(gates).toHaveLength(1);
    expect(gates[0].command).toBe('dotnet test');
  });

  it('should disable auto-detected gate types', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    const cfg: QualityGatesConfig = {
      disable: ['typecheck'],
    };
    const gates = detectQualityGates(cfg);

    expect(gates.some((g) => g.type === 'typecheck')).toBe(false);
  });

  it('should add subdirectory gates with cd prefix', () => {
    const cfg: QualityGatesConfig = {
      auto_detect: false,
      subdirs: {
        backend: {
          gates: [
            { type: 'build', command: 'mvn compile' },
            { type: 'test', command: 'mvn test' },
          ],
        },
      },
    };
    const gates = detectQualityGates(cfg);

    expect(gates).toHaveLength(2);
    expect(gates[0].command).toBe('cd "backend" && mvn compile');
    expect(gates[1].command).toBe('cd "backend" && mvn test');
  });

  it('should disable auto-detected gates in specific subdirectory', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, 'api'));
    fs.writeFileSync(path.join(tmpDir, 'api', 'go.mod'), '');
    const cfg: QualityGatesConfig = {
      subdirs: {
        api: { disable: ['test'] },
      },
    };
    const gates = detectQualityGates(cfg);

    // Root typecheck should still be there
    expect(gates.some((g) => g.type === 'typecheck' && !g.command.includes('cd '))).toBe(true);
    // api should have build and lint but NOT test
    expect(gates.some((g) => g.command === 'cd "api" && go build ./...')).toBe(true);
    expect(gates.some((g) => g.command === 'cd "api" && go vet ./...')).toBe(true);
    expect(gates.some((g) => g.command === 'cd "api" && go test ./...')).toBe(false);
  });

  it('should respect required and timeout_ms from config', () => {
    const cfg: QualityGatesConfig = {
      auto_detect: false,
      gates: [{ type: 'test', command: 'pytest', required: false, timeout_ms: 300000 }],
    };
    const gates = detectQualityGates(cfg);

    expect(gates).toHaveLength(1);
    expect(gates[0].required).toBe(false);
    expect(gates[0].timeout_ms).toBe(300000);
  });

  it('should read config from getConfig() when no override', () => {
    __setConfig({
      quality_gates: {
        auto_detect: false,
        gates: [{ type: 'custom', command: 'make check' }],
      },
    });
    const gates = detectQualityGates();

    expect(gates).toHaveLength(1);
    expect(gates[0].command).toBe('make check');
  });

  it('should return empty when auto_detect false and no gates', () => {
    const cfg: QualityGatesConfig = { auto_detect: false };
    const gates = detectQualityGates(cfg);

    expect(gates).toHaveLength(0);
  });
});
