import { describe, it, expect } from 'vitest';
import {
  countTokens,
  countTokensArray,
  formatTokens,
  compressionPercent,
} from './token-counter.js';

describe('Token Counter', () => {
  describe('countTokens', () => {
    it('should return 0 for empty string', () => {
      expect(countTokens('')).toBe(0);
    });

    it('should return 0 for null/undefined', () => {
      expect(countTokens(null as unknown as string)).toBe(0);
      expect(countTokens(undefined as unknown as string)).toBe(0);
    });

    it('should estimate tokens based on character count', () => {
      // 35 characters / 3.5 chars per token = 10 tokens
      const text = 'a'.repeat(35);
      expect(countTokens(text)).toBe(10);
    });

    it('should round up to nearest integer', () => {
      // 10 characters / 3.5 = 2.857... → ceil = 3
      const text = 'a'.repeat(10);
      expect(countTokens(text)).toBe(3);
    });

    it('should handle short text', () => {
      expect(countTokens('hi')).toBeGreaterThan(0);
    });

    it('should handle long text', () => {
      const text = 'word '.repeat(1000);
      const tokens = countTokens(text);
      expect(tokens).toBeGreaterThan(0);
      // 5000 characters / 3.5 ≈ 1429
      expect(tokens).toBeCloseTo(1429, -1);
    });
  });

  describe('countTokensArray', () => {
    it('should return 0 for empty array', () => {
      expect(countTokensArray([])).toBe(0);
    });

    it('should sum tokens from all strings', () => {
      const texts = ['hello', 'world']; // 5 + 5 = 10 chars / 3.5 ≈ 3 tokens each
      const total = countTokensArray(texts);
      expect(total).toBe(countTokens('hello') + countTokens('world'));
    });

    it('should handle array with empty strings', () => {
      const texts = ['hello', '', 'world'];
      const total = countTokensArray(texts);
      expect(total).toBe(countTokens('hello') + countTokens('world'));
    });
  });

  describe('formatTokens', () => {
    it('should format small numbers as is', () => {
      expect(formatTokens(0)).toBe('0');
      expect(formatTokens(100)).toBe('100');
      expect(formatTokens(999)).toBe('999');
    });

    it('should format thousands with K suffix', () => {
      expect(formatTokens(1000)).toBe('1K');
      expect(formatTokens(1500)).toBe('2K');
      expect(formatTokens(45000)).toBe('45K');
      expect(formatTokens(999999)).toBe('1000K');
    });

    it('should format millions with M suffix', () => {
      expect(formatTokens(1000000)).toBe('1.0M');
      expect(formatTokens(1500000)).toBe('1.5M');
      expect(formatTokens(2300000)).toBe('2.3M');
    });
  });

  describe('compressionPercent', () => {
    it('should return 0% for zero original', () => {
      expect(compressionPercent(0, 0)).toBe('0%');
    });

    it('should calculate correct percentage', () => {
      // 1000 original, 100 compressed = 90% saved
      expect(compressionPercent(1000, 100)).toBe('90.0%');
    });

    it('should handle 100% compression', () => {
      expect(compressionPercent(1000, 0)).toBe('100.0%');
    });

    it('should handle 0% compression (no savings)', () => {
      expect(compressionPercent(1000, 1000)).toBe('0.0%');
    });

    it('should handle partial compression', () => {
      // 1000 original, 300 compressed = 70% saved
      expect(compressionPercent(1000, 300)).toBe('70.0%');
    });

    it('should format with one decimal place', () => {
      // 1000 original, 333 compressed = 66.7% saved
      expect(compressionPercent(1000, 333)).toBe('66.7%');
    });
  });
});
