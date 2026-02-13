import { describe, it, expect, afterEach } from 'vitest';
import {
  initTreeSitter,
  parseCode,
  getGrammarsDir,
  isGrammarCached,
  listCachedGrammars,
  resetParserState,
  getParserForFile,
  getParserForLanguage,
  loadLanguage,
} from './parser.js';
import {
  getLanguageForExtension,
  getWasmFileForLanguage,
  EXTENSION_TO_LANGUAGE,
  LANGUAGE_TO_WASM,
} from './types.js';

afterEach(() => {
  resetParserState();
});

describe('types', () => {
  it('maps common extensions to languages', () => {
    expect(getLanguageForExtension('ts')).toBe('typescript');
    expect(getLanguageForExtension('tsx')).toBe('tsx');
    expect(getLanguageForExtension('js')).toBe('javascript');
    expect(getLanguageForExtension('py')).toBe('python');
    expect(getLanguageForExtension('go')).toBe('go');
    expect(getLanguageForExtension('rs')).toBe('rust');
    expect(getLanguageForExtension('java')).toBe('java');
    expect(getLanguageForExtension('cpp')).toBe('cpp');
    expect(getLanguageForExtension('c')).toBe('c');
    expect(getLanguageForExtension('cs')).toBe('c_sharp');
    expect(getLanguageForExtension('php')).toBe('php');
    expect(getLanguageForExtension('rb')).toBe('ruby');
    expect(getLanguageForExtension('kt')).toBe('kotlin');
  });

  it('strips leading dot from extensions', () => {
    expect(getLanguageForExtension('.ts')).toBe('typescript');
    expect(getLanguageForExtension('.py')).toBe('python');
  });

  it('returns undefined for unknown extensions', () => {
    expect(getLanguageForExtension('xyz')).toBeUndefined();
    expect(getLanguageForExtension('bmp')).toBeUndefined();
  });

  it('maps languages to WASM filenames', () => {
    expect(getWasmFileForLanguage('typescript')).toBe('tree-sitter-typescript.wasm');
    expect(getWasmFileForLanguage('python')).toBe('tree-sitter-python.wasm');
    expect(getWasmFileForLanguage('unknown')).toBeUndefined();
  });

  it('has consistent extension→language→wasm chain', () => {
    for (const [ext, lang] of Object.entries(EXTENSION_TO_LANGUAGE)) {
      const wasm = LANGUAGE_TO_WASM[lang];
      expect(wasm, `Missing WASM mapping for ${lang} (ext: .${ext})`).toBeDefined();
    }
  });
});

describe('parser initialization', () => {
  it('initializes web-tree-sitter runtime', async () => {
    const ok = await initTreeSitter();
    expect(ok).toBe(true);
  });

  it('is idempotent', async () => {
    const ok1 = await initTreeSitter();
    const ok2 = await initTreeSitter();
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
  });
});

describe('language loading', () => {
  it('loads typescript grammar', async () => {
    const lang = await loadLanguage('typescript');
    expect(lang).not.toBeNull();
  }, 30_000); // Allow time for download

  it('caches loaded languages', async () => {
    const lang1 = await loadLanguage('typescript');
    const lang2 = await loadLanguage('typescript');
    expect(lang1).toBe(lang2); // Same object reference
  }, 30_000);

  it('returns null for unknown language', async () => {
    const lang = await loadLanguage('nonexistent_language_xyz');
    expect(lang).toBeNull();
  });
});

describe('parsing', () => {
  it('parses TypeScript code', async () => {
    const tree = await parseCode(`
function hello(name: string): string {
  return 'Hello, ' + name;
}
    `, 'typescript');

    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('program');
    expect(tree!.rootNode.childCount).toBeGreaterThan(0);
    tree!.delete();
  }, 30_000);

  it('parses Python code', async () => {
    const tree = await parseCode(`
def hello(name):
    return f"Hello, {name}"

class Greeter:
    def __init__(self, name):
        self.name = name
    `, 'python');

    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('module');
    tree!.delete();
  }, 30_000);

  it('returns null for unsupported language', async () => {
    const tree = await parseCode('some code', 'nonexistent_xyz');
    expect(tree).toBeNull();
  });
});

describe('getParserForFile', () => {
  it('returns parser and language for .ts file', async () => {
    const [parser, lang] = await getParserForFile('src/index.ts');
    expect(parser).not.toBeNull();
    expect(lang).toBe('typescript');
  }, 30_000);

  it('returns null for unknown extension', async () => {
    const [parser, lang] = await getParserForFile('file.bmp');
    expect(parser).toBeNull();
    expect(lang).toBeUndefined();
  });
});

describe('grammar management', () => {
  it('getGrammarsDir returns path with .succ/grammars', () => {
    const dir = getGrammarsDir();
    expect(dir).toContain('.succ');
    expect(dir).toContain('grammars');
  });

  it('listCachedGrammars returns array', () => {
    const grammars = listCachedGrammars();
    expect(Array.isArray(grammars)).toBe(true);
  });
});
