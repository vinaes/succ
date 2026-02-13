import { describe, it, expect } from 'vitest';
import { scanSensitive, hasSensitiveInfo, formatMatches } from './sensitive-filter.js';

describe('Sensitive Filter', () => {
  describe('API Keys Detection', () => {
    it('should detect OpenAI keys', () => {
      const result = scanSensitive('My key is sk-abc123456789012345678901234567890123');
      expect(result.hasSensitive).toBe(true);
      expect(result.matches.some((m) => m.type === 'openai_key')).toBe(true);
      expect(result.redactedText).toContain('[OPENAI_KEY]');
    });

    it('should detect OpenAI project keys (sk-proj-)', () => {
      const result = scanSensitive('sk-proj-abc123456789012345678901234567890123');
      expect(result.hasSensitive).toBe(true);
      expect(result.matches.some((m) => m.type === 'openai_key')).toBe(true);
    });

    it('should detect Anthropic keys', () => {
      const result = scanSensitive('Token: sk-ant-abc123-xyz789012345678901');
      expect(result.hasSensitive).toBe(true);
      expect(result.matches.some((m) => m.type === 'anthropic_key')).toBe(true);
      expect(result.redactedText).toContain('[ANTHROPIC_KEY]');
    });

    it('should detect GitHub tokens', () => {
      const result = scanSensitive('ghp_abc123456789012345678901234567890123');
      expect(result.hasSensitive).toBe(true);
      expect(result.matches.some((m) => m.type === 'github_token')).toBe(true);
    });

    it('should detect AWS access keys', () => {
      const result = scanSensitive('AWS key: AKIAIOSFODNN7EXAMPLE');
      expect(result.hasSensitive).toBe(true);
      expect(result.matches.some((m) => m.type === 'aws_access_key')).toBe(true);
    });

    it('should detect Stripe keys', () => {
      const result = scanSensitive('sk_live_abc123456789012345678901234567');
      expect(result.hasSensitive).toBe(true);
      expect(result.matches.some((m) => m.type === 'stripe_key')).toBe(true);
    });

    it('should detect Google API keys', () => {
      const result = scanSensitive('AIzaSyAbc123456789012345678901234567890');
      expect(result.hasSensitive).toBe(true);
      expect(result.matches.some((m) => m.type === 'google_api_key')).toBe(true);
    });
  });

  describe('Phone Numbers Detection', () => {
    it('should detect Russian phone numbers', () => {
      const result = scanSensitive('Call me at 79990001122');
      expect(result.hasSensitive).toBe(true);
      expect(result.matches.some((m) => m.type === 'phone_ru' || m.type === 'long_number')).toBe(
        true
      );
    });

    it('should detect Russian phone with formatting', () => {
      const result = scanSensitive('+7 914 672 45 12');
      expect(result.hasSensitive).toBe(true);
    });

    it('should detect Belarus phone numbers', () => {
      const result = scanSensitive('Phone: 375290001122');
      expect(result.hasSensitive).toBe(true);
      expect(result.matches.some((m) => m.type === 'phone_by' || m.type === 'long_number')).toBe(
        true
      );
    });

    it('should detect international phones', () => {
      const result = scanSensitive('Contact: +1-555-123-4567');
      expect(result.hasSensitive).toBe(true);
    });
  });

  describe('PII Detection (via redactpii)', () => {
    it('should detect email addresses', () => {
      const result = scanSensitive('Email: john@example.com');
      expect(result.hasSensitive).toBe(true);
      expect(result.redactedText).toContain('EMAIL_ADDRESS');
    });

    it('should detect SSN', () => {
      const result = scanSensitive('SSN: 123-45-6789');
      expect(result.hasSensitive).toBe(true);
    });

    it('should detect credit card numbers', () => {
      const result = scanSensitive('Card: 4111-1111-1111-1111');
      expect(result.hasSensitive).toBe(true);
    });
  });

  describe('High Entropy Detection', () => {
    it('should detect high-entropy secrets', () => {
      const result = scanSensitive('token=aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3');
      expect(result.hasSensitive).toBe(true);
      expect(result.matches.some((m) => m.type === 'high_entropy')).toBe(true);
    });

    it('should not flag git commit hashes', () => {
      const result = scanSensitive('commit: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
      expect(result.hasSensitive).toBe(false);
    });

    it('should not flag SHA-256 hashes', () => {
      const hash = 'a'.repeat(64);
      const result = scanSensitive(`hash: ${hash}`);
      // Should not detect as high_entropy
      expect(result.matches.some((m) => m.type === 'high_entropy')).toBe(false);
    });
  });

  describe('Security Patterns', () => {
    it('should detect JWT tokens', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const result = scanSensitive(jwt);
      expect(result.hasSensitive).toBe(true);
      expect(result.matches.some((m) => m.type === 'jwt')).toBe(true);
    });

    it('should detect private IP addresses', () => {
      const result = scanSensitive('Server at 192.168.1.100');
      expect(result.hasSensitive).toBe(true);
      expect(result.matches.some((m) => m.type === 'ipv4_private')).toBe(true);
    });

    it('should detect password assignments', () => {
      const result = scanSensitive('password="supersecret123"');
      expect(result.hasSensitive).toBe(true);
    });
  });

  describe('False Positives Prevention', () => {
    it('should not flag file paths', () => {
      const result = scanSensitive('File: src/components/user/profile/settings.tsx');
      expect(result.hasSensitive).toBe(false);
    });

    it('should not flag package names', () => {
      const result = scanSensitive('Using @anthropic/claude-code@1.2.3');
      expect(result.hasSensitive).toBe(false);
    });

    it('should not flag regular text', () => {
      const result = scanSensitive('This is a normal message about programming.');
      expect(result.hasSensitive).toBe(false);
    });

    it('should not flag short alphanumeric strings', () => {
      const result = scanSensitive('ID: abc123');
      expect(result.hasSensitive).toBe(false);
    });
  });

  describe('hasSensitiveInfo (quick check)', () => {
    it('should return true for sensitive content', () => {
      expect(hasSensitiveInfo('sk-ant-abc123456789012345678901')).toBe(true);
    });

    it('should return false for clean content', () => {
      // Note: redactpii in aggressive mode may flag some words as names
      // Use technical text that won't trigger false positives
      expect(hasSensitiveInfo('The function returns a boolean value.')).toBe(false);
    });
  });

  describe('formatMatches', () => {
    it('should format matches for display', () => {
      const result = scanSensitive('sk-abc12345678901234567890123456 and john@test.com');
      const formatted = formatMatches(result.matches);
      expect(formatted).toContain('API Keys');
    });

    it('should return empty string for no matches', () => {
      const formatted = formatMatches([]);
      expect(formatted).toBe('');
    });
  });

  describe('Redaction', () => {
    it('should properly redact multiple sensitive items', () => {
      const text = 'Key: sk-ant-abc12345678901234567890 Phone: 79990001122';
      const result = scanSensitive(text);
      expect(result.redactedText).not.toContain('sk-ant');
      expect(result.redactedText).not.toContain('79990001122');
    });

    it('should preserve non-sensitive text', () => {
      const result = scanSensitive('Hello sk-ant-abc12345678901234567890 World');
      expect(result.redactedText).toContain('Hello');
      expect(result.redactedText).toContain('World');
    });
  });
});
