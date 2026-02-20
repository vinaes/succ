/**
 * Tests for daemon service routeRequest and helper functions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock all dependencies before importing service
vi.mock('../lib/storage/index.js', () => ({
  hybridSearchDocs: vi.fn(async () => [
    { content: 'test doc', score: 0.8, file_path: 'test.md', memory_id: 1 },
  ]),
  hybridSearchCode: vi.fn(async () => [
    { content: 'function test() {}', score: 0.7, file_path: 'test.ts' },
  ]),
  hybridSearchMemories: vi.fn(async () => [
    { id: 1, content: 'recalled memory', score: 0.9, tags: '["test"]', type: 'observation' },
  ]),
  saveMemory: vi.fn(async () => ({ id: 1, isDuplicate: false })),
  saveGlobalMemory: vi.fn(async () => ({ id: 2, isDuplicate: false })),
  closeDb: vi.fn(),
  closeGlobalDb: vi.fn(),
  getStats: vi.fn(async () => ({ documents: 10, code_files: 5, total_chunks: 100 })),
  getMemoryStats: vi.fn(async () => ({
    total: 20,
    byType: { observation: 10, decision: 5, learning: 5 },
  })),
  incrementMemoryAccessBatch: vi.fn(async () => {}),
  autoLinkSimilarMemories: vi.fn(async () => {}),
  getRecentMemories: vi.fn(async () => [
    { id: 1, content: 'recent memory', tags: ['test'], created_at: new Date().toISOString() },
  ]),
}));

vi.mock('../lib/embeddings.js', () => ({
  getEmbedding: vi.fn(() => new Float32Array(384).fill(0.1)),
  cleanupEmbeddings: vi.fn(),
}));

vi.mock('../lib/config.js', () => ({
  getProjectRoot: vi.fn(() => '/test/project'),
  getSuccDir: vi.fn(() => '/test/project/.succ'),
  getIdleReflectionConfig: vi.fn(() => ({
    enabled: true,
    idle_minutes: 5,
    mode: 'briefing',
    cooldown_minutes: 15,
  })),
  getIdleWatcherConfig: vi.fn(() => ({
    enabled: true,
    idle_minutes: 5,
    check_interval_seconds: 30,
  })),
  getConfig: vi.fn(() => ({
    sensitive_filter_enabled: true,
    sensitive_auto_redact: false,
    quality_threshold: 0.3,
  })),
  getDaemonStatuses: vi.fn(async () => ({})),
  isProjectInitialized: vi.fn(() => true),
  isGlobalOnlyMode: vi.fn(() => false),
}));

vi.mock('../lib/quality.js', () => ({
  scoreMemory: vi.fn(() => ({ score: 0.8, factors: {} })),
  passesQualityThreshold: vi.fn(() => true),
  cleanupQualityScoring: vi.fn(),
}));

vi.mock('../lib/sensitive-filter.js', () => ({
  scanSensitive: vi.fn(() => ({ hasSensitive: false, redactedText: '' })),
}));

vi.mock('../lib/compact-briefing.js', () => ({
  generateCompactBriefing: vi.fn(() => ({
    success: true,
    briefing: 'Test briefing content',
  })),
}));

vi.mock('../lib/llm.js', () => ({
  callLLM: vi.fn(() => 'Reflection text about the session that is long enough to pass validation.'),
  isSleepAgentEnabled: vi.fn(() => false),
}));

vi.mock('../prompts/index.js', () => ({
  REFLECTION_PROMPT: 'Reflect on: {transcript}',
}));

vi.mock('./sessions.js', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return actual;
});

vi.mock('./session-processor.js', () => ({
  processSessionEnd: vi.fn(() => ({
    summary: 'test summary',
    learnings: ['learning 1'],
    saved: 1,
  })),
}));

vi.mock('./watcher.js', () => ({
  startWatcher: vi.fn(() => ({ active: true, patterns: ['**/*.md'], includeCode: false })),
  stopWatcher: vi.fn(async () => {}),
  getWatcherStatus: vi.fn(() => ({ active: false, patterns: [] })),
  indexFileOnDemand: vi.fn(async () => {}),
}));

vi.mock('./analyzer.js', () => ({
  startAnalyzer: vi.fn(() => ({ active: true, runsCompleted: 0 })),
  stopAnalyzer: vi.fn(),
  getAnalyzerStatus: vi.fn(() => ({ active: false, runsCompleted: 0 })),
  triggerAnalysis: vi.fn(async () => {}),
}));

import {
  routeRequest,
  readTailTranscript,
  appendToProgressFile,
  _initTestState,
  _resetTestState,
} from './service.js';

import { saveMemory, saveGlobalMemory, incrementMemoryAccessBatch } from '../lib/storage/index.js';
import { getEmbedding } from '../lib/embeddings.js';
import { getSuccDir } from '../lib/config.js';
import { scoreMemory, passesQualityThreshold } from '../lib/quality.js';
import { scanSensitive } from '../lib/sensitive-filter.js';
import { startWatcher, stopWatcher, getWatcherStatus, indexFileOnDemand } from './watcher.js';
import { startAnalyzer, triggerAnalysis } from './analyzer.js';

describe('Daemon Service', () => {
  let testTmpDir: string;

  beforeEach(() => {
    testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'succ-service-test-'));
    _initTestState(testTmpDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetTestState();
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  });

  // ========================================================================
  // readTailTranscript
  // ========================================================================

  describe('readTailTranscript', () => {
    it('should return empty string for non-existent file', () => {
      const result = readTailTranscript('/nonexistent/file.txt');
      expect(result).toBe('');
    });

    it('should read entire file when smaller than maxBytes', () => {
      const filePath = path.join(testTmpDir, 'small.txt');
      fs.writeFileSync(filePath, 'line 1\nline 2\nline 3\n');
      const result = readTailTranscript(filePath, 1024);
      expect(result).toBe('line 1\nline 2\nline 3\n');
    });

    it('should read only tail when file exceeds maxBytes', () => {
      const filePath = path.join(testTmpDir, 'large.txt');
      // Write a file with many lines
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
      fs.writeFileSync(filePath, lines);

      // Read only last 50 bytes — should start from a complete line boundary
      const result = readTailTranscript(filePath, 50);
      expect(result.length).toBeLessThanOrEqual(50);
      // Should not start mid-line (first char should be 'l' from 'line')
      expect(result.startsWith('line')).toBe(true);
    });
  });

  // ========================================================================
  // appendToProgressFile
  // ========================================================================

  describe('appendToProgressFile', () => {
    it('should create file with header on first call', () => {
      const succDir = path.join(testTmpDir, '.succ', '.tmp');
      fs.mkdirSync(succDir, { recursive: true });

      vi.mocked(getSuccDir).mockReturnValue(path.join(testTmpDir, '.succ'));

      appendToProgressFile('test-session-123', 'First briefing');

      const filePath = path.join(succDir, 'session-test-session-123-progress.md');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('session_id: test-session-123');
      expect(content).toContain('First briefing');
    });

    it('should append subsequent entries', () => {
      const succDir = path.join(testTmpDir, '.succ', '.tmp');
      fs.mkdirSync(succDir, { recursive: true });

      vi.mocked(getSuccDir).mockReturnValue(path.join(testTmpDir, '.succ'));

      appendToProgressFile('test-session', 'Briefing 1');
      appendToProgressFile('test-session', 'Briefing 2');

      const filePath = path.join(succDir, 'session-test-session-progress.md');
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('Briefing 1');
      expect(content).toContain('Briefing 2');
      // Header should appear only once
      const headerCount = (content.match(/session_id:/g) || []).length;
      expect(headerCount).toBe(1);
    });
  });

  // ========================================================================
  // Health & Status Endpoints
  // ========================================================================

  describe('Health & Status', () => {
    it('GET /health should return status, pid, uptime, activeSessions', async () => {
      const result = await routeRequest('GET', '/health', new URLSearchParams(), null);

      expect(result.status).toBe('ok');
      expect(result.pid).toBe(process.pid);
      expect(typeof result.uptime).toBe('number');
      expect(result.activeSessions).toBe(0);
    });

    it('GET /api/status should return daemon info with stats', async () => {
      const result = await routeRequest('GET', '/api/status', new URLSearchParams(), null);

      expect(result.daemon).toBeDefined();
      expect(result.daemon.pid).toBe(process.pid);
      expect(result.index).toBeDefined();
      expect(result.memories).toBeDefined();
      expect(result.services).toBeDefined();
    });

    it('GET /api/services should return service statuses', async () => {
      const result = await routeRequest('GET', '/api/services', new URLSearchParams(), null);

      expect(result.watch).toBeDefined();
      expect(result.analyze).toBeDefined();
      expect(result.idle).toBeDefined();
      expect(result.idle.sessions).toBe(0);
    });
  });

  // ========================================================================
  // Session Management
  // ========================================================================

  describe('Session Management', () => {
    it('POST /api/session/register should create session', async () => {
      const result = await routeRequest('POST', '/api/session/register', new URLSearchParams(), {
        session_id: 'sess-1',
        transcript_path: '/path/to/transcript.jsonl',
      });

      expect(result.success).toBe(true);
      expect(result.session).toBeDefined();
    });

    it('POST /api/session/register without session_id should throw', async () => {
      await expect(
        routeRequest('POST', '/api/session/register', new URLSearchParams(), {})
      ).rejects.toThrow('session_id required');
    });

    it('POST /api/session/unregister should remove session', async () => {
      // First register
      await routeRequest('POST', '/api/session/register', new URLSearchParams(), {
        session_id: 'sess-2',
        transcript_path: '/path/transcript.jsonl',
      });

      // Then unregister
      const result = await routeRequest('POST', '/api/session/unregister', new URLSearchParams(), {
        session_id: 'sess-2',
      });

      expect(result.success).toBe(true);
      expect(result.remaining_sessions).toBe(0);
    });

    it('POST /api/session/activity should record activity', async () => {
      await routeRequest('POST', '/api/session/register', new URLSearchParams(), {
        session_id: 'sess-3',
        transcript_path: '/path/transcript.jsonl',
      });

      const result = await routeRequest('POST', '/api/session/activity', new URLSearchParams(), {
        session_id: 'sess-3',
        type: 'user_prompt',
      });

      expect(result.success).toBe(true);
    });

    it('POST /api/session/activity should auto-register unknown session', async () => {
      const result = await routeRequest('POST', '/api/session/activity', new URLSearchParams(), {
        session_id: 'new-sess',
        type: 'tool_use',
      });

      expect(result.success).toBe(true);

      // Session should now be queryable (includeService=true since auto-registered sessions have no hadUserPrompt)
      const sessions = await routeRequest(
        'GET',
        '/api/sessions',
        new URLSearchParams('includeService=true'),
        null
      );
      expect(sessions.count).toBe(1);
    });

    it('POST /api/session/activity without required params should throw', async () => {
      await expect(
        routeRequest('POST', '/api/session/activity', new URLSearchParams(), { session_id: 'x' })
      ).rejects.toThrow('session_id and type required');
    });

    it('GET /api/sessions should return all sessions', async () => {
      await routeRequest('POST', '/api/session/register', new URLSearchParams(), {
        session_id: 'sess-a',
        transcript_path: '/a.jsonl',
      });
      await routeRequest('POST', '/api/session/register', new URLSearchParams(), {
        session_id: 'sess-b',
        transcript_path: '/b.jsonl',
      });

      // Use includeService=true since newly registered sessions have no hadUserPrompt
      const result = await routeRequest(
        'GET',
        '/api/sessions',
        new URLSearchParams('includeService=true'),
        null
      );
      expect(result.count).toBe(2);
      expect(result.sessions['sess-a']).toBeDefined();
      expect(result.sessions['sess-b']).toBeDefined();
    });
  });

  // ========================================================================
  // Search & Memory Endpoints
  // ========================================================================

  describe('Search & Memory', () => {
    it('POST /api/search should return results and increment access', async () => {
      const result = await routeRequest('POST', '/api/search', new URLSearchParams(), {
        query: 'test query',
        limit: 5,
      });

      expect(result.results).toHaveLength(1);
      expect(incrementMemoryAccessBatch).toHaveBeenCalled();
    });

    it('POST /api/search without query should throw', async () => {
      await expect(routeRequest('POST', '/api/search', new URLSearchParams(), {})).rejects.toThrow(
        'query required'
      );
    });

    it('POST /api/search-code should return results', async () => {
      const result = await routeRequest('POST', '/api/search-code', new URLSearchParams(), {
        query: 'function test',
        limit: 3,
      });

      expect(result.results).toHaveLength(1);
    });

    it('POST /api/recall without query should return recent memories', async () => {
      const result = await routeRequest('POST', '/api/recall', new URLSearchParams(), {
        limit: 5,
      });

      expect(result.results).toHaveLength(1);
    });

    it('POST /api/recall with query should return results', async () => {
      const result = await routeRequest('POST', '/api/recall', new URLSearchParams(), {
        query: 'auth flow',
        limit: 5,
      });

      expect(result.results).toBeDefined();
    });

    it('POST /api/remember should save memory with quality check', async () => {
      const result = await routeRequest('POST', '/api/remember', new URLSearchParams(), {
        content: 'Important decision about architecture',
        tags: ['decision'],
        type: 'decision',
      });

      expect(scanSensitive).toHaveBeenCalledWith('Important decision about architecture');
      expect(getEmbedding).toHaveBeenCalled();
      expect(scoreMemory).toHaveBeenCalled();
      expect(saveMemory).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.id).toBe(1);
    });

    it('POST /api/remember should block sensitive content', async () => {
      vi.mocked(scanSensitive).mockReturnValueOnce({
        hasSensitive: true,
        findings: [{ type: 'api_key', value: 'sk-xxx', position: 0, length: 6 }],
        redactedText: '[REDACTED]',
      } as any);

      await expect(
        routeRequest('POST', '/api/remember', new URLSearchParams(), {
          content: 'my api key is sk-xxx',
        })
      ).rejects.toThrow('Content contains sensitive information');
    });

    it('POST /api/remember should reject below quality threshold', async () => {
      vi.mocked(passesQualityThreshold).mockReturnValueOnce(false);
      vi.mocked(scoreMemory).mockResolvedValueOnce({ score: 0.1, factors: {} } as any);

      const result = await routeRequest('POST', '/api/remember', new URLSearchParams(), {
        content: 'low quality content',
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain('quality threshold');
    });

    it('POST /api/remember with global=true should save to global DB', async () => {
      const result = await routeRequest('POST', '/api/remember', new URLSearchParams(), {
        content: 'Global knowledge',
        global: true,
        tags: ['global'],
      });

      expect(saveGlobalMemory).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  // ========================================================================
  // Watch & Analyze Endpoints
  // ========================================================================

  describe('Watch & Analyze', () => {
    it('POST /api/watch/start should call startWatcher', async () => {
      const result = await routeRequest('POST', '/api/watch/start', new URLSearchParams(), {
        patterns: ['**/*.md'],
        includeCode: false,
      });

      expect(startWatcher).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.active).toBe(true);
    });

    it('POST /api/watch/stop should call stopWatcher', async () => {
      const result = await routeRequest('POST', '/api/watch/stop', new URLSearchParams(), {});

      expect(stopWatcher).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('GET /api/watch/status should return watcher status', async () => {
      const result = await routeRequest('GET', '/api/watch/status', new URLSearchParams(), null);

      expect(getWatcherStatus).toHaveBeenCalled();
      expect(result.active).toBe(false);
    });

    it('POST /api/watch/index should index file on demand', async () => {
      const result = await routeRequest('POST', '/api/watch/index', new URLSearchParams(), {
        file: '/path/to/doc.md',
      });

      expect(indexFileOnDemand).toHaveBeenCalledWith('/path/to/doc.md', expect.any(Function));
      expect(result.success).toBe(true);
    });

    it('POST /api/analyze/start should start analyzer', async () => {
      const result = await routeRequest('POST', '/api/analyze/start', new URLSearchParams(), {
        intervalMinutes: 30,
        mode: 'claude',
      });

      expect(startAnalyzer).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('POST /api/analyze should trigger analysis', async () => {
      const result = await routeRequest('POST', '/api/analyze', new URLSearchParams(), {
        mode: 'claude',
      });

      expect(triggerAnalysis).toHaveBeenCalledWith('claude', expect.any(Function));
      expect(result.success).toBe(true);
    });
  });

  // ========================================================================
  // Error Handling
  // ========================================================================

  describe('Error handling', () => {
    it('should throw for unknown endpoint', async () => {
      await expect(
        routeRequest('GET', '/api/unknown', new URLSearchParams(), null)
      ).rejects.toThrow('Unknown endpoint: GET /api/unknown');
    });

    it('POST /api/remember without content should throw', async () => {
      await expect(
        routeRequest('POST', '/api/remember', new URLSearchParams(), {})
      ).rejects.toThrow('content required');
    });

    it('POST /api/search-code without query should throw', async () => {
      await expect(
        routeRequest('POST', '/api/search-code', new URLSearchParams(), {})
      ).rejects.toThrow('query required');
    });
  });
});
