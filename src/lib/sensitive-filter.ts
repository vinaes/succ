/**
 * Sensitive Information Filter
 *
 * Hybrid detection using multiple methods:
 * 1. Custom regex patterns (API keys, RU/BY phones, etc.)
 * 2. @redactpii/node library (names, US PII, aggressive mode)
 * 3. Shannon entropy analysis (random high-entropy strings)
 */

import { Redactor } from '@redactpii/node';
import { logWarn } from './fault-logger.js';

export interface SensitiveMatch {
  type: string;
  value: string;
  start: number;
  end: number;
  redacted: string;
}

export interface FilterResult {
  hasSensitive: boolean;
  matches: SensitiveMatch[];
  redactedText: string;
  originalText: string;
}

// Initialize redactpii with aggressive mode for better detection
const redactPiiRedactor = new Redactor({ aggressive: true });

// Our custom patterns (not covered well by redactpii)
const CUSTOM_PATTERNS: { type: string; pattern: RegExp; redactPrefix: string }[] = [
  // API Keys (specific formats)
  { type: 'openai_key', pattern: /sk-(?:proj-)?[a-zA-Z0-9]{20,}/g, redactPrefix: '[OPENAI_KEY]' },
  { type: 'anthropic_key', pattern: /sk-ant-[a-zA-Z0-9-]{20,}/g, redactPrefix: '[ANTHROPIC_KEY]' },
  { type: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/g, redactPrefix: '[AWS_KEY]' },
  { type: 'github_token', pattern: /gh[pousr]_[a-zA-Z0-9]{36}/g, redactPrefix: '[GITHUB_TOKEN]' },
  { type: 'gitlab_token', pattern: /glpat-[a-zA-Z0-9-]{20,}/g, redactPrefix: '[GITLAB_TOKEN]' },
  { type: 'slack_token', pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}/g, redactPrefix: '[SLACK_TOKEN]' },
  { type: 'stripe_key', pattern: /[sp]k_(?:live|test)_[a-zA-Z0-9]{24,}/g, redactPrefix: '[STRIPE_KEY]' },
  { type: 'google_api_key', pattern: /AIza[0-9A-Za-z-_]{35}/g, redactPrefix: '[GOOGLE_KEY]' },
  { type: 'sendgrid_key', pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g, redactPrefix: '[SENDGRID_KEY]' },
  { type: 'npm_token', pattern: /npm_[a-zA-Z0-9]{36}/g, redactPrefix: '[NPM_TOKEN]' },
  { type: 'twilio_sid', pattern: /AC[a-z0-9]{32}/gi, redactPrefix: '[TWILIO_SID]' },

  // Generic secrets (in config-like contexts)
  { type: 'password_assignment', pattern: /(?:password|passwd|pwd|secret|api_key|apikey|auth_token)['"]?\s*[:=]\s*['"]([^'"\s]{8,})['"]?/gi, redactPrefix: '[REDACTED]' },

  // International phone numbers (RU/BY - not covered by redactpii)
  { type: 'phone_ru', pattern: /\b[78][-.\s]?\d{3}[-.\s]?\d{3}[-.\s]?\d{2}[-.\s]?\d{2}\b/g, redactPrefix: '[PHONE]' },
  { type: 'phone_by', pattern: /\b375[-.\s]?\d{2}[-.\s]?\d{3}[-.\s]?\d{2}[-.\s]?\d{2}\b/g, redactPrefix: '[PHONE]' },
  { type: 'phone_intl', pattern: /\+\d{1,3}[-.\s]?\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g, redactPrefix: '[PHONE]' },

  // Generic long digit sequences (9-15 digits) - potential phone/account numbers
  // Exclude Unix timestamps (1600000000-1900000000 range)
  { type: 'long_number', pattern: /\b(?!1[6-8]\d{8}\b)\d{9,15}\b/g, redactPrefix: '[NUMBER]' },

  // IP addresses (internal)
  { type: 'ipv4_private', pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g, redactPrefix: '[PRIVATE_IP]' },

  // JWT tokens
  { type: 'jwt', pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g, redactPrefix: '[JWT]' },

  // Private keys
  { type: 'private_key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, redactPrefix: '[PRIVATE_KEY]' },

  // UUID (often used as API keys) - require version bits to avoid false positives
  { type: 'uuid', pattern: /[a-f0-9]{8}-[a-f0-9]{4}-[14][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/gi, redactPrefix: '[UUID]' },
];

/**
 * Calculate Shannon entropy of a string (bits per character)
 * Higher entropy = more random = more likely to be a secret
 */
function calculateEntropy(str: string): number {
  if (str.length === 0) return 0;

  const freq: Record<string, number> = {};
  for (const char of str) {
    freq[char] = (freq[char] || 0) + 1;
  }

  const len = str.length;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Find high-entropy strings that might be secrets
 * Threshold: 4.0 bits for strings >= 20 chars
 */
function findHighEntropyStrings(text: string): SensitiveMatch[] {
  const matches: SensitiveMatch[] = [];

  // Find word-like sequences (alphanumeric with common separators)
  const tokenPattern = /[a-zA-Z0-9_\-+/=]{20,}/g;
  let match;

  while ((match = tokenPattern.exec(text)) !== null) {
    const token = match[0];
    const entropy = calculateEntropy(token);

    // High entropy threshold (>4.0 bits is quite random)
    // Also check it's not a common word pattern
    if (entropy > 4.0 && !isLikelyNonSecret(token)) {
      matches.push({
        type: 'high_entropy',
        value: token,
        start: match.index,
        end: match.index + token.length,
        redacted: '[HIGH_ENTROPY_SECRET]',
      });
    }
  }

  return matches;
}

/**
 * Check if high-entropy string is likely NOT a secret
 * (common patterns that are high entropy but not sensitive)
 */
function isLikelyNonSecret(str: string): boolean {
  // Base64-encoded common strings
  if (/^[A-Za-z0-9+/]+=*$/.test(str) && str.length < 30) return true;

  // Hex hashes (git commits, etc) - usually public
  if (/^[a-f0-9]{40}$/i.test(str)) return true; // SHA-1
  if (/^[a-f0-9]{64}$/i.test(str)) return true; // SHA-256

  // File paths or URLs
  if (str.includes('/') && str.split('/').length > 3) return true;

  // Package names with version
  if (/^[a-z0-9-]+@\d+\.\d+\.\d+$/i.test(str)) return true;

  return false;
}

/**
 * Scan text for sensitive information using hybrid approach
 */
export function scanSensitive(text: string): FilterResult {
  const matches: SensitiveMatch[] = [];

  // 1. Apply custom regex patterns first
  for (const { type, pattern, redactPrefix } of CUSTOM_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const fullMatch = match[0];
      matches.push({
        type,
        value: fullMatch,
        start: match.index,
        end: match.index + fullMatch.length,
        redacted: redactPrefix,
      });
    }
  }

  // 2. Use redactpii for names and US PII
  try {
    const redactPiiResult = redactPiiRedactor.redact(text);
    // Parse the redacted tokens to find what was replaced
    const tokenTypes = ['PERSON_NAME', 'EMAIL_ADDRESS', 'PHONE_NUMBER', 'CREDIT_CARD_NUMBER', 'SSN'];
    for (const tokenType of tokenTypes) {
      const tokenPattern = new RegExp(tokenType, 'g');
      while (tokenPattern.exec(redactPiiResult) !== null) {
        // Find the original value by position mapping (approximate)
        // Since redactpii changes positions, we need to find the original
        // This is a simplified approach - we mark the text as having PII
        if (!matches.some(m => m.type === `redactpii_${tokenType.toLowerCase()}`)) {
          matches.push({
            type: `redactpii_${tokenType.toLowerCase()}`,
            value: tokenType,
            start: 0,
            end: 0,
            redacted: `[${tokenType}]`,
          });
        }
      }
    }
  } catch (err) {
    logWarn('sensitive-filter', err instanceof Error ? err.message : 'redactpii failed');
  }

  // 3. Find high-entropy strings
  const entropyMatches = findHighEntropyStrings(text);
  for (const em of entropyMatches) {
    // Don't add if already covered by a specific pattern
    const alreadyCovered = matches.some(
      m => (em.start >= m.start && em.start < m.end) ||
           (em.end > m.start && em.end <= m.end)
    );
    if (!alreadyCovered) {
      matches.push(em);
    }
  }

  // Sort by position (reverse) to replace from end to start
  matches.sort((a, b) => b.start - a.start);

  // Remove duplicates (overlapping matches)
  const uniqueMatches: SensitiveMatch[] = [];
  for (const match of matches) {
    if (match.start === 0 && match.end === 0) {
      // Special case: redactpii detection without position
      uniqueMatches.push(match);
      continue;
    }
    const overlaps = uniqueMatches.some(
      m => m.start !== 0 && m.end !== 0 &&
           ((match.start >= m.start && match.start < m.end) ||
            (match.end > m.start && match.end <= m.end))
    );
    if (!overlaps) {
      uniqueMatches.push(match);
    }
  }

  // Apply redactions (only for matches with positions)
  let redactedText = text;
  for (const match of uniqueMatches) {
    if (match.start !== 0 || match.end !== 0) {
      redactedText = redactedText.slice(0, match.start) + match.redacted + redactedText.slice(match.end);
    }
  }

  // If redactpii found something, also use its redacted version
  if (uniqueMatches.some(m => m.type.startsWith('redactpii_'))) {
    try {
      redactedText = redactPiiRedactor.redact(redactedText);
    } catch (err) {
      logWarn('sensitive-filter', err instanceof Error ? err.message : 'redactpii redaction failed');
    }
  }

  // Re-sort for display (by position ascending)
  uniqueMatches.sort((a, b) => a.start - b.start);

  return {
    hasSensitive: uniqueMatches.length > 0,
    matches: uniqueMatches,
    redactedText,
    originalText: text,
  };
}

/**
 * Format matches for display
 */
export function formatMatches(matches: SensitiveMatch[]): string {
  if (matches.length === 0) return '';

  const grouped = matches.reduce((acc, m) => {
    const category = getCategoryForType(m.type);
    if (!acc[category]) acc[category] = [];
    acc[category].push(m);
    return acc;
  }, {} as Record<string, SensitiveMatch[]>);

  const lines: string[] = [];
  for (const [category, items] of Object.entries(grouped)) {
    lines.push(`  ${category}: ${items.length} found`);
    for (const item of items.slice(0, 3)) {
      const preview = item.value.length > 25
        ? item.value.slice(0, 12) + '...' + item.value.slice(-8)
        : item.value;
      lines.push(`    - ${item.type}: ${preview}`);
    }
    if (items.length > 3) {
      lines.push(`    ... and ${items.length - 3} more`);
    }
  }

  return lines.join('\n');
}

function getCategoryForType(type: string): string {
  if (type.includes('key') || type.includes('token') || type.includes('secret') || type.includes('entropy')) {
    return 'API Keys & Secrets';
  }
  if (type.includes('email') || type.includes('phone') || type.includes('ssn') || type.includes('card') || type.includes('name')) {
    return 'PII';
  }
  if (type.includes('password') || type.includes('redacted')) {
    return 'Credentials';
  }
  if (type.includes('ip') || type.includes('jwt') || type.includes('private_key') || type.includes('uuid')) {
    return 'Security';
  }
  if (type.includes('number')) {
    return 'Potential PII';
  }
  return 'Other';
}

/**
 * Check if text contains any sensitive info (quick check)
 */
export function hasSensitiveInfo(text: string): boolean {
  // Quick regex check
  for (const { pattern } of CUSTOM_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      return true;
    }
  }

  // Quick entropy check for long random strings
  const highEntropyMatches = findHighEntropyStrings(text);
  if (highEntropyMatches.length > 0) {
    return true;
  }

  // Check with redactpii
  try {
    const result = redactPiiRedactor.redact(text);
    if (result !== text) {
      return true;
    }
  } catch (err) {
    logWarn('sensitive-filter', err instanceof Error ? err.message : 'redactpii check failed');
  }

  return false;
}
