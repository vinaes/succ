/**
 * Tree-sitter parser infrastructure.
 *
 * Handles:
 * - web-tree-sitter WASM runtime initialization
 * - Lazy grammar download to ~/.succ/grammars/
 * - Parser instance caching per language
 * - Graceful fallback when grammars are unavailable
 */

import fs from 'fs';
import path from 'path';
import { getLanguageForExtension, getWasmFileForLanguage } from './types.js';

// Re-export key types from web-tree-sitter for consumers
import type { Tree, Node, Query, QueryMatch, QueryCapture } from 'web-tree-sitter';
export type { Tree, Node, Query, QueryMatch, QueryCapture };

// State — lazily initialized
let ParserClass: typeof import('web-tree-sitter').Parser | null = null;
let LanguageClass: typeof import('web-tree-sitter').Language | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;

/** Cache of loaded Language objects by language name */
const languageCache = new Map<string, import('web-tree-sitter').Language>();

/** Per-language parser instances (avoids race conditions with shared parser) */
const parserPool = new Map<string, import('web-tree-sitter').Parser>();

/**
 * Grammar CDN sources — tried in order until one succeeds.
 * All sources must provide grammars built with dylink.0 (ABI ≥ 14).
 */
interface GrammarCdnSource {
  baseUrl: string;
  /** Transform our canonical wasm filename for this CDN's naming convention */
  transformName: (wasmFileName: string) => string;
}

const GRAMMAR_CDN_SOURCES: GrammarCdnSource[] = [
  {
    // @vscode/tree-sitter-wasm — 16 languages, dylink.0
    baseUrl: 'https://cdn.jsdelivr.net/npm/@vscode/tree-sitter-wasm@0.3.0/wasm',
    transformName: (name) => name.replace(/_/g, '-'), // c_sharp → c-sharp
  },
  {
    // @repomix/tree-sitter-wasms — 17 languages, dylink.0
    baseUrl: 'https://cdn.jsdelivr.net/npm/@repomix/tree-sitter-wasms@0.1.16/out',
    transformName: (name) => name, // uses same c_sharp naming as us
  },
];

/**
 * Get the grammars directory path.
 * Defaults to ~/.succ/grammars/
 */
export function getGrammarsDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.succ', 'grammars');
}

/**
 * Initialize the web-tree-sitter runtime.
 * This must be called once before any parsing. Safe to call multiple times.
 */
export async function initTreeSitter(): Promise<boolean> {
  if (initialized) return true;

  if (initPromise) {
    await initPromise;
    return initialized;
  }

  initPromise = (async () => {
    try {
      // Dynamic import — web-tree-sitter is an ESM module with named exports
      const mod = await import('web-tree-sitter');
      ParserClass = mod.Parser;
      LanguageClass = mod.Language;

      // Locate the WASM file shipped with web-tree-sitter
      const wasmPath = getTreeSitterWasmPath();

      await ParserClass.init({
        locateFile: () => wasmPath,
      });

      initialized = true;
    } catch {
      initialized = false;
    }
  })();

  await initPromise;
  return initialized;
}

/**
 * Find the web-tree-sitter.wasm file path.
 * It ships inside the web-tree-sitter npm package.
 */
function getTreeSitterWasmPath(): string {
  // ESM-compatible: use import.meta.url to resolve relative to this file
  try {
    const thisDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
    const fromThisFile = path.join(thisDir, '..', '..', '..', 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm');
    if (fs.existsSync(fromThisFile)) return fromThisFile;
  } catch {
    // import.meta.url may not resolve correctly in all environments
  }

  // Fallback: look relative to cwd node_modules
  const fromCwd = path.join(process.cwd(), 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm');
  if (fs.existsSync(fromCwd)) return fromCwd;

  // Last resort — let emscripten try to find it
  return 'web-tree-sitter.wasm';
}

/**
 * Get (or create) a parser for the given language.
 * Downloads the grammar WASM if not cached locally.
 *
 * @returns Parser instance with language set, or null if unavailable
 */
export async function getParserForLanguage(language: string): Promise<import('web-tree-sitter').Parser | null> {
  if (!initialized) {
    const ok = await initTreeSitter();
    if (!ok) return null;
  }

  const lang = await loadLanguage(language);
  if (!lang) return null;

  // Use per-language parser to avoid race conditions with concurrent parses
  let parser = parserPool.get(language);
  if (!parser && ParserClass) {
    parser = new ParserClass();
    parser.setLanguage(lang);
    parserPool.set(language, parser);
  }
  if (!parser) return null;

  return parser;
}

/**
 * Get a parser for a file by its path (uses extension to detect language).
 *
 * @returns [parser, languageName] tuple, or [null, undefined] if unavailable
 */
export async function getParserForFile(
  filePath: string,
): Promise<[import('web-tree-sitter').Parser | null, string | undefined]> {
  const ext = filePath.split('.').pop() || '';
  const language = getLanguageForExtension(ext);
  if (!language) return [null, undefined];

  const parser = await getParserForLanguage(language);
  return [parser, language];
}

/**
 * Load a tree-sitter Language object, downloading its grammar if needed.
 * Results are cached in memory.
 */
export async function loadLanguage(language: string): Promise<import('web-tree-sitter').Language | null> {
  // Check memory cache
  const cached = languageCache.get(language);
  if (cached) return cached;

  // Ensure runtime is initialized
  if (!initialized) {
    const ok = await initTreeSitter();
    if (!ok) return null;
  }

  if (!LanguageClass) return null;

  const wasmFileName = getWasmFileForLanguage(language);
  if (!wasmFileName) return null;

  // Check if grammar is cached on disk
  const grammarsDir = getGrammarsDir();
  const localPath = path.join(grammarsDir, wasmFileName);

  if (fs.existsSync(localPath)) {
    try {
      const lang = await LanguageClass.load(localPath);
      languageCache.set(language, lang);
      return lang;
    } catch {
      // Corrupted file — delete and re-download
      try { fs.unlinkSync(localPath); } catch {
        // intentional
      }
    }
  }

  // Try to download grammar
  const downloaded = await downloadGrammar(wasmFileName, localPath);
  if (!downloaded) return null;

  try {
    const lang = await LanguageClass.load(localPath);
    languageCache.set(language, lang);
    return lang;
  } catch {
    return null;
  }
}

/**
 * Try to find the grammar WASM in locally installed packages.
 * Checks @vscode/tree-sitter-wasm and @repomix/tree-sitter-wasms.
 * Returns the path if found, null otherwise.
 */
function findLocalGrammar(wasmFileName: string): string | null {
  const vscodeFileName = wasmFileName.replace(/_/g, '-');

  const roots = [process.cwd()];
  try {
    const thisDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
    roots.push(path.resolve(thisDir, '..', '..', '..'));
  } catch {
    // import.meta.url may not work in all contexts
  }

  for (const root of roots) {
    const nm = path.join(root, 'node_modules');
    const candidates = [
      path.join(nm, '@vscode', 'tree-sitter-wasm', 'wasm', vscodeFileName),
      path.join(nm, '@repomix', 'tree-sitter-wasms', 'out', wasmFileName),
      path.join(nm, 'tree-sitter-wasms', 'out', wasmFileName),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Download a grammar WASM file from CDN.
 * Tries jsdelivr CDN with fallback.
 * Also checks for locally installed tree-sitter-wasms package first.
 * Saves to ~/.succ/grammars/{filename}.
 */
async function downloadGrammar(
  wasmFileName: string,
  destPath: string,
): Promise<boolean> {
  // Ensure grammars directory exists
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });

  // Strategy 1: Copy from locally installed tree-sitter-wasms package
  const localPath = findLocalGrammar(wasmFileName);
  if (localPath) {
    try {
      fs.copyFileSync(localPath, destPath);
      return true;
    } catch {
      // Fall through to CDN download
    }
  }

  // Strategy 2: Download from CDN (try each source in order)
  for (const source of GRAMMAR_CDN_SOURCES) {
    const remoteFileName = source.transformName(wasmFileName);
    const url = `${source.baseUrl}/${remoteFileName}`;
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) continue;

      const buffer = Buffer.from(await response.arrayBuffer());

      // Validate WASM magic bytes (\0asm)
      if (buffer.length < 4 || buffer[0] !== 0x00 || buffer[1] !== 0x61 || buffer[2] !== 0x73 || buffer[3] !== 0x6d) {
        continue; // Not a valid WASM file
      }

      fs.writeFileSync(destPath, buffer);
      return true;
    } catch {
      // Try next source
      continue;
    }
  }

  return false;
}

/**
 * Parse source code using tree-sitter.
 *
 * @param code - Source code string
 * @param language - Tree-sitter language name (e.g. "typescript", "python")
 * @returns Parse tree, or null if parser/grammar unavailable
 */
export async function parseCode(code: string, language: string): Promise<Tree | null> {
  const parser = await getParserForLanguage(language);
  if (!parser) return null;

  try {
    return parser.parse(code);
  } catch {
    return null;
  }
}

/**
 * Parse a file by its path.
 *
 * @returns [tree, languageName] tuple, or [null, undefined] if unavailable
 */
export async function parseFile(filePath: string, content: string): Promise<[Tree | null, string | undefined]> {
  const [parser, language] = await getParserForFile(filePath);
  if (!parser || !language) return [null, undefined];

  try {
    const tree = parser.parse(content);
    return [tree, language];
  } catch {
    return [null, undefined];
  }
}

/**
 * Check if a grammar is available locally (already downloaded).
 */
export function isGrammarCached(language: string): boolean {
  const wasmFileName = getWasmFileForLanguage(language);
  if (!wasmFileName) return false;
  return fs.existsSync(path.join(getGrammarsDir(), wasmFileName));
}

/**
 * List all locally cached grammars.
 */
export function listCachedGrammars(): string[] {
  const dir = getGrammarsDir();
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.wasm'))
    .map(f => f.replace('tree-sitter-', '').replace('.wasm', ''));
}

/**
 * Clear all cached grammars.
 */
export function clearGrammarCache(): void {
  const dir = getGrammarsDir();
  if (!fs.existsSync(dir)) return;

  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.wasm')) {
      fs.unlinkSync(path.join(dir, file));
    }
  }
}

/**
 * Reset the parser state (useful for testing).
 */
export function resetParserState(): void {
  for (const parser of parserPool.values()) {
    try { parser.delete(); } catch {
      // intentional
    }
  }
  parserPool.clear();
  languageCache.clear();
  initialized = false;
  initPromise = null;
  ParserClass = null;
  LanguageClass = null;
}
