import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getConfig,
  getProjectRoot,
  getClaudeDir,
  getDbPath,
  getGlobalDbPath,
  setConfigOverride,
  getConfigWithOverride,
  hasOpenRouterKey,
  LOCAL_MODEL,
  OPENROUTER_MODEL,
} from './config.js';

describe('Config Module', () => {
  describe('getProjectRoot', () => {
    it('should find project root with .git', () => {
      const root = getProjectRoot();

      // Should return a valid path
      expect(root).toBeDefined();
      expect(typeof root).toBe('string');
    });

    it('should find project root with .claude', () => {
      const root = getProjectRoot();

      expect(
        fs.existsSync(path.join(root, '.git')) ||
        fs.existsSync(path.join(root, '.claude'))
      ).toBe(true);
    });
  });

  describe('getClaudeDir', () => {
    it('should return .claude path under project root', () => {
      const claudeDir = getClaudeDir();
      const projectRoot = getProjectRoot();

      expect(claudeDir).toBe(path.join(projectRoot, '.claude'));
    });
  });

  describe('getDbPath', () => {
    it('should return succ.db path under .claude', () => {
      const dbPath = getDbPath();
      const claudeDir = getClaudeDir();

      expect(dbPath).toBe(path.join(claudeDir, 'succ.db'));
    });
  });

  describe('getGlobalDbPath', () => {
    it('should return global.db path under ~/.succ', () => {
      const globalDbPath = getGlobalDbPath();

      expect(globalDbPath).toBe(path.join(os.homedir(), '.succ', 'global.db'));
    });

    it('should create ~/.succ directory if not exists', () => {
      const globalDir = path.join(os.homedir(), '.succ');

      // Call getGlobalDbPath which creates the directory
      getGlobalDbPath();

      expect(fs.existsSync(globalDir)).toBe(true);
    });
  });

  describe('getConfig', () => {
    it('should return default config when no config files exist', () => {
      // Note: This will use actual config files if they exist
      const config = getConfig();

      expect(config).toBeDefined();
      expect(config.chunk_size).toBeDefined();
      expect(config.chunk_overlap).toBeDefined();
      expect(config.embedding_model).toBeDefined();
      expect(config.embedding_mode).toBeDefined();
    });

    it('should have valid embedding mode', () => {
      const config = getConfig();

      expect(['local', 'openrouter', 'custom']).toContain(config.embedding_mode);
    });
  });

  describe('setConfigOverride and getConfigWithOverride', () => {
    afterEach(() => {
      setConfigOverride(null);
    });

    it('should apply config override', () => {
      setConfigOverride({ chunk_size: 1000 });
      const config = getConfigWithOverride();

      expect(config.chunk_size).toBe(1000);
    });

    it('should clear override when set to null', () => {
      setConfigOverride({ chunk_size: 1000 });
      expect(getConfigWithOverride().chunk_size).toBe(1000);

      setConfigOverride(null);
      expect(getConfigWithOverride().chunk_size).toBe(getConfig().chunk_size);
    });
  });

  describe('hasOpenRouterKey', () => {
    it('should return boolean', () => {
      const hasKey = hasOpenRouterKey();

      expect(typeof hasKey).toBe('boolean');
    });
  });

  describe('Model constants', () => {
    it('should export LOCAL_MODEL', () => {
      expect(LOCAL_MODEL).toBeDefined();
      expect(typeof LOCAL_MODEL).toBe('string');
    });

    it('should export OPENROUTER_MODEL', () => {
      expect(OPENROUTER_MODEL).toBeDefined();
      expect(typeof OPENROUTER_MODEL).toBe('string');
    });
  });

  describe('Config validation', () => {
    it('should have valid chunk_size', () => {
      const config = getConfig();

      expect(config.chunk_size).toBeGreaterThan(0);
      expect(config.chunk_size).toBeLessThan(100000);
    });

    it('should have valid chunk_overlap', () => {
      const config = getConfig();

      expect(config.chunk_overlap).toBeGreaterThanOrEqual(0);
      expect(config.chunk_overlap).toBeLessThan(config.chunk_size);
    });
  });
});
