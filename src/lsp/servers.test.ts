import { describe, it, expect, vi } from 'vitest';
import { LSP_SERVERS, detectProjectLanguages } from './servers.js';

describe('LSP servers', () => {
  describe('LSP_SERVERS config', () => {
    it('should have typescript server', () => {
      expect(LSP_SERVERS.typescript).toBeDefined();
      expect(LSP_SERVERS.typescript.tier).toBe(1);
      expect(LSP_SERVERS.typescript.languages).toContain('typescript');
      expect(LSP_SERVERS.typescript.args).toContain('--stdio');
    });

    it('should have python server', () => {
      expect(LSP_SERVERS.python).toBeDefined();
      expect(LSP_SERVERS.python.tier).toBe(1);
      expect(LSP_SERVERS.python.languages).toContain('python');
    });

    it('should have go server', () => {
      expect(LSP_SERVERS.go).toBeDefined();
      expect(LSP_SERVERS.go.tier).toBe(2);
      expect(LSP_SERVERS.go.install.type).toBe('runtime');
    });

    it('should have rust server', () => {
      expect(LSP_SERVERS.rust).toBeDefined();
      expect(LSP_SERVERS.rust.tier).toBe(2);
      expect(LSP_SERVERS.rust.install.type).toBe('binary');
    });

    it('should have kotlin server', () => {
      expect(LSP_SERVERS.kotlin).toBeDefined();
      expect(LSP_SERVERS.kotlin.tier).toBe(2);
      expect(LSP_SERVERS.kotlin.install.type).toBe('binary');
      expect(LSP_SERVERS.kotlin.languages).toContain('kotlin');
    });

    it('should have swift server', () => {
      expect(LSP_SERVERS.swift).toBeDefined();
      expect(LSP_SERVERS.swift.tier).toBe(2);
      expect(LSP_SERVERS.swift.install.type).toBe('runtime');
      expect(LSP_SERVERS.swift.languages).toContain('swift');
    });

    it('all servers should have required fields', () => {
      for (const [, config] of Object.entries(LSP_SERVERS)) {
        expect(config.name).toBeTruthy();
        expect(config.languages.length).toBeGreaterThan(0);
        expect(config.rootMarkers.length).toBeGreaterThan(0);
        expect(config.command).toBeTruthy();
        expect(config.tier).toBeGreaterThanOrEqual(1);
        expect(config.tier).toBeLessThanOrEqual(3);
      }
    });
  });

  describe('detectProjectLanguages', () => {
    it('should detect TypeScript projects only', () => {
      const exists = vi.fn((p: string) => p.endsWith('tsconfig.json'));
      const result = detectProjectLanguages('/project', exists);
      expect(result).toEqual(['typescript']);
    });

    it('should detect Python projects only', () => {
      const exists = vi.fn((p: string) => p.endsWith('pyproject.toml'));
      const result = detectProjectLanguages('/project', exists);
      expect(result).toEqual(['python']);
    });

    it('should detect Go projects only', () => {
      const exists = vi.fn((p: string) => p.endsWith('go.mod'));
      const result = detectProjectLanguages('/project', exists);
      expect(result).toEqual(['go']);
    });

    it('should detect Rust projects only', () => {
      const exists = vi.fn((p: string) => p.endsWith('Cargo.toml'));
      const result = detectProjectLanguages('/project', exists);
      expect(result).toEqual(['rust']);
    });

    it('should detect C# projects via glob marker', () => {
      // readdirSync returns a .csproj file — the glob *.csproj should match it
      const exists = vi.fn(() => false);
      const readdir = vi.fn(() => ['MyApp.csproj']);
      const result = detectProjectLanguages('/project', exists, readdir);
      expect(result).toEqual(['csharp']);
    });

    it('should detect Kotlin projects only', () => {
      const exists = vi.fn((p: string) => p.endsWith('build.gradle.kts'));
      const result = detectProjectLanguages('/project', exists);
      expect(result).toEqual(['kotlin']);
    });

    it('should detect Swift projects only', () => {
      const exists = vi.fn((p: string) => p.endsWith('Package.swift'));
      const result = detectProjectLanguages('/project', exists);
      expect(result).toEqual(['swift']);
    });

    it('should detect exactly TypeScript and Go for a combined project', () => {
      const exists = vi.fn((p: string) => p.endsWith('tsconfig.json') || p.endsWith('go.mod'));
      const result = detectProjectLanguages('/project', exists);
      expect(result.sort()).toEqual(['go', 'typescript']);
    });

    it('should return empty array for unknown projects', () => {
      const exists = vi.fn(() => false);
      const readdir = vi.fn(() => []);
      const result = detectProjectLanguages('/project', exists, readdir);
      expect(result).toEqual([]);
    });
  });
});
