/**
 * AST symbol extraction using tree-sitter queries.
 *
 * Shared infrastructure used by chunker, bm25, analyze, PRD context, quality scoring.
 * Extracts functions, classes, interfaces, types with metadata (name, signature, docstring).
 */

import type { Tree, Node, QueryCapture, Query } from 'web-tree-sitter';
import type { SymbolInfo, SymbolType } from './types.js';
import { getQueryForLanguage } from './queries.js';
import { loadLanguage } from './parser.js';

/** Cache of compiled Query objects per language */
const queryCache = new Map<string, Query>();

/** Lazily resolved Query constructor from web-tree-sitter */
let QueryClass: typeof import('web-tree-sitter').Query | null = null;

/**
 * Get or create a compiled Query for a language.
 * Returns null if language has no query defined or compilation fails.
 */
async function getQuery(language: string): Promise<Query | null> {
  const cached = queryCache.get(language);
  if (cached) return cached;

  const querySource = getQueryForLanguage(language);
  if (!querySource) return null;

  const lang = await loadLanguage(language);
  if (!lang) return null;

  // Lazily import the Query constructor to avoid hard crash if web-tree-sitter not installed
  if (!QueryClass) {
    try {
      const mod = await import('web-tree-sitter');
      QueryClass = mod.Query;
    } catch {
      return null;
    }
  }

  try {
    const query = new QueryClass(lang, querySource);
    queryCache.set(language, query);
    return query;
  } catch {
    // Query compilation failed — likely node type mismatch with grammar version
    return null;
  }
}

/**
 * Map capture name suffix to SymbolType.
 */
function captureNameToSymbolType(captureName: string): SymbolType | null {
  if (captureName === 'definition.function') return 'function';
  if (captureName === 'definition.method') return 'method';
  if (captureName === 'definition.class') return 'class';
  if (captureName === 'definition.interface') return 'interface';
  if (captureName === 'definition.type') return 'type_alias';
  return null;
}

/**
 * Extract the signature text from a definition node.
 * For functions: extracts parameters and return type.
 * For classes: extracts extends/implements.
 */
function extractSignature(node: Node, sourceCode: string): string | undefined {
  // Get the first line of the definition (usually contains the signature)
  const startRow = node.startPosition.row;
  const lines = sourceCode.split('\n');
  const firstLine = lines[startRow]?.trim();

  if (!firstLine) return undefined;

  // For functions/methods: extract from opening paren to closing paren or opening brace
  const parenStart = firstLine.indexOf('(');
  if (parenStart !== -1) {
    // Find matching closing paren
    let depth = 0;
    let endIdx = parenStart;
    for (let i = parenStart; i < firstLine.length; i++) {
      if (firstLine[i] === '(') depth++;
      if (firstLine[i] === ')') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }

    // Include return type if present (after closing paren, before brace)
    let signatureEnd = endIdx + 1;
    const afterParen = firstLine.slice(signatureEnd);
    const braceIdx = afterParen.indexOf('{');
    if (braceIdx > 0) {
      signatureEnd += braceIdx;
    } else if (!afterParen.includes('{')) {
      signatureEnd = firstLine.length;
    }

    const sig = firstLine.slice(parenStart, signatureEnd).trim();
    // Remove trailing { or : if present
    return sig.replace(/\s*[{:]?\s*$/, '').trim() || undefined;
  }

  return undefined;
}

/**
 * Find a doc comment adjacent to a definition node.
 * Looks for comment nodes immediately before the definition.
 */
function findDocComment(node: Node, docCaptures: QueryCapture[]): string | undefined {
  const defStartRow = node.startPosition.row;

  // Find the closest doc comment that ends right before this definition
  let bestDoc: string | undefined;
  let bestDistance = Infinity;

  for (const capture of docCaptures) {
    const docEndRow = capture.node.endPosition.row;
    const distance = defStartRow - docEndRow;

    // Doc comment must be within 1 line above the definition
    if (distance >= 0 && distance <= 1 && distance < bestDistance) {
      bestDistance = distance;
      bestDoc = capture.node.text;
    }
  }

  if (!bestDoc) return undefined;

  // Strip comment syntax
  return stripCommentSyntax(bestDoc);
}

/**
 * Strip comment syntax from various comment formats.
 */
function stripCommentSyntax(text: string): string {
  // JSDoc / C-style block comment: /** ... */  or /* ... */
  if (text.startsWith('/*')) {
    return text
      .replace(/^\/\*\*?\s*/, '')
      .replace(/\s*\*\/$/, '')
      .split('\n')
      .map((line) => line.replace(/^\s*\*\s?/, ''))
      .join('\n')
      .trim();
  }

  // Line comment: // ... or # ...
  if (text.startsWith('//')) {
    return text
      .split('\n')
      .map((line) => line.replace(/^\s*\/\/\s?/, ''))
      .join('\n')
      .trim();
  }
  if (text.startsWith('#')) {
    return text
      .split('\n')
      .map((line) => line.replace(/^\s*#\s?/, ''))
      .join('\n')
      .trim();
  }

  // Rust doc comment: /// ...
  if (text.startsWith('///')) {
    return text
      .split('\n')
      .map((line) => line.replace(/^\s*\/\/\/\s?/, ''))
      .join('\n')
      .trim();
  }

  // Python docstring: """...""" or '''...'''
  if (text.startsWith('"""') || text.startsWith("'''")) {
    return text.slice(3, -3).trim();
  }
  // Python expression_statement wrapping a string
  if (text.startsWith('"') || text.startsWith("'")) {
    return text.replace(/^["']+|["']+$/g, '').trim();
  }

  return text.trim();
}

/**
 * Extract all symbols from a parsed tree.
 *
 * @param tree - Parsed tree-sitter Tree
 * @param sourceCode - Original source code
 * @param language - Tree-sitter language name
 * @returns Array of extracted symbols with metadata
 */
export async function extractSymbols(
  tree: Tree,
  sourceCode: string,
  language: string
): Promise<SymbolInfo[]> {
  const query = await getQuery(language);
  if (!query) return [];

  const captures = query.captures(tree.rootNode);
  const symbols: SymbolInfo[] = [];

  // Separate doc captures from definition captures
  const docCaptures = captures.filter((c) => c.name === 'doc');
  const nameCaptures = captures.filter((c) => c.name === 'name');

  // Group captures by pattern index — each match has a @name and a @definition.*
  const definitionCaptures = captures.filter((c) => c.name.startsWith('definition.'));

  for (const defCapture of definitionCaptures) {
    const symbolType = captureNameToSymbolType(defCapture.name);
    if (!symbolType) continue;

    // Find the @name capture for this definition
    // It should be a descendant of the definition node
    const defNode = defCapture.node;
    const nameCapture = nameCaptures.find(
      (nc) =>
        nc.patternIndex === defCapture.patternIndex &&
        nc.node.startIndex >= defNode.startIndex &&
        nc.node.endIndex <= defNode.endIndex
    );

    const name = nameCapture?.node.text;
    if (!name) continue;

    // Skip private names, but keep Python dunder methods (__init__, __str__, etc.)
    if (name.startsWith('_') && !(name.startsWith('__') && name.endsWith('__'))) {
      continue;
    }

    const signature = extractSignature(defNode, sourceCode);
    const docComment = findDocComment(defNode, docCaptures);

    symbols.push({
      name,
      type: symbolType,
      signature,
      docComment,
      startRow: defNode.startPosition.row,
      endRow: defNode.endPosition.row,
      startColumn: defNode.startPosition.column,
      endColumn: defNode.endPosition.column,
    });
  }

  return symbols;
}

/**
 * Extract only function/method definitions.
 */
export async function extractFunctions(
  tree: Tree,
  sourceCode: string,
  language: string
): Promise<SymbolInfo[]> {
  const symbols = await extractSymbols(tree, sourceCode, language);
  return symbols.filter((s) => s.type === 'function' || s.type === 'method');
}

/**
 * Extract only class definitions.
 */
export async function extractClasses(
  tree: Tree,
  sourceCode: string,
  language: string
): Promise<SymbolInfo[]> {
  const symbols = await extractSymbols(tree, sourceCode, language);
  return symbols.filter((s) => s.type === 'class');
}

/**
 * Extract only interface/trait definitions.
 */
export async function extractInterfaces(
  tree: Tree,
  sourceCode: string,
  language: string
): Promise<SymbolInfo[]> {
  const symbols = await extractSymbols(tree, sourceCode, language);
  return symbols.filter((s) => s.type === 'interface');
}

/**
 * Extract only type definitions (type aliases, enums, structs).
 */
export async function extractTypes(
  tree: Tree,
  sourceCode: string,
  language: string
): Promise<SymbolInfo[]> {
  const symbols = await extractSymbols(tree, sourceCode, language);
  return symbols.filter((s) => s.type === 'type_alias' || s.type === 'enum' || s.type === 'struct');
}

/**
 * Extract all identifier names from source code (for BM25 tokenization).
 * This is a lightweight extraction that doesn't need full query matching.
 */
export function extractIdentifiers(rootNode: Node): string[] {
  const identifiers: string[] = [];
  const seen = new Set<string>();

  function walk(node: Node): void {
    if (
      node.type === 'identifier' ||
      node.type === 'type_identifier' ||
      node.type === 'field_identifier' ||
      node.type === 'property_identifier'
    ) {
      const text = node.text;
      if (text && text.length > 1 && !seen.has(text)) {
        seen.add(text);
        identifiers.push(text);
      }
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  walk(rootNode);
  return identifiers;
}

/**
 * Reset the query cache (useful for testing).
 */
export function resetQueryCache(): void {
  for (const query of queryCache.values()) {
    try {
      query.delete();
    } catch {
      // intentional
    }
  }
  queryCache.clear();
  QueryClass = null;
}
