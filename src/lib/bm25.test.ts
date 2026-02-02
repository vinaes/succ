import { describe, it, expect } from 'vitest';
import {
  tokenizeCode,
  tokenizeDocs,
  buildIndex,
  search,
  addToIndex,
  removeFromIndex,
  reciprocalRankFusion,
  serializeIndex,
  deserializeIndex,
  createEmptyIndex,
} from './bm25.js';

describe('tokenizeCode', () => {
  it('splits camelCase', () => {
    const tokens = tokenizeCode('useGlobalHooks');
    expect(tokens).toContain('use');
    expect(tokens).toContain('global');
    expect(tokens).toContain('hooks');
    // Also contains original
    expect(tokens).toContain('useglobalhooks');
  });

  it('splits PascalCase', () => {
    const tokens = tokenizeCode('MyComponent');
    expect(tokens).toContain('my');
    expect(tokens).toContain('component');
  });

  it('handles acronyms', () => {
    const tokens = tokenizeCode('HTMLParser');
    expect(tokens).toContain('html');
    expect(tokens).toContain('parser');
  });

  it('splits snake_case', () => {
    const tokens = tokenizeCode('get_user_name');
    expect(tokens).toContain('get');
    expect(tokens).toContain('user');
    expect(tokens).toContain('name');
  });

  it('splits kebab-case', () => {
    const tokens = tokenizeCode('my-component');
    expect(tokens).toContain('my');
    expect(tokens).toContain('component');
  });

  it('handles mixed code', () => {
    const tokens = tokenizeCode('function getUserById(id: number)');
    expect(tokens).toContain('function');
    expect(tokens).toContain('get');
    expect(tokens).toContain('user');
    expect(tokens).toContain('by');
    expect(tokens).toContain('id');
    expect(tokens).toContain('number');
  });
});

describe('tokenizeDocs', () => {
  it('removes markdown syntax', () => {
    const tokens = tokenizeDocs('# Heading\n**bold** and *italic*');
    expect(tokens).toContain('heading');
    expect(tokens).toContain('bold');
    expect(tokens).toContain('italic');
    expect(tokens).not.toContain('#');
    expect(tokens).not.toContain('**');
  });

  it('extracts link text', () => {
    const tokens = tokenizeDocs('[click here](https://example.com)');
    expect(tokens).toContain('click');
    expect(tokens).toContain('here');
    expect(tokens).not.toContain('https');
  });

  it('applies stemming', () => {
    const tokens = tokenizeDocs('running searches connections');
    // Stemmed versions (simplified Porter stemmer)
    expect(tokens).toContain('runn'); // -ing removed
    expect(tokens).toContain('searche'); // -s removed
    expect(tokens).toContain('connection'); // -s removed
    // Also keeps originals
    expect(tokens).toContain('running');
    expect(tokens).toContain('searches');
    expect(tokens).toContain('connections');
  });

  it('filters short words', () => {
    // Only words with length > 2 are kept
    const tokens = tokenizeDocs('a to is the and for');
    // 'the', 'and', 'for' have length 3, so they pass the filter
    expect(tokens).toContain('the');
    expect(tokens).toContain('and');
    expect(tokens).toContain('for');
    // 'a', 'to', 'is' are too short (length <= 2)
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('to');
    expect(tokens).not.toContain('is');
  });
});

describe('buildIndex', () => {
  it('builds index from documents', () => {
    const docs = [
      { id: 1, content: 'function getUser() { return user; }' },
      { id: 2, content: 'function fetchData() { return data; }' },
    ];
    const index = buildIndex(docs, 'code');

    expect(index.totalDocs).toBe(2);
    expect(index.docLengths.size).toBe(2);
    expect(index.invertedIndex.has('function')).toBe(true);
    expect(index.invertedIndex.get('function')?.size).toBe(2); // in both docs
  });

  it('stores raw content for exact match', () => {
    const docs = [{ id: 1, content: 'useGlobalHooks' }];
    const index = buildIndex(docs, 'code');

    expect(index.rawContent.get(1)).toBe('useglobalhooks');
  });
});

describe('search', () => {
  const docs = [
    { id: 1, content: 'function useGlobalHooks() { return hooks; }' },
    { id: 2, content: 'function fetchUserData() { return userData; }' },
    { id: 3, content: 'const globalConfig = { hooks: true };' },
  ];

  it('finds exact identifier match', () => {
    const index = buildIndex(docs, 'code');
    const results = search('useGlobalHooks', index, 'code');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].docId).toBe(1); // Exact match should be first
  });

  it('finds partial matches', () => {
    const index = buildIndex(docs, 'code');
    const results = search('hooks', index, 'code');

    expect(results.length).toBeGreaterThan(0);
    // Both doc 1 and 3 contain 'hooks'
    const docIds = results.map((r) => r.docId);
    expect(docIds).toContain(1);
    expect(docIds).toContain(3);
  });

  it('ranks by relevance', () => {
    const index = buildIndex(docs, 'code');
    const results = search('user data', index, 'code');

    expect(results[0].docId).toBe(2); // fetchUserData has both terms
  });

  it('respects limit', () => {
    const index = buildIndex(docs, 'code');
    const results = search('function', index, 'code', 1);

    expect(results.length).toBe(1);
  });
});

describe('search with docs tokenizer', () => {
  const docs = [
    { id: 1, content: '# User Authentication\n\nHandles user login and registration.' },
    { id: 2, content: '# Data Fetching\n\nFetches data from API endpoints.' },
  ];

  it('finds stemmed matches', () => {
    const index = buildIndex(docs, 'docs');
    // Search for 'authenticate' should match 'authentication' via stemming
    const results = search('authenticate', index, 'docs');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].docId).toBe(1);
  });

  it('finds plural/singular', () => {
    const index = buildIndex(docs, 'docs');
    // 'users' should match 'user'
    const results = search('users', index, 'docs');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].docId).toBe(1);
  });
});

describe('addToIndex / removeFromIndex', () => {
  it('adds document to index', () => {
    const index = createEmptyIndex();
    addToIndex(index, { id: 1, content: 'hello world' }, 'code');

    expect(index.totalDocs).toBe(1);
    expect(index.invertedIndex.has('hello')).toBe(true);
  });

  it('removes document from index', () => {
    const docs = [
      { id: 1, content: 'hello world' },
      { id: 2, content: 'goodbye world' },
    ];
    const index = buildIndex(docs, 'code');

    removeFromIndex(index, 1);

    expect(index.totalDocs).toBe(1);
    expect(index.docLengths.has(1)).toBe(false);
    expect(index.rawContent.has(1)).toBe(false);
  });
});

describe('reciprocalRankFusion', () => {
  it('combines BM25 and vector results', () => {
    const bm25 = [
      { docId: 1, score: 10 },
      { docId: 2, score: 5 },
      { docId: 3, score: 3 },
    ];
    const vector = [
      { docId: 2, score: 0.9 },
      { docId: 4, score: 0.8 },
      { docId: 1, score: 0.7 },
    ];

    const results = reciprocalRankFusion(bm25, vector, 0.5);

    // Doc 1 and 2 appear in both, should score higher
    const docIds = results.map((r) => r.docId);
    expect(docIds.slice(0, 2)).toContain(1);
    expect(docIds.slice(0, 2)).toContain(2);
  });

  it('respects alpha weighting', () => {
    const bm25 = [{ docId: 1, score: 10 }];
    const vector = [{ docId: 2, score: 0.9 }];

    // Pure BM25
    const bm25Only = reciprocalRankFusion(bm25, vector, 0);
    expect(bm25Only[0].docId).toBe(1);

    // Pure vector
    const vectorOnly = reciprocalRankFusion(bm25, vector, 1);
    expect(vectorOnly[0].docId).toBe(2);
  });

  it('respects limit', () => {
    const bm25 = [
      { docId: 1, score: 10 },
      { docId: 2, score: 5 },
    ];
    const vector = [
      { docId: 3, score: 0.9 },
      { docId: 4, score: 0.8 },
    ];

    const results = reciprocalRankFusion(bm25, vector, 0.5, 2);
    expect(results.length).toBe(2);
  });
});

describe('serialization', () => {
  it('serializes and deserializes index', () => {
    const docs = [
      { id: 1, content: 'hello world' },
      { id: 2, content: 'goodbye world' },
    ];
    const original = buildIndex(docs, 'code');

    const serialized = serializeIndex(original);
    const restored = deserializeIndex(serialized);

    expect(restored.totalDocs).toBe(original.totalDocs);
    expect(restored.avgDocLength).toBe(original.avgDocLength);
    expect(restored.invertedIndex.size).toBe(original.invertedIndex.size);
    expect(restored.docLengths.size).toBe(original.docLengths.size);
    expect(restored.rawContent.size).toBe(original.rawContent.size);

    // Search should work on restored index
    const results = search('hello', restored, 'code');
    expect(results[0].docId).toBe(1);
  });
});
