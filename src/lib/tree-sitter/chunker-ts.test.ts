import { describe, it, expect, afterEach } from 'vitest';
import { chunkCodeWithTreeSitter } from './chunker-ts.js';
import { resetParserState } from './parser.js';
import { resetQueryCache } from './extractor.js';

afterEach(() => {
  resetQueryCache();
  resetParserState();
});

describe('chunkCodeWithTreeSitter', () => {
  it('chunks TypeScript with symbol metadata', async () => {
    const code = `
import { readFile } from 'fs';

/**
 * Calculate total price
 */
function calculateTotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}

export class ShoppingCart {
  private items: Item[] = [];

  addItem(item: Item): void {
    this.items.push(item);
  }

  getTotal(): number {
    return calculateTotal(this.items);
  }
}

const DEFAULT_TAX = 0.08;
`;
    const chunks = await chunkCodeWithTreeSitter(code, 'cart.ts');
    expect(chunks).not.toBeNull();
    expect(chunks!.length).toBeGreaterThanOrEqual(2);

    // Check that function chunk has metadata
    const fnChunk = chunks!.find((c) => c.symbolName === 'calculateTotal');
    expect(fnChunk).toBeDefined();
    expect(fnChunk!.symbolType).toBe('function');

    // Check that class chunk has metadata
    const classChunk = chunks!.find((c) => c.symbolName === 'ShoppingCart');
    expect(classChunk).toBeDefined();
    expect(classChunk!.symbolType).toBe('class');

    // Every chunk should have valid line numbers
    for (const chunk of chunks!) {
      expect(chunk.startLine).toBeGreaterThan(0);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('chunks Python code', async () => {
    const code = `
import os

def read_config(path):
    """Read configuration from file."""
    with open(path) as f:
        return json.load(f)

class Config:
    def __init__(self, path):
        self.data = read_config(path)

    def get(self, key, default=None):
        return self.data.get(key, default)
`;
    const chunks = await chunkCodeWithTreeSitter(code, 'config.py');
    expect(chunks).not.toBeNull();
    expect(chunks!.length).toBeGreaterThanOrEqual(2);

    const fnChunk = chunks!.find((c) => c.symbolName === 'read_config');
    expect(fnChunk).toBeDefined();
    expect(fnChunk!.symbolType).toBe('function');

    const classChunk = chunks!.find((c) => c.symbolName === 'Config');
    expect(classChunk).toBeDefined();
    expect(classChunk!.symbolType).toBe('class');
  }, 30_000);

  it('chunks Go code', async () => {
    const code = `
package server

// Server represents an HTTP server
type Server struct {
    Port int
    Host string
}

// NewServer creates a new server instance
func NewServer(host string, port int) *Server {
    return &Server{Host: host, Port: port}
}

func (s *Server) Start() error {
    return http.ListenAndServe(
        fmt.Sprintf("%s:%d", s.Host, s.Port),
        nil,
    )
}
`;
    const chunks = await chunkCodeWithTreeSitter(code, 'server.go');
    expect(chunks).not.toBeNull();
    expect(chunks!.length).toBeGreaterThanOrEqual(2);

    const fnChunk = chunks!.find((c) => c.symbolName === 'NewServer');
    expect(fnChunk).toBeDefined();
    expect(fnChunk!.symbolType).toBe('function');
  }, 30_000);

  it('returns null for unsupported file types', async () => {
    const chunks = await chunkCodeWithTreeSitter('some content', 'data.bmp');
    expect(chunks).toBeNull();
  });

  it('handles empty files', async () => {
    const chunks = await chunkCodeWithTreeSitter('', 'empty.ts');
    expect(chunks).not.toBeNull();
    // Empty file may produce no chunks or one empty chunk
  }, 30_000);

  it('splits large chunks', async () => {
    // Create a file with a very large function
    const largeBody = Array.from(
      { length: 200 },
      (_, i) => `  const line${i} = "${`x`.repeat(20)}";`
    ).join('\n');
    const code = `function bigFunction() {\n${largeBody}\n}`;

    const chunks = await chunkCodeWithTreeSitter(code, 'big.ts');
    expect(chunks).not.toBeNull();

    // The first sub-chunk should have the metadata
    if (chunks!.length > 1) {
      expect(chunks![0].symbolName).toBe('bigFunction');
    }

    // Each chunk should be under the limit
    for (const chunk of chunks!) {
      expect(chunk.content.length).toBeLessThanOrEqual(4200); // Allow small overshoot
    }
  }, 30_000);

  it('preserves chunk ordering', async () => {
    const code = `
function first() { return 1; }
function second() { return 2; }
function third() { return 3; }
`;
    const chunks = await chunkCodeWithTreeSitter(code, 'order.ts');
    expect(chunks).not.toBeNull();

    // Chunks should be in order by startLine
    for (let i = 1; i < chunks!.length; i++) {
      expect(chunks![i].startLine).toBeGreaterThanOrEqual(chunks![i - 1].startLine);
    }
  }, 30_000);
});
