import { describe, it, expect } from 'vitest';
import {
  searchPatternInContent,
  searchPatternInFiles,
  formatPatternResults,
  getSupportedLanguages,
  isAstGrepAvailable,
} from './ast-grep-search.js';

describe('ast-grep-search', () => {
  describe('isAstGrepAvailable', () => {
    it('should return true when @ast-grep/napi is installed', async () => {
      expect(await isAstGrepAvailable()).toBe(true);
    });
  });

  describe('getSupportedLanguages', () => {
    it('should return built-in + dynamic languages, sorted', async () => {
      // getSupportedLanguages() is synchronous and reads from the registeredDynamicLangs
      // set, which is only populated as a side-effect of getAstGrep() (called internally
      // by isAstGrepAvailable). We must await initialization before calling it.
      await isAstGrepAvailable();
      const langs = getSupportedLanguages();
      expect(langs.length).toBeGreaterThan(10);
      expect(langs).toContain('TypeScript');
      expect(langs).toContain('JavaScript');
      expect(langs).toContain('python');
      expect(langs).toContain('go');
      expect(langs).toContain('rust');
      expect(langs).toContain('java');
      expect(langs).toEqual([...langs].sort());
    });
  });

  describe('searchPatternInContent', () => {
    it('should find console.log calls with metavar extraction', async () => {
      const code = `
function foo() {
  console.log("hello");
  console.log("world", 42);
}
`;
      const matches = await searchPatternInContent(code, 'test.ts', 'console.log($$$ARGS)');
      expect(matches).toHaveLength(2);
      expect(matches[0].text).toContain('console.log("hello")');
      expect(matches[0].node_kind).toBeTruthy();
      expect(matches[0].start_line).toBeGreaterThan(0);
      expect(matches[0].file_path).toBe('test.ts');
      // Verify variadic metavar extraction for $$$ARGS
      expect(matches[0].metavars.ARGS).toBeDefined();
      expect(matches[0].metavars.ARGS).toBe('"hello"');
      expect(matches[1].metavars.ARGS).toBeDefined();
      expect(matches[1].metavars.ARGS).toBe('"world", 42');
    });

    it('should find await expressions', async () => {
      const code = `
async function bar() {
  const x = await fetch("url");
  await doSomething();
}
`;
      const matches = await searchPatternInContent(code, 'test.ts', 'await $EXPR');
      expect(matches).toHaveLength(2);
      expect(matches[0].metavars.EXPR).toBeDefined();
    });

    it('should find try-catch blocks', async () => {
      const code = `
try { doStuff(); } catch (e) { logError(e); }
try { doMore(); } catch (e) { handle(e); }
`;
      const matches = await searchPatternInContent(
        code,
        'test.ts',
        'try { $$$BODY } catch ($ERR) { $$$HANDLER }'
      );
      expect(matches.length).toBe(2);
    });

    it('should find return statements with metavar', async () => {
      const code = 'function sum(a: number, b: number) { return a + b; }';
      const matches = await searchPatternInContent(code, 'test.ts', 'return $EXPR');
      expect(matches).toHaveLength(1);
      expect(matches[0].metavars.EXPR).toBe('a + b');
    });

    it('should handle unsupported file extensions gracefully', async () => {
      const matches = await searchPatternInContent('some content', 'file.xyz', '$EXPR');
      expect(matches).toEqual([]);
    });

    it('should throw DependencyError for empty pattern', async () => {
      const code = 'const x = 1;\n';
      // Empty pattern triggers "No AST root is detected" error inside ast-grep
      await expect(searchPatternInContent(code, 'test.ts', '')).rejects.toThrow(
        /Pattern search failed/
      );
    });

    it('should detect language from .js extension', async () => {
      const jsCode = 'function hello() { console.log("hi"); }\n';
      const matches = await searchPatternInContent(jsCode, 'test.js', 'console.log($$$ARGS)');
      expect(matches).toHaveLength(1);
    });

    it('should search Python via dynamic language registration', async () => {
      const pyCode = 'def hello():\n    print("hi")\n';
      const matches = await searchPatternInContent(pyCode, 'test.py', 'print($$$ARGS)');
      expect(matches).toHaveLength(1);
      expect(matches[0].text).toContain('print("hi")');
    });

    it('should search Go via dynamic language registration', async () => {
      const goCode = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n}\n';
      const matches = await searchPatternInContent(goCode, 'main.go', 'fmt.Println($$$ARGS)');
      expect(matches).toHaveLength(1);
      expect(matches[0].text).toContain('fmt.Println');
    });

    it('should search Rust via dynamic language registration', async () => {
      const rsCode = 'fn main() {\n    println!("hello");\n}\n';
      const matches = await searchPatternInContent(rsCode, 'main.rs', 'println!($$$ARGS)');
      expect(matches).toHaveLength(1);
    });

    it('should search Java via dynamic language registration', async () => {
      const javaCode =
        'public class Main {\n    public static void main(String[] args) {\n        System.out.println("hello");\n    }\n}\n';
      const matches = await searchPatternInContent(
        javaCode,
        'Main.java',
        'System.out.println($$$ARGS)'
      );
      expect(matches).toHaveLength(1);
    });

    it('should search Bash via dynamic language registration', async () => {
      const bashCode = '#!/bin/bash\necho "hello world"\necho "goodbye"\n';
      const matches = await searchPatternInContent(bashCode, 'script.sh', 'echo $$$ARGS');
      expect(matches).toHaveLength(2);
    });

    it('should return 1-indexed line numbers', async () => {
      const code = 'const x = 1;\nconst y = 2;\nconst z = 3;\n';
      const matches = await searchPatternInContent(code, 'test.ts', 'const $NAME = $VALUE');
      expect(matches.length).toBe(3);
      expect(matches[0].start_line).toBe(1);
      expect(matches[1].start_line).toBe(2);
      expect(matches[2].start_line).toBe(3);
    });
  });

  describe('searchPatternInFiles', () => {
    it('should search across multiple files', async () => {
      const files = [
        { filePath: 'a.ts', content: 'console.log("a");' },
        { filePath: 'b.ts', content: 'console.log("b");' },
        { filePath: 'c.xyz', content: 'console.log("c")' },
      ];
      const matches = await searchPatternInFiles(files, 'console.log($$$ARGS)');
      expect(matches).toHaveLength(2);
      expect(matches[0].file_path).toBe('a.ts');
      expect(matches[1].file_path).toBe('b.ts');
    });

    it('should respect limit', async () => {
      const files = Array.from({ length: 20 }, (_, i) => ({
        filePath: `file${i}.ts`,
        content: 'console.log("x");',
      }));
      const matches = await searchPatternInFiles(files, 'console.log($$$ARGS)', undefined, 5);
      expect(matches).toHaveLength(5);
    });
  });

  describe('formatPatternResults', () => {
    const sampleMatches = [
      {
        text: 'console.log("hello")',
        file_path: 'src/app.ts',
        start_line: 10,
        end_line: 10,
        start_column: 2,
        node_kind: 'call_expression',
        metavars: { ARGS: '"hello"' },
      },
    ];

    it('should format lean output', () => {
      const out = formatPatternResults(sampleMatches, 'lean');
      expect(out).toContain('src/app.ts:10-10');
      expect(out).toContain('call_expression');
      expect(out).toContain('$ARGS="hello"');
    });

    it('should format signatures output', () => {
      const out = formatPatternResults(sampleMatches, 'signatures');
      expect(out).toContain('src/app.ts:10');
      expect(out).toContain('call_expression');
    });

    it('should format full output with code blocks', () => {
      const out = formatPatternResults(sampleMatches, 'full');
      expect(out).toContain('```');
      expect(out).toContain('console.log("hello")');
      expect(out).toContain('Metavariables');
    });

    it('should handle empty results', () => {
      expect(formatPatternResults([])).toBe('No structural matches found.');
    });
  });
});
