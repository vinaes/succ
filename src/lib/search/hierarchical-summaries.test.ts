/**
 * Tests for hierarchical summaries (RAPTOR-style)
 */

import { describe, it, expect } from 'vitest';
import { inferSummaryLevel } from './hierarchical-summaries.js';

describe('hierarchical-summaries', () => {
  describe('inferSummaryLevel', () => {
    it('should return repo level for project-wide queries', () => {
      expect(inferSummaryLevel('Describe this project')).toBe('repo');
      expect(inferSummaryLevel('What does this codebase do?')).toBe('repo');
      expect(inferSummaryLevel('Give me a repository overview')).toBe('repo');
      expect(inferSummaryLevel('Explain the architecture of this project')).toBe('repo');
    });

    it('should return module level for module-related queries', () => {
      expect(inferSummaryLevel('What does the auth module do?')).toBe('module');
      expect(inferSummaryLevel('Describe the storage subsystem')).toBe('module');
      expect(inferSummaryLevel('How does the search component work?')).toBe('module');
    });

    it('should return directory level for directory queries', () => {
      expect(inferSummaryLevel('What is in the utils directory?')).toBe('directory');
      expect(inferSummaryLevel('Describe this folder')).toBe('directory');
    });

    it('should return file level for specific symbol queries', () => {
      expect(inferSummaryLevel('What does hashPassword do?')).toBe('file');
      expect(inferSummaryLevel('Explain the getUserById function')).toBe('file');
      expect(inferSummaryLevel('How does chunk_code work?')).toBe('file');
    });

    it('should default to directory for generic queries', () => {
      expect(inferSummaryLevel('how does search work')).toBe('directory');
      expect(inferSummaryLevel('explain the config')).toBe('directory');
    });
  });
});
