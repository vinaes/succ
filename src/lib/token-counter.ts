/**
 * Simple token counter utility.
 *
 * Uses Anthropic's recommended heuristic: ~3.5 characters per token.
 * This balances accuracy across English (~4), code (~3.5), and other languages (~2).
 *
 * Reference: https://platform.claude.com/docs/en/build-with-claude/token-counting
 */

// Anthropic's recommended heuristic for mixed content
const CHARS_PER_TOKEN = 3.5;

/**
 * Estimate token count for a string.
 * Uses ~3.5 chars/token (Anthropic's recommended heuristic).
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate token count for an array of strings.
 */
export function countTokensArray(texts: string[]): number {
  return texts.reduce((sum, text) => sum + countTokens(text), 0);
}

/**
 * Format token count for display (e.g., "1.2M", "45K", "890").
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(0)}K`;
  }
  return tokens.toString();
}

/**
 * Calculate compression percentage.
 */
export function compressionPercent(original: number, compressed: number): string {
  if (original === 0) return '0%';
  const saved = ((original - compressed) / original) * 100;
  return `${saved.toFixed(1)}%`;
}
