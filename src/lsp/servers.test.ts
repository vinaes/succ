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

    it('all servers should have required fields', () => {
      for (const [key, config] of Object.entries(LSP_SERVERS)) {
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
    it('should detect TypeScript projects', () => {
      const exists = vi.fn((p: string) => p.endsWith('tsconfig.json'));
      const result = detectProjectLanguages('/project', exists);
      expect(result).toContain('typescript');
    });

    it('should detect Python projects', () => {
      const exists = vi.fn((p: string) => p.endsWith('pyproject.toml'));
      const result = detectProjectLanguages('/project', exists);
      expect(result).toContain('python');
    });

    it('should detect Go projects', () => {
      const exists = vi.fn((p: string) => p.endsWith('go.mod'));
      const result = detectProjectLanguages('/project', exists);
      expect(result).toContain('go');
    });

    it('should detect Rust projects', () => {
      const exists = vi.fn((p: string) => p.endsWith('Cargo.toml'));
      const result = detectProjectLanguages('/project', exists);
      expect(result).toContain('rust');
    });

    it('should detect multiple languages', () => {
      const exists = vi.fn((p: string) => p.endsWith('tsconfig.json') || p.endsWith('go.mod'));
      const result = detectProjectLanguages('/project', exists);
      expect(result).toContain('typescript');
      expect(result).toContain('go');
    });

    it('should return empty for unknown projects', () => {
      const exists = vi.fn(() => false);
      const result = detectProjectLanguages('/project', exists);
      expect(result).toHaveLength(0);
    });
  });
});
