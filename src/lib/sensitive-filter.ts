/**
 * Sensitive Information Filter
 *
 * Detects and optionally redacts sensitive data:
 * - API keys (OpenAI, Anthropic, AWS, GitHub, etc.)
 * - Passwords and secrets
 * - PII (emails, phone numbers, SSN, credit cards)
 */

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

// Pattern definitions with named groups for clarity
const PATTERNS: { type: string; pattern: RegExp; redactPrefix: string }[] = [
  // API Keys
  { type: 'openai_key', pattern: /sk-[a-zA-Z0-9]{20,}/g, redactPrefix: 'sk-***' },
  { type: 'anthropic_key', pattern: /sk-ant-[a-zA-Z0-9-]{20,}/g, redactPrefix: 'sk-ant-***' },
  { type: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/g, redactPrefix: 'AKIA***' },
  { type: 'aws_secret_key', pattern: /(?:aws)?_?(?:secret)?_?(?:access)?_?key['"]?\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi, redactPrefix: '[AWS_SECRET]' },
  { type: 'github_token', pattern: /ghp_[a-zA-Z0-9]{36}/g, redactPrefix: 'ghp_***' },
  { type: 'github_oauth', pattern: /gho_[a-zA-Z0-9]{36}/g, redactPrefix: 'gho_***' },
  { type: 'github_app', pattern: /ghu_[a-zA-Z0-9]{36}/g, redactPrefix: 'ghu_***' },
  { type: 'github_refresh', pattern: /ghr_[a-zA-Z0-9]{36}/g, redactPrefix: 'ghr_***' },
  { type: 'gitlab_token', pattern: /glpat-[a-zA-Z0-9-]{20,}/g, redactPrefix: 'glpat-***' },
  { type: 'slack_token', pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}/g, redactPrefix: 'xox*-***' },
  { type: 'stripe_key', pattern: /sk_(?:live|test)_[a-zA-Z0-9]{24,}/g, redactPrefix: 'sk_***' },
  { type: 'stripe_pk', pattern: /pk_(?:live|test)_[a-zA-Z0-9]{24,}/g, redactPrefix: 'pk_***' },
  { type: 'google_api_key', pattern: /AIza[0-9A-Za-z-_]{35}/g, redactPrefix: 'AIza***' },
  { type: 'firebase_key', pattern: /AAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140}/g, redactPrefix: '[FIREBASE_KEY]' },
  { type: 'twilio_sid', pattern: /AC[a-z0-9]{32}/gi, redactPrefix: 'AC***' },
  { type: 'sendgrid_key', pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g, redactPrefix: 'SG.***' },
  { type: 'npm_token', pattern: /npm_[a-zA-Z0-9]{36}/g, redactPrefix: 'npm_***' },
  { type: 'heroku_key', pattern: /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, redactPrefix: '[HEROKU_KEY]' },

  // Generic secrets (in config-like contexts)
  { type: 'password_assignment', pattern: /(?:password|passwd|pwd|secret|token|api_key|apikey|auth)['"]?\s*[:=]\s*['"]([^'"\s]{8,})['"]?/gi, redactPrefix: '[REDACTED]' },

  // PII
  { type: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, redactPrefix: '[EMAIL]' },
  { type: 'phone_us', pattern: /(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, redactPrefix: '[PHONE]' },
  { type: 'phone_intl', pattern: /\+\d{1,3}[-.\s]?\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g, redactPrefix: '[PHONE]' },
  { type: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, redactPrefix: '[SSN]' },
  { type: 'credit_card', pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g, redactPrefix: '[CARD]' },

  // IP addresses (internal)
  { type: 'ipv4_private', pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g, redactPrefix: '[PRIVATE_IP]' },

  // JWT tokens
  { type: 'jwt', pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g, redactPrefix: '[JWT]' },

  // Private keys
  { type: 'private_key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, redactPrefix: '[PRIVATE_KEY]' },
];

/**
 * Scan text for sensitive information
 */
export function scanSensitive(text: string): FilterResult {
  const matches: SensitiveMatch[] = [];
  let redactedText = text;

  for (const { type, pattern, redactPrefix } of PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;

    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[1] || match[0]; // Use capture group if exists, otherwise full match
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

  // Sort by position (reverse) to replace from end to start
  matches.sort((a, b) => b.start - a.start);

  // Remove duplicates (overlapping matches)
  const uniqueMatches: SensitiveMatch[] = [];
  for (const match of matches) {
    const overlaps = uniqueMatches.some(
      m => (match.start >= m.start && match.start < m.end) ||
           (match.end > m.start && match.end <= m.end)
    );
    if (!overlaps) {
      uniqueMatches.push(match);
    }
  }

  // Apply redactions
  for (const match of uniqueMatches) {
    redactedText = redactedText.slice(0, match.start) + match.redacted + redactedText.slice(match.end);
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
    for (const item of items.slice(0, 3)) { // Show max 3 per category
      const preview = item.value.length > 20
        ? item.value.slice(0, 10) + '...' + item.value.slice(-5)
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
  if (type.includes('key') || type.includes('token') || type.includes('secret')) {
    return 'API Keys & Tokens';
  }
  if (type.includes('email') || type.includes('phone') || type.includes('ssn') || type.includes('card')) {
    return 'PII';
  }
  if (type.includes('password')) {
    return 'Credentials';
  }
  if (type.includes('ip') || type.includes('jwt') || type.includes('private_key')) {
    return 'Security';
  }
  return 'Other';
}

/**
 * Check if text contains any sensitive info (quick check)
 */
export function hasSensitiveInfo(text: string): boolean {
  for (const { pattern } of PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}
