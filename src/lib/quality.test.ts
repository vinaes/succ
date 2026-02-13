import { describe, it, expect } from 'vitest';
import {
  scoreWithHeuristics,
  passesQualityThreshold,
  formatQualityScore,
  QualityScore,
} from './quality.js';

describe('Quality Scoring', () => {
  describe('scoreWithHeuristics', () => {
    it('should return a score between 0 and 1', () => {
      const result = scoreWithHeuristics('Test content');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    });

    it('should score specific technical content higher', () => {
      const vague = scoreWithHeuristics('Something is wrong somehow');
      const specific = scoreWithHeuristics('Fixed bug in `handleAuth` function in src/auth.ts:42');

      expect(specific.score).toBeGreaterThan(vague.score);
    });

    it('should score content with code references higher', () => {
      const noCode = scoreWithHeuristics('Updated the authentication logic');
      const withCode = scoreWithHeuristics('Updated `validateToken()` function in auth.ts');

      expect(withCode.factors.specificity).toBeGreaterThan(noCode.factors.specificity);
    });

    it('should penalize very short content', () => {
      const short = scoreWithHeuristics('fix bug');
      const longer = scoreWithHeuristics(
        'Fixed authentication bug in the login handler when users provide invalid tokens'
      );

      expect(longer.score).toBeGreaterThan(short.score);
    });

    it('should penalize vague language', () => {
      const vague = scoreWithHeuristics('Maybe something is somehow broken or whatever');
      const clear = scoreWithHeuristics('The API endpoint returns 500 error when user ID is null');

      expect(clear.score).toBeGreaterThan(vague.score);
    });

    it('should score actionable content higher', () => {
      const passive = scoreWithHeuristics('The feature is nice');
      const actionable = scoreWithHeuristics(
        'Implement retry logic for failed API calls with exponential backoff'
      );

      expect(actionable.score).toBeGreaterThan(passive.score);
    });

    it('should use mode heuristic', () => {
      const result = scoreWithHeuristics('Test content');
      expect(result.mode).toBe('heuristic');
    });

    it('should have all factor properties', () => {
      const result = scoreWithHeuristics('Test content');

      expect(result.factors).toHaveProperty('specificity');
      expect(result.factors).toHaveProperty('clarity');
      expect(result.factors).toHaveProperty('relevance');
      expect(result.factors).toHaveProperty('uniqueness');
    });

    it('should consider existingSimilarity for uniqueness', () => {
      const noDuplicate = scoreWithHeuristics('Test content');
      const hasDuplicate = scoreWithHeuristics('Test content', 0.9);

      expect(noDuplicate.factors.uniqueness).toBeGreaterThan(hasDuplicate.factors.uniqueness);
    });

    it('should score technical terms positively', () => {
      const noTerms = scoreWithHeuristics('Fixed the thing that was not working');
      const withTerms = scoreWithHeuristics(
        'Fixed the database connection pooling issue causing function timeout'
      );

      expect(withTerms.factors.specificity).toBeGreaterThan(noTerms.factors.specificity);
    });

    it('should score well-structured content with lists', () => {
      const noList = scoreWithHeuristics('I did several things today');
      const withList = scoreWithHeuristics(`Things completed:
- Implemented user authentication
- Added rate limiting
- Fixed bug in payment flow`);

      expect(withList.factors.clarity).toBeGreaterThan(noList.factors.clarity);
    });
  });

  describe('passesQualityThreshold', () => {
    it('should pass when score is above threshold', () => {
      const score: QualityScore = {
        score: 0.7,
        confidence: 0.8,
        factors: { specificity: 0.7, clarity: 0.7, relevance: 0.7, uniqueness: 0.7 },
        mode: 'heuristic',
      };

      expect(passesQualityThreshold(score, 0.5)).toBe(true);
    });

    it('should fail when score is below threshold', () => {
      const score: QualityScore = {
        score: 0.3,
        confidence: 0.8,
        factors: { specificity: 0.3, clarity: 0.3, relevance: 0.3, uniqueness: 0.3 },
        mode: 'heuristic',
      };

      expect(passesQualityThreshold(score, 0.5)).toBe(false);
    });

    it('should pass with default threshold of 0', () => {
      const score: QualityScore = {
        score: 0.1,
        confidence: 0.8,
        factors: { specificity: 0.1, clarity: 0.1, relevance: 0.1, uniqueness: 0.1 },
        mode: 'heuristic',
      };

      expect(passesQualityThreshold(score)).toBe(true);
    });

    it('should use exact threshold boundary', () => {
      const score: QualityScore = {
        score: 0.5,
        confidence: 0.8,
        factors: { specificity: 0.5, clarity: 0.5, relevance: 0.5, uniqueness: 0.5 },
        mode: 'heuristic',
      };

      expect(passesQualityThreshold(score, 0.5)).toBe(true);
    });
  });

  describe('formatQualityScore', () => {
    it('should format score with stars and percentage', () => {
      const score: QualityScore = {
        score: 0.8,
        confidence: 0.9,
        factors: { specificity: 0.8, clarity: 0.8, relevance: 0.8, uniqueness: 0.8 },
        mode: 'heuristic',
      };

      const formatted = formatQualityScore(score);

      expect(formatted).toContain('80%');
      expect(formatted).toContain('★');
      expect(formatted).toContain('heuristic');
    });

    it('should show correct star count', () => {
      const fullStars: QualityScore = {
        score: 1.0,
        confidence: 1.0,
        factors: { specificity: 1, clarity: 1, relevance: 1, uniqueness: 1 },
        mode: 'local',
      };

      const noStars: QualityScore = {
        score: 0.0,
        confidence: 1.0,
        factors: { specificity: 0, clarity: 0, relevance: 0, uniqueness: 0 },
        mode: 'local',
      };

      const fullFormatted = formatQualityScore(fullStars);
      const noFormatted = formatQualityScore(noStars);

      expect(fullFormatted).toContain('★★★★★');
      expect(noFormatted).toContain('☆☆☆☆☆');
    });

    it('should include the mode in output', () => {
      const modes: Array<QualityScore['mode']> = ['heuristic', 'local', 'api'];

      for (const mode of modes) {
        const score: QualityScore = {
          score: 0.5,
          confidence: 0.5,
          factors: { specificity: 0.5, clarity: 0.5, relevance: 0.5, uniqueness: 0.5 },
          mode,
        };

        expect(formatQualityScore(score)).toContain(mode);
      }
    });
  });

  describe('Quality factor calculations', () => {
    it('should detect file paths as specific', () => {
      const withPath = scoreWithHeuristics('Updated src/components/Button.tsx');
      const withoutPath = scoreWithHeuristics('Updated the button');

      expect(withPath.factors.specificity).toBeGreaterThan(withoutPath.factors.specificity);
    });

    it('should detect numbers as specific', () => {
      const withNumbers = scoreWithHeuristics('Fixed issue with user ID 12345 in batch processing');
      const withoutNumbers = scoreWithHeuristics('Fixed issue with user in batch processing');

      expect(withNumbers.factors.specificity).toBeGreaterThan(withoutNumbers.factors.specificity);
    });

    it('should handle edge cases gracefully', () => {
      // Empty-ish content
      const empty = scoreWithHeuristics('');
      expect(empty.score).toBeDefined();
      expect(empty.score).toBeGreaterThanOrEqual(0);
      expect(empty.score).toBeLessThanOrEqual(1);

      // Very long content
      const long = scoreWithHeuristics('a'.repeat(10000));
      expect(long.score).toBeDefined();
      expect(long.score).toBeGreaterThanOrEqual(0);
      expect(long.score).toBeLessThanOrEqual(1);
    });
  });
});
