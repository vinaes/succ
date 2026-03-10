/**
 * Repo Map Generation — Aider-style compact repository overview.
 *
 * Generates a compact text map: file path + exported symbols, one line per file.
 * Uses tree-sitter AST for accurate symbol extraction (13 languages).
 *
 * Output example:
 *   src/lib/auth.ts: hashPassword, verifyToken, createSession
 *   src/lib/config.ts: getConfig, setConfigOverride, SuccConfig
 */

import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { logInfo, logWarn } from '../fault-logger.js';
import { extractSymbolsFromContent } from '../tree-sitter/public.js';
import { EXTENSION_TO_LANGUAGE } from '../tree-sitter/types.js';
import { getProjectRoot } from '../config.js';

// ============================================================================
// Types
// ============================================================================

export interface RepoMapEntry {
  filePath: string;
  symbols: string[];
  lineCount: number;
}

export interface RepoMapResult {
  entries: RepoMapEntry[];
  text: string;
  totalFiles: number;
  totalSymbols: number;
}

// Normalize plural aliases → singular to match SymbolType values
const SYMBOL_ALIAS_MAP: Record<string, string> = {
  functions: 'function',
  methods: 'method',
  classes: 'class',
  interfaces: 'interface',
  types: 'type_alias',
  type_aliases: 'type_alias',
  enums: 'enum',
  structs: 'struct',
  traits: 'trait',
  modules: 'module',
  variables: 'variable',
  constants: 'constant',
};

// ============================================================================
// Generation
// ============================================================================

/**
 * Generate a repo map using tree-sitter AST symbol extraction.
 *
 * @param rootPath - Project root (default: getProjectRoot())
 * @param options - Filter options
 */
export async function generateRepoMap(
  rootPath?: string,
  options?: {
    /** Include patterns (glob-like) */
    include?: string[];
    /** Exclude patterns */
    exclude?: string[];
    /** Max symbols per file (default: 10) */
    maxSymbolsPerFile?: number;
    /**
     * Symbol types to include. Accepted values match tree-sitter SymbolType:
     * 'function', 'method', 'class', 'interface', 'type_alias', 'enum',
     * 'struct', 'trait', 'impl', 'module', 'variable', 'constant'.
     * Plural aliases are also accepted: 'functions'→'function', etc.
     */
    symbolTypes?: string[];
  }
): Promise<RepoMapResult> {
  const root = rootPath ?? getProjectRoot();
  const maxSymbols = options?.maxSymbolsPerFile ?? 10;
  const includeGlobs = options?.include;

  const symbolTypesFilter = options?.symbolTypes?.map((t) => SYMBOL_ALIAS_MAP[t] ?? t);

  // Default exclude patterns
  const defaultExcludes = [
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    '.nuxt',
    'coverage',
    '__pycache__',
    '.pytest_cache',
    'target',
    'vendor',
  ];

  const excludeSet = new Set([...defaultExcludes, ...(options?.exclude ?? [])]);

  // Walk the directory tree — use EXTENSION_TO_LANGUAGE as canonical set
  const entries: RepoMapEntry[] = [];
  const codeExtensions = new Set(Object.keys(EXTENSION_TO_LANGUAGE).map((e) => `.${e}`));

  try {
    await walkDir(root, excludeSet, codeExtensions, entries, maxSymbols, symbolTypesFilter);
  } catch (error) {
    logWarn('repo-map', 'Error walking directory', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Apply include glob filter: only keep files that match at least one pattern
  let filtered = entries;
  if (includeGlobs && includeGlobs.length > 0) {
    filtered = filtered.filter((e) => {
      const relative = path.relative(root, e.filePath).replace(/\\/g, '/');
      return includeGlobs.some((glob) => minimatch(relative, glob, { dot: true, matchBase: true }));
    });
  }

  // Sort by path
  filtered.sort((a, b) => a.filePath.localeCompare(b.filePath));

  // Generate text representation
  const lines = filtered.map((e) => {
    const relative = path.relative(root, e.filePath).replace(/\\/g, '/');
    const symbolStr =
      e.symbols.length > 0 ? `: ${e.symbols.join(', ')}` : ` (${e.lineCount} lines)`;
    return `${relative}${symbolStr}`;
  });

  const totalSymbols = filtered.reduce((sum, e) => sum + e.symbols.length, 0);

  logInfo('repo-map', `Generated repo map: ${filtered.length} files, ${totalSymbols} symbols`);

  return {
    entries: filtered,
    text: lines.join('\n'),
    totalFiles: filtered.length,
    totalSymbols,
  };
}

// ============================================================================
// Tree-sitter symbol extraction per file
// ============================================================================

/**
 * Extract symbols from a file using tree-sitter AST parsing.
 * Delegates to tree-sitter public API. Non-fatal — returns empty on failure.
 */
async function extractFileSymbols(
  content: string,
  filePath: string,
  maxSymbols: number,
  symbolTypesFilter?: string[]
): Promise<string[]> {
  try {
    return await extractSymbolsFromContent(content, filePath, {
      symbolTypes: symbolTypesFilter,
      maxSymbols,
    });
  } catch (error) {
    logWarn('repo-map', `Failed to extract symbols from ${filePath}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// ============================================================================
// Directory walker
// ============================================================================

async function walkDir(
  dir: string,
  excludes: Set<string>,
  extensions: Set<string>,
  entries: RepoMapEntry[],
  maxSymbols: number,
  symbolTypesFilter?: string[]
): Promise<void> {
  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    logWarn('repo-map', `Failed to read directory: ${dir}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const entry of dirEntries) {
    if (excludes.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      logWarn('repo-map', `Skipping symlinked entry: ${fullPath}`);
      continue;
    }

    if (entry.isDirectory()) {
      await walkDir(fullPath, excludes, extensions, entries, maxSymbols, symbolTypesFilter);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!extensions.has(ext)) continue;

      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lineCount = content.split('\n').length;
        const symbols = await extractFileSymbols(content, fullPath, maxSymbols, symbolTypesFilter);

        entries.push({ filePath: fullPath, symbols, lineCount });
      } catch (error) {
        logWarn('repo-map', `Failed to read file: ${fullPath}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
