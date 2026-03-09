/**
 * Repo Map Generation — Aider-style compact repository overview.
 *
 * Generates a compact text map: file path + exported symbols, one line per file.
 * Used for routing BEFORE semantic search. Function-level granularity is
 * the retrieval sweet spot (Aider, Agentless, TSP all use this).
 *
 * Output example:
 *   src/lib/auth.ts: hashPassword, verifyToken, createSession
 *   src/lib/config.ts: getConfig, setConfigOverride, SuccConfig
 */

import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logWarn } from '../fault-logger.js';
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

// ============================================================================
// Generation
// ============================================================================

/**
 * Generate a repo map from tree-sitter symbol extraction.
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
    /** Symbol types to include (default: functions, classes, interfaces, type aliases) */
    symbolTypes?: string[];
  }
): Promise<RepoMapResult> {
  const root = rootPath ?? getProjectRoot();
  const maxSymbols = options?.maxSymbolsPerFile ?? 10;

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

  // Walk the directory tree
  const entries: RepoMapEntry[] = [];
  const extensions = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.py',
    '.go',
    '.rs',
    '.rb',
    '.java',
    '.kt',
    '.cs',
    '.cpp',
    '.c',
    '.h',
    '.vue',
    '.svelte',
  ]);

  try {
    await walkDir(root, excludeSet, extensions, entries, maxSymbols);
  } catch (error) {
    logWarn('repo-map', 'Error walking directory', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Sort by path
  entries.sort((a, b) => a.filePath.localeCompare(b.filePath));

  // Generate text representation
  const lines = entries.map((e) => {
    const relative = path.relative(root, e.filePath).replace(/\\/g, '/');
    const symbolStr =
      e.symbols.length > 0 ? `: ${e.symbols.join(', ')}` : ` (${e.lineCount} lines)`;
    return `${relative}${symbolStr}`;
  });

  const totalSymbols = entries.reduce((sum, e) => sum + e.symbols.length, 0);

  logInfo('repo-map', `Generated repo map: ${entries.length} files, ${totalSymbols} symbols`);

  return {
    entries,
    text: lines.join('\n'),
    totalFiles: entries.length,
    totalSymbols,
  };
}

// ============================================================================
// Symbol Extraction (lightweight — no tree-sitter dependency)
// ============================================================================

/**
 * Extract exported symbols from a file using regex patterns.
 * This is a lightweight fallback — tree-sitter extraction is preferred
 * but requires the parser to be loaded.
 */
function extractSymbolsRegex(content: string, ext: string): string[] {
  const symbols: string[] = [];

  // TypeScript/JavaScript exports
  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    const patterns = [
      /export\s+(?:async\s+)?function\s+(\w+)/g,
      /export\s+(?:const|let|var)\s+(\w+)/g,
      /export\s+class\s+(\w+)/g,
      /export\s+interface\s+(\w+)/g,
      /export\s+type\s+(\w+)/g,
      /export\s+enum\s+(\w+)/g,
      /export\s+default\s+(?:class|function)\s+(\w+)/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        symbols.push(match[1]);
      }
    }
  }

  // Python
  if (ext === '.py') {
    const patterns = [/^def\s+(\w+)/gm, /^class\s+(\w+)/gm];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (!match[1].startsWith('_')) symbols.push(match[1]);
      }
    }
  }

  // Go
  if (ext === '.go') {
    const patterns = [/^func\s+(\w+)/gm, /^type\s+(\w+)\s+struct/gm, /^type\s+(\w+)\s+interface/gm];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        // Go exports start with uppercase
        if (match[1][0] === match[1][0].toUpperCase()) {
          symbols.push(match[1]);
        }
      }
    }
  }

  // Rust
  if (ext === '.rs') {
    const patterns = [
      /pub\s+(?:async\s+)?fn\s+(\w+)/g,
      /pub\s+struct\s+(\w+)/g,
      /pub\s+enum\s+(\w+)/g,
      /pub\s+trait\s+(\w+)/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        symbols.push(match[1]);
      }
    }
  }

  return [...new Set(symbols)]; // Deduplicate
}

async function walkDir(
  dir: string,
  excludes: Set<string>,
  extensions: Set<string>,
  entries: RepoMapEntry[],
  maxSymbols: number
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

    if (entry.isDirectory()) {
      await walkDir(fullPath, excludes, extensions, entries, maxSymbols);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!extensions.has(ext)) continue;

      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lineCount = content.split('\n').length;
        const allSymbols = extractSymbolsRegex(content, ext);
        const symbols = allSymbols.slice(0, maxSymbols);

        entries.push({ filePath: fullPath, symbols, lineCount });
      } catch (error) {
        logWarn('repo-map', `Failed to read file: ${fullPath}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
