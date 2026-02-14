/**
 * Shared types for tree-sitter code intelligence infrastructure.
 *
 * These types are used by parser.ts, extractor.ts, chunker-ts.ts,
 * and consumed by chunker.ts, bm25.ts, indexer.ts, etc.
 */

/** Symbol types that tree-sitter can extract from source code */
export type SymbolType =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type_alias'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'impl'
  | 'module'
  | 'variable'
  | 'constant';

/** Information about a single extracted symbol */
export interface SymbolInfo {
  /** Symbol name, e.g. "calculateTotal" */
  name: string;
  /** What kind of symbol this is */
  type: SymbolType;
  /** Signature text, e.g. "(items: Item[]): number" */
  signature?: string;
  /** Doc comment / JSDoc / docstring text */
  docComment?: string;
  /** 0-based start row in the source file */
  startRow: number;
  /** 0-based end row in the source file */
  endRow: number;
  /** 0-based start column */
  startColumn: number;
  /** 0-based end column */
  endColumn: number;
}

/** Extended chunk with tree-sitter metadata */
export interface TreeSitterChunk {
  content: string;
  startLine: number; // 1-based (matches existing Chunk interface)
  endLine: number; // 1-based
  symbolName?: string;
  symbolType?: SymbolType;
  signature?: string;
  docComment?: string;
}

/** Supported language configuration */
export interface LanguageConfig {
  /** Tree-sitter grammar name (e.g. "typescript", "python") */
  grammarName: string;
  /** File extensions that map to this language */
  extensions: string[];
  /** URL suffix for grammar download (typically `tree-sitter-{name}.wasm`) */
  wasmFileName: string;
}

/**
 * Map of file extensions to tree-sitter language names.
 * Extensions should NOT include the leading dot.
 */
export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // TypeScript
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',

  // JavaScript
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',

  // Python
  py: 'python',
  pyw: 'python',
  pyi: 'python',

  // Go
  go: 'go',

  // Rust
  rs: 'rust',

  // Java
  java: 'java',

  // Kotlin
  kt: 'kotlin',
  kts: 'kotlin',

  // C
  c: 'c',
  h: 'c',

  // C++
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',

  // C#
  cs: 'c_sharp',

  // PHP
  php: 'php',

  // Ruby
  rb: 'ruby',
  rake: 'ruby',

  // Swift
  swift: 'swift',

  // Scala
  scala: 'scala',

  // Dart
  dart: 'dart',

  // Shell (bash)
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',

  // Lua
  lua: 'lua',

  // Elixir
  ex: 'elixir',
  exs: 'elixir',

  // Haskell
  hs: 'haskell',

  // SQL
  sql: 'sql',
};

/**
 * Map of tree-sitter language names to their WASM file names.
 * These match the filenames in the tree-sitter-wasms npm package.
 */
export const LANGUAGE_TO_WASM: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  c_sharp: 'tree-sitter-c_sharp.wasm',
  php: 'tree-sitter-php.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  swift: 'tree-sitter-swift.wasm',
  scala: 'tree-sitter-scala.wasm',
  dart: 'tree-sitter-dart.wasm',
  bash: 'tree-sitter-bash.wasm',
  lua: 'tree-sitter-lua.wasm',
  elixir: 'tree-sitter-elixir.wasm',
  haskell: 'tree-sitter-haskell.wasm',
  sql: 'tree-sitter-sql.wasm',
};

/** Languages that have .scm query files for symbol extraction */
export const LANGUAGES_WITH_QUERIES = new Set([
  'typescript',
  'tsx',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'c_sharp',
  'php',
  'ruby',
  'kotlin',
]);

/**
 * Get tree-sitter language name from file extension.
 * Returns undefined if the extension is not recognized.
 */
export function getLanguageForExtension(ext: string): string | undefined {
  // Strip leading dot if present
  const cleanExt = ext.startsWith('.') ? ext.slice(1) : ext;
  return EXTENSION_TO_LANGUAGE[cleanExt.toLowerCase()];
}

/**
 * Get WASM filename for a language.
 * Returns undefined if the language is not recognized.
 */
export function getWasmFileForLanguage(language: string): string | undefined {
  return LANGUAGE_TO_WASM[language];
}
