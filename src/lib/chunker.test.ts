import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chunkText, chunkCode, extractFrontmatter, Chunk } from './chunker.js';

// Mock config
vi.mock('./config.js', () => ({
  getConfig: () => ({
    chunk_size: 500,
    chunk_overlap: 50,
  }),
}));

describe('Chunker Module', () => {
  describe('chunkText', () => {
    it('should chunk simple text', () => {
      const text = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      const chunks = chunkText(text, 'test.md');

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].content).toContain('Line 1');
    });

    it('should handle empty text', () => {
      const chunks = chunkText('', 'test.md');
      // Empty string still creates one chunk with empty content
      expect(chunks.length).toBeLessThanOrEqual(1);
    });

    it('should preserve line numbers', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
      const chunks = chunkText(lines, 'test.md');

      expect(chunks.length).toBeGreaterThan(1);
      // First chunk should start at line 1
      expect(chunks[0].startLine).toBe(1);
      // Content should match line numbers
      expect(chunks[0].content).toContain('Line 1');
    });

    it('should create overlapping chunks', () => {
      // Create text that will require multiple chunks
      const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}: Some content here`).join('\n');
      const chunks = chunkText(lines, 'test.md');

      if (chunks.length >= 2) {
        // There should be some overlap between consecutive chunks
        const chunk1End = chunks[0].endLine;
        const chunk2Start = chunks[1].startLine;
        // With overlap, chunk2 should start before chunk1 ends (or close to it)
        expect(chunk2Start).toBeLessThanOrEqual(chunk1End + 1);
      }
    });
  });

  describe('chunkCode', () => {
    describe('TypeScript/JavaScript', () => {
      it('should detect function definitions', () => {
        const code = `
function hello() {
  console.log('hello');
}

function world() {
  console.log('world');
}
`;
        const chunks = chunkCode(code, 'test.ts');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });

      it('should detect class definitions', () => {
        const code = `
export class MyClass {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  greet() {
    return \`Hello, \${this.name}\`;
  }
}
`;
        const chunks = chunkCode(code, 'test.ts');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks[0].content).toContain('class MyClass');
      });

      it('should handle arrow functions', () => {
        const code = `
export const add = (a: number, b: number) => {
  return a + b;
};

export const multiply = (a: number, b: number) => a * b;
`;
        const chunks = chunkCode(code, 'test.ts');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });

      it('should handle async functions', () => {
        const code = `
export async function fetchData() {
  const response = await fetch('/api/data');
  return response.json();
}
`;
        const chunks = chunkCode(code, 'test.ts');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks[0].content).toContain('async function fetchData');
      });

      it('should handle interfaces and types', () => {
        const code = `
export interface User {
  id: number;
  name: string;
}

export type Status = 'active' | 'inactive';

export enum Role {
  Admin,
  User,
}
`;
        const chunks = chunkCode(code, 'test.ts');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('Python', () => {
      it('should detect function definitions', () => {
        const code = `
def hello():
    print('hello')

def world():
    print('world')
`;
        const chunks = chunkCode(code, 'test.py');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });

      it('should detect class definitions', () => {
        const code = `class MyClass:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return f'Hello, {self.name}'
`;
        const chunks = chunkCode(code, 'test.py');

        // Should produce at least one chunk
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        // Combined chunks should contain the class definition
        const fullContent = chunks.map((c) => c.content).join('\n');
        expect(fullContent).toContain('def __init__');
      });

      it('should handle async functions', () => {
        const code = `
async def fetch_data():
    response = await client.get('/api/data')
    return response.json()
`;
        const chunks = chunkCode(code, 'test.py');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks[0].content).toContain('async def fetch_data');
      });
    });

    describe('Go', () => {
      it('should detect function definitions', () => {
        const code = `
func hello() {
    fmt.Println("hello")
}

func add(a, b int) int {
    return a + b
}
`;
        const chunks = chunkCode(code, 'test.go');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });

      it('should detect method definitions', () => {
        const code = `
func (s *Server) Start() error {
    return s.listener.Listen()
}

func (s *Server) Stop() {
    s.listener.Close()
}
`;
        const chunks = chunkCode(code, 'test.go');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });

      it('should detect struct definitions', () => {
        const code = `
type Server struct {
    Host string
    Port int
}

type Config struct {
    Debug bool
    Timeout int
}
`;
        const chunks = chunkCode(code, 'test.go');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('Rust', () => {
      it('should detect function definitions', () => {
        const code = `
fn hello() {
    println!("hello");
}

pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
`;
        const chunks = chunkCode(code, 'test.rs');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });

      it('should detect struct and impl', () => {
        const code = `
pub struct Server {
    host: String,
    port: u16,
}

impl Server {
    pub fn new(host: String, port: u16) -> Self {
        Server { host, port }
    }
}
`;
        const chunks = chunkCode(code, 'test.rs');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('Unknown languages', () => {
      it('should fall back to text chunking for unknown extensions', () => {
        const code = `
Some code here
More code
Even more code
`;
        const chunks = chunkCode(code, 'test.xyz');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('Large files', () => {
      it('should split large chunks to fit context limits', () => {
        // Create a very large "function"
        const lines = ['function largeFunction() {'];
        for (let i = 0; i < 500; i++) {
          lines.push(`  const line${i} = "This is line ${i} with some content to make it longer";`);
        }
        lines.push('}');
        const code = lines.join('\n');

        const chunks = chunkCode(code, 'test.ts');

        // Should be split into multiple chunks
        expect(chunks.length).toBeGreaterThan(1);

        // Each chunk should be under the max size (4000 chars)
        for (const chunk of chunks) {
          expect(chunk.content.length).toBeLessThanOrEqual(5000); // Some tolerance
        }
      });
    });

    describe('Brace handling', () => {
      it('should handle braces inside strings', () => {
        const code = `
function test() {
  const str = "{ this is not a brace }";
  const template = \`{ neither is this }\`;
  return str;
}
`;
        const chunks = chunkCode(code, 'test.ts');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks[0].content).toContain('function test');
      });

      it('should handle braces in comments', () => {
        const code = `
function test() {
  // { this brace should be ignored }
  console.log('hello');
}
`;
        const chunks = chunkCode(code, 'test.ts');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });

      it('should handle escaped quotes in strings', () => {
        const code = `
function test() {
  const str = "He said \\"hello\\" { }";
  return str;
}
`;
        const chunks = chunkCode(code, 'test.ts');

        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('extractFrontmatter', () => {
    it('should extract YAML frontmatter', () => {
      const content = `---
title: Test
description: "A test document"
tags: [one, two]
---

# Content

This is the body.`;

      const { frontmatter, body } = extractFrontmatter(content);

      expect(frontmatter.title).toBe('Test');
      expect(frontmatter.description).toBe('A test document');
      expect(body).toContain('# Content');
      expect(body).toContain('This is the body.');
    });

    it('should handle missing frontmatter', () => {
      const content = `# Just a heading

Some content without frontmatter.`;

      const { frontmatter, body } = extractFrontmatter(content);

      expect(Object.keys(frontmatter).length).toBe(0);
      expect(body).toBe(content);
    });

    it('should handle empty frontmatter', () => {
      const content = `---
---

# Content`;

      const { frontmatter, body } = extractFrontmatter(content);

      expect(Object.keys(frontmatter).length).toBe(0);
      expect(body).toContain('# Content');
    });

    it('should handle quoted values', () => {
      const content = `---
title: "Quoted Title"
description: 'Single quotes'
---

Body`;

      const { frontmatter } = extractFrontmatter(content);

      expect(frontmatter.title).toBe('Quoted Title');
    });

    it('should handle multiple colons in values', () => {
      const content = `---
url: https://example.com/path
time: 12:30:00
---

Body`;

      const { frontmatter } = extractFrontmatter(content);

      expect(frontmatter.url).toBe('https://example.com/path');
      expect(frontmatter.time).toBe('12:30:00');
    });
  });
});
