/**
 * Tests for daemon session management
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createSessionManager, type SessionManager } from './sessions.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = createSessionManager();
  });

  describe('register', () => {
    it('should register a new session', () => {
      const session = manager.register('test-123', '/path/to/transcript.jsonl');

      expect(session.transcriptPath).toBe('/path/to/transcript.jsonl');
      expect(session.isService).toBe(false);
      expect(session.hadUserPrompt).toBeUndefined();
      expect(session.lastActivityType).toBeNull();
      // Change tracking fields start undefined (first reflection always runs)
      expect(session.lastTranscriptSize).toBeUndefined();
      expect(session.lastMemoryCount).toBeUndefined();
      expect(session.lastLinkCount).toBeUndefined();
      expect(manager.count(true)).toBe(1);
    });

    it('should register a service session', () => {
      const session = manager.register('service-456', '/path/to/transcript.jsonl', true);

      expect(session.isService).toBe(true);
    });

    it('should overwrite existing session with same ID', () => {
      manager.register('test-123', '/path/1.jsonl');
      manager.register('test-123', '/path/2.jsonl');

      expect(manager.count(true)).toBe(1);
      expect(manager.get('test-123')?.transcriptPath).toBe('/path/2.jsonl');
    });
  });

  describe('unregister', () => {
    it('should remove a session', () => {
      manager.register('test-123', '/path/to/transcript.jsonl');
      const removed = manager.unregister('test-123');

      expect(removed).toBe(true);
      expect(manager.count(true)).toBe(0);
    });

    it('should return false for non-existent session', () => {
      const removed = manager.unregister('non-existent');

      expect(removed).toBe(false);
    });
  });

  describe('activity', () => {
    it('should update last activity for user_prompt', () => {
      manager.register('test-123', '/path/to/transcript.jsonl');
      const session = manager.activity('test-123', 'user_prompt');

      expect(session).not.toBeNull();
      expect(session?.lastActivityType).toBe('user_prompt');
      expect(session?.hadUserPrompt).toBe(true);
    });

    it('should update last activity for stop', () => {
      manager.register('test-123', '/path/to/transcript.jsonl');
      const session = manager.activity('test-123', 'stop');

      expect(session?.lastActivityType).toBe('stop');
      expect(session?.hadUserPrompt).toBeUndefined();
    });

    it('should return null for non-existent session', () => {
      const session = manager.activity('non-existent', 'user_prompt');

      expect(session).toBeNull();
    });

    it('should preserve hadUserPrompt once set', () => {
      manager.register('test-123', '/path/to/transcript.jsonl');
      manager.activity('test-123', 'user_prompt');
      manager.activity('test-123', 'stop');

      const session = manager.get('test-123');
      expect(session?.hadUserPrompt).toBe(true);
      expect(session?.lastActivityType).toBe('stop');
    });
  });

  describe('getAll', () => {
    beforeEach(() => {
      // Setup: 2 regular sessions, 2 service sessions
      manager.register('regular-1', '/path/1.jsonl', false);
      manager.register('regular-2', '/path/2.jsonl', false);
      manager.register('service-1', '/path/3.jsonl', true);
      manager.register('service-2', '/path/4.jsonl', true);

      // Give regular-1 a user prompt (makes it "real")
      manager.activity('regular-1', 'user_prompt');
    });

    it('should return all sessions with includeService=true', () => {
      const all = manager.getAll(true);

      expect(all.size).toBe(4);
    });

    it('should filter service sessions by default', () => {
      const filtered = manager.getAll(false);

      // Only regular-1 has hadUserPrompt=true
      // regular-2 has no user_prompt, so it's treated as service
      // service-1 and service-2 are explicitly service
      expect(filtered.size).toBe(1);
      expect(filtered.has('regular-1')).toBe(true);
    });

    it('should filter sessions without hadUserPrompt', () => {
      const filtered = manager.getAll(false);

      // regular-2 never got user_prompt, so it's filtered
      expect(filtered.has('regular-2')).toBe(false);
    });
  });

  describe('count', () => {
    it('should count all sessions with includeService=true', () => {
      manager.register('regular-1', '/path/1.jsonl', false);
      manager.register('service-1', '/path/2.jsonl', true);
      manager.activity('regular-1', 'user_prompt');

      expect(manager.count(true)).toBe(2);
    });

    it('should count only non-service sessions by default', () => {
      manager.register('regular-1', '/path/1.jsonl', false);
      manager.register('service-1', '/path/2.jsonl', true);
      manager.activity('regular-1', 'user_prompt');

      expect(manager.count(false)).toBe(1);
    });
  });

  describe('isEmpty', () => {
    it('should return true for empty manager', () => {
      expect(manager.isEmpty()).toBe(true);
    });

    it('should return false when sessions exist', () => {
      manager.register('test-123', '/path/to/transcript.jsonl');

      expect(manager.isEmpty()).toBe(false);
    });
  });

  describe('getIdleSessions', () => {
    it('should return sessions with stop activity past idle threshold', () => {
      manager.register('test-123', '/path/to/transcript.jsonl');
      manager.activity('test-123', 'stop');

      // Manually set lastActivity to 3 minutes ago
      const session = manager.get('test-123')!;
      session.lastActivity = Date.now() - 3 * 60 * 1000;

      const idle = manager.getIdleSessions(2); // 2 minute threshold

      expect(idle.length).toBe(1);
      expect(idle[0].sessionId).toBe('test-123');
    });

    it('should not return sessions still within idle threshold', () => {
      manager.register('test-123', '/path/to/transcript.jsonl');
      manager.activity('test-123', 'stop');

      // lastActivity is now, so not idle
      const idle = manager.getIdleSessions(2);

      expect(idle.length).toBe(0);
    });

    it('should not return sessions with user_prompt activity', () => {
      manager.register('test-123', '/path/to/transcript.jsonl');
      manager.activity('test-123', 'user_prompt');

      const session = manager.get('test-123')!;
      session.lastActivity = Date.now() - 3 * 60 * 1000;

      const idle = manager.getIdleSessions(2);

      expect(idle.length).toBe(0);
    });

    it('should skip service sessions', () => {
      manager.register('service-123', '/path/to/transcript.jsonl', true);
      manager.activity('service-123', 'stop');

      const session = manager.get('service-123')!;
      session.lastActivity = Date.now() - 3 * 60 * 1000;

      const idle = manager.getIdleSessions(2);

      expect(idle.length).toBe(0);
    });

    it('should return multiple idle sessions', () => {
      manager.register('test-1', '/path/1.jsonl');
      manager.register('test-2', '/path/2.jsonl');
      manager.activity('test-1', 'stop');
      manager.activity('test-2', 'stop');

      manager.get('test-1')!.lastActivity = Date.now() - 5 * 60 * 1000;
      manager.get('test-2')!.lastActivity = Date.now() - 5 * 60 * 1000;

      const idle = manager.getIdleSessions(2);

      expect(idle.length).toBe(2);
    });
  });

  describe('markReflection', () => {
    it('should update reflection count and timestamp', () => {
      manager.register('test-123', '/path/to/transcript.jsonl');

      const before = manager.get('test-123')!;
      expect(before.reflectionCount).toBe(0);
      expect(before.lastReflection).toBe(0);

      manager.markReflection('test-123');

      const after = manager.get('test-123')!;
      expect(after.reflectionCount).toBe(1);
      expect(after.lastReflection).toBeGreaterThan(0);
    });

    it('should increment reflection count on multiple calls', () => {
      manager.register('test-123', '/path/to/transcript.jsonl');

      manager.markReflection('test-123');
      manager.markReflection('test-123');
      manager.markReflection('test-123');

      expect(manager.get('test-123')!.reflectionCount).toBe(3);
    });

    it('should do nothing for non-existent session', () => {
      // Should not throw
      manager.markReflection('non-existent');
    });
  });
});
