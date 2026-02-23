import { describe, expect, it } from 'vitest';
import { getTextContent } from './transcript-utils.js';

describe('transcript-utils.getTextContent', () => {
  it('returns string input as-is', () => {
    expect(getTextContent('plain transcript text')).toBe('plain transcript text');
  });

  it('joins text blocks from content arrays', () => {
    const content = [
      { type: 'text', text: 'first block' },
      { type: 'text', text: 'second block' },
    ];
    expect(getTextContent(content)).toBe('first block second block');
  });

  it('returns empty string for null or undefined', () => {
    expect(getTextContent(null)).toBe('');
    expect(getTextContent(undefined)).toBe('');
  });

  it('filters out non-text blocks and empty text values', () => {
    const content = [
      { type: 'tool_use', text: 'tool payload' },
      { type: 'text', text: 'kept' },
      { type: 'text' },
      { type: 'image', text: 'ignored image marker' },
      { type: 'text', text: 'also kept' },
    ];
    expect(getTextContent(content)).toBe('kept also kept');
  });
});
