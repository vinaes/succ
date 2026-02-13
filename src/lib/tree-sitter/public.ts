/**
 * High-level tree-sitter API for external consumers (plugins, integrations).
 *
 * Wraps low-level parser + extractor into single-call functions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseCode } from './parser.js';
import { extractSymbols } from './extractor.js';
import { getLanguageForExtension } from './types.js';
import type { SymbolInfo, SymbolType } from './types.js';

export interface ExtractSymbolsOptions {
  /** Filter by symbol type */
  type?: SymbolType | 'all';
}

export interface ExtractSymbolsResult {
  symbols: SymbolInfo[];
  language: string;
  file: string;
}

/**
 * Extract AST symbols from a source file.
 *
 * Single-call API: reads file, detects language, parses with tree-sitter,
 * extracts symbols, and cleans up. Supports 13 languages.
 *
 * @param filePath - Absolute or relative path to the source file
 * @param options - Optional filters (type)
 * @returns Extracted symbols with metadata
 * @throws Error if file not found, unsupported language, or parse failure
 */
export async function extractSymbolsFromFile(
  filePath: string,
  options: ExtractSymbolsOptions = {},
): Promise<ExtractSymbolsResult> {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const ext = absolutePath.split('.').pop() || '';
  const language = getLanguageForExtension(ext);

  if (!language) {
    throw new Error(
      `Unsupported language for extension .${ext}. Supported: ts, js, py, go, rs, java, kt, c, cpp, cs, php, rb, swift`,
    );
  }

  const tree = await parseCode(content, language);
  if (!tree) {
    throw new Error(`Failed to parse ${filePath} — tree-sitter grammar not available for ${language}`);
  }

  try {
    let symbols = await extractSymbols(tree, content, language);

    const filterType = options.type ?? 'all';
    if (filterType !== 'all') {
      symbols = symbols.filter(s => s.type === filterType);
    }

    return { symbols, language, file: filePath };
  } finally {
    tree.delete();
  }
}
