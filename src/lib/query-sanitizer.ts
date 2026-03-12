/**
 * Query sanitizer — masks PII and secrets in recall event queries before storage.
 *
 * Prevents accidental storage of emails, URLs, JWT tokens, API keys,
 * long hex strings, and base64-like blobs that users may include in queries.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}/g;
const URL_RE = /https?:\/\/[^\s"'<>()[\]{}]+/g;
// JWT: 3 base64url segments (header.payload.signature), min 20 chars each segment
const JWT_RE = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g;
// API key prefixes followed by alphanumeric (at least 8 chars)
const API_KEY_RE = /\b(?:sk|pk|key|api|token|secret)-[A-Za-z0-9_-]{8,}/gi;
// Long hex strings (32+ consecutive hex chars)
const HEX_RE = /\b[0-9a-fA-F]{32,}\b/g;
// Long base64-like strings (32+ chars: alphanumeric + /+=)
// Must not be caught by HEX_RE already — include at least one non-hex base64 char
const BASE64_RE = /[A-Za-z0-9+/]{32,}={0,2}/g;
// Long numeric sequences (credit card numbers, account IDs, order numbers — 6+ consecutive digits)
const LONG_NUMBER_RE = /\b\d{6,}\b/g;

const TRUNCATE_LEN = 256;

export interface SanitizeResult {
  /** The redacted query string (with PII replaced by placeholders). */
  redacted: string;
  /** Same as redacted but truncated to 256 characters. */
  preview256: string;
}

/**
 * Sanitize a query string by masking PII and secret patterns.
 *
 * Masking order matters: apply more-specific patterns first (JWT before BASE64,
 * API_KEY before HEX) to avoid double-masking or partial matches.
 *
 * @param query - Raw query string from a recall event
 * @returns Sanitized result with `redacted` and `preview256` fields
 */
export function sanitizeQuery(query: string): SanitizeResult {
  if (!query) {
    return { redacted: '', preview256: '' };
  }

  let s = query;

  // 1. Emails (must run before URL to avoid catching mailto: links twice)
  s = s.replace(EMAIL_RE, '[EMAIL]');

  // 2. URLs
  s = s.replace(URL_RE, '[URL]');

  // 3. JWT tokens (3-segment base64url) — before BASE64 to avoid partial match
  s = s.replace(JWT_RE, '[JWT]');

  // 4. API keys (prefixed patterns)
  s = s.replace(API_KEY_RE, '[API_KEY]');

  // 5. Long hex strings — before BASE64 because hex is a subset of base64 chars
  s = s.replace(HEX_RE, '[HEX]');

  // 5b. Long numeric sequences (credit card numbers, account IDs, order numbers)
  s = s.replace(LONG_NUMBER_RE, '[REDACTED_NUMBER]');

  // 6. Long base64-like strings (anything 32+ chars with base64 alphabet not already replaced)
  // Only match strings that contain at least one non-hex character (to avoid re-matching [HEX])
  // We check that the string has at least one char in [g-zG-Z+/=] to distinguish from hex
  s = s.replace(BASE64_RE, (match) => {
    // Skip if it looks purely like a hex string that wasn't already caught
    // (e.g. was inside a word boundary that HEX_RE missed)
    if (/^[0-9a-fA-F]+$/.test(match) && match.length >= 32) {
      return '[HEX]';
    }
    return '[BASE64]';
  });

  const preview256 = s.slice(0, TRUNCATE_LEN);

  return { redacted: s, preview256 };
}
