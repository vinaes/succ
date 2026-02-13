import { describe, it, expect, afterEach } from 'vitest';
import { extractSymbols, extractFunctions, extractClasses, extractIdentifiers, resetQueryCache } from './extractor.js';
import { parseCode, resetParserState } from './parser.js';

afterEach(() => {
  resetQueryCache();
  resetParserState();
});

describe('extractSymbols', () => {
  describe('TypeScript', () => {
    it('extracts function declarations', async () => {
      const code = `
function calculateTotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}
`;
      const tree = await parseCode(code, 'typescript');
      expect(tree).not.toBeNull();

      const symbols = await extractSymbols(tree!, code, 'typescript');
      tree!.delete();

      expect(symbols.length).toBeGreaterThanOrEqual(1);
      const fn = symbols.find(s => s.name === 'calculateTotal');
      expect(fn).toBeDefined();
      expect(fn!.type).toBe('function');
      expect(fn!.signature).toContain('(items: Item[])');
    }, 30_000);

    it('extracts arrow functions assigned to const', async () => {
      const code = `
const greet = (name: string): string => {
  return \`Hello, \${name}\`;
};
`;
      const tree = await parseCode(code, 'typescript');
      expect(tree).not.toBeNull();

      const symbols = await extractSymbols(tree!, code, 'typescript');
      tree!.delete();

      const fn = symbols.find(s => s.name === 'greet');
      expect(fn).toBeDefined();
      expect(fn!.type).toBe('function');
    }, 30_000);

    it('extracts classes and interfaces', async () => {
      const code = `
interface IUser {
  id: number;
  name: string;
}

class UserService {
  private users: IUser[] = [];

  addUser(user: IUser): void {
    this.users.push(user);
  }

  getUser(id: number): IUser | undefined {
    return this.users.find(u => u.id === id);
  }
}
`;
      const tree = await parseCode(code, 'typescript');
      expect(tree).not.toBeNull();

      const symbols = await extractSymbols(tree!, code, 'typescript');
      tree!.delete();

      const iface = symbols.find(s => s.name === 'IUser');
      expect(iface).toBeDefined();
      expect(iface!.type).toBe('interface');

      const cls = symbols.find(s => s.name === 'UserService');
      expect(cls).toBeDefined();
      expect(cls!.type).toBe('class');

      const methods = symbols.filter(s => s.type === 'method');
      expect(methods.length).toBeGreaterThanOrEqual(2);
    }, 30_000);

    it('extracts type aliases and enums', async () => {
      const code = `
type Status = 'active' | 'inactive' | 'pending';

enum Direction {
  Up,
  Down,
  Left,
  Right,
}
`;
      const tree = await parseCode(code, 'typescript');
      expect(tree).not.toBeNull();

      const symbols = await extractSymbols(tree!, code, 'typescript');
      tree!.delete();

      const typeAlias = symbols.find(s => s.name === 'Status');
      expect(typeAlias).toBeDefined();
      expect(typeAlias!.type).toBe('type_alias');

      const enumDef = symbols.find(s => s.name === 'Direction');
      expect(enumDef).toBeDefined();
      expect(enumDef!.type).toBe('type_alias');
    }, 30_000);
  });

  describe('Python', () => {
    it('extracts functions and classes', async () => {
      const code = `
def calculate_total(items):
    """Calculate the total price of items."""
    return sum(item.price for item in items)

class ShoppingCart:
    def __init__(self):
        self.items = []

    def add_item(self, item):
        self.items.append(item)

    def get_total(self):
        return calculate_total(self.items)
`;
      const tree = await parseCode(code, 'python');
      expect(tree).not.toBeNull();

      const symbols = await extractSymbols(tree!, code, 'python');
      tree!.delete();

      const fn = symbols.find(s => s.name === 'calculate_total');
      expect(fn).toBeDefined();
      expect(fn!.type).toBe('function');

      const cls = symbols.find(s => s.name === 'ShoppingCart');
      expect(cls).toBeDefined();
      expect(cls!.type).toBe('class');

      // Methods inside the class
      const methods = symbols.filter(s => s.type === 'function' && s.name !== 'calculate_total');
      expect(methods.length).toBeGreaterThanOrEqual(2);
    }, 30_000);
  });

  describe('Go', () => {
    it('extracts functions, methods, and structs', async () => {
      const code = `
package main

// Server handles HTTP requests
type Server struct {
    port int
    host string
}

func NewServer(host string, port int) *Server {
    return &Server{host: host, port: port}
}

func (s *Server) Start() error {
    return nil
}

type Handler interface {
    Handle(req Request) Response
}
`;
      const tree = await parseCode(code, 'go');
      expect(tree).not.toBeNull();

      const symbols = await extractSymbols(tree!, code, 'go');
      tree!.delete();

      const fn = symbols.find(s => s.name === 'NewServer');
      expect(fn).toBeDefined();
      expect(fn!.type).toBe('function');

      const method = symbols.find(s => s.name === 'Start');
      expect(method).toBeDefined();
      expect(method!.type).toBe('method');

      const structDef = symbols.find(s => s.name === 'Server' && s.type === 'class');
      expect(structDef).toBeDefined();

      const iface = symbols.find(s => s.name === 'Handler');
      expect(iface).toBeDefined();
      expect(iface!.type).toBe('interface');
    }, 30_000);
  });

  describe('Rust', () => {
    it('extracts functions, structs, and traits', async () => {
      const code = `
/// A point in 2D space
struct Point {
    x: f64,
    y: f64,
}

trait Drawable {
    fn draw(&self);
}

impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Point { x, y }
    }

    pub fn distance(&self, other: &Point) -> f64 {
        ((self.x - other.x).powi(2) + (self.y - other.y).powi(2)).sqrt()
    }
}
`;
      const tree = await parseCode(code, 'rust');
      expect(tree).not.toBeNull();

      const symbols = await extractSymbols(tree!, code, 'rust');
      tree!.delete();

      const struct_ = symbols.find(s => s.name === 'Point' && s.type === 'class');
      expect(struct_).toBeDefined();

      const trait_ = symbols.find(s => s.name === 'Drawable');
      expect(trait_).toBeDefined();
      expect(trait_!.type).toBe('interface');

      const fns = symbols.filter(s => s.type === 'function');
      expect(fns.length).toBeGreaterThanOrEqual(1);
    }, 30_000);
  });
});

describe('extractFunctions', () => {
  it('returns only functions and methods', async () => {
    const code = `
class MyClass {
  method() {}
}
function standalone() {}
interface IFoo {}
`;
    const tree = await parseCode(code, 'typescript');
    const fns = await extractFunctions(tree!, code, 'typescript');
    tree!.delete();

    expect(fns.every(f => f.type === 'function' || f.type === 'method')).toBe(true);
    expect(fns.length).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

describe('extractClasses', () => {
  it('returns only classes', async () => {
    const code = `
class MyClass {}
function myFunc() {}
interface IFoo {}
`;
    const tree = await parseCode(code, 'typescript');
    const classes = await extractClasses(tree!, code, 'typescript');
    tree!.delete();

    expect(classes.every(c => c.type === 'class')).toBe(true);
    expect(classes.length).toBe(1);
    expect(classes[0].name).toBe('MyClass');
  }, 30_000);
});

describe('extractIdentifiers', () => {
  it('extracts unique identifiers from AST', async () => {
    const code = `
const userName = "Alice";
function greetUser(name: string): string {
  return "Hello, " + name;
}
`;
    const tree = await parseCode(code, 'typescript');
    expect(tree).not.toBeNull();

    const ids = extractIdentifiers(tree!.rootNode);
    tree!.delete();

    expect(ids).toContain('userName');
    expect(ids).toContain('greetUser');
    expect(ids).toContain('name');
  }, 30_000);
});
