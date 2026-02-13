/**
 * AST-based code chunker using tree-sitter.
 *
 * Produces chunks aligned to symbol boundaries (functions, classes, methods)
 * with metadata (symbolName, symbolType, signature, docComment).
 *
 * Falls back to null if tree-sitter is unavailable for the given file,
 * signaling the caller to use the regex/line-based fallback.
 */

import type { TreeSitterChunk, SymbolInfo } from './types.js';
import { getLanguageForExtension } from './types.js';
import { parseFile } from './parser.js';
import { extractSymbols } from './extractor.js';

/** Max chunk size in characters (match existing chunker limit) */
const MAX_CHUNK_CHARS = 4000;

/**
 * Chunk source code using tree-sitter AST analysis.
 *
 * Strategy:
 * 1. Parse the file with tree-sitter
 * 2. Extract all top-level symbols (functions, classes, etc.)
 * 3. Create a chunk per symbol, including leading comments/whitespace
 * 4. Collect any "orphan" lines between symbols into separate chunks
 * 5. Split oversized chunks to fit model context limits
 *
 * @returns Array of chunks with metadata, or null if tree-sitter unavailable
 */
export async function chunkCodeWithTreeSitter(
  content: string,
  filePath: string,
): Promise<TreeSitterChunk[] | null> {
  // Check if language is recognized
  const ext = filePath.split('.').pop() || '';
  const language = getLanguageForExtension(ext);
  if (!language) return null;

  // Parse the file
  const [tree, lang] = await parseFile(filePath, content);
  if (!tree || !lang) return null;

  try {
    // Extract symbols
    const symbols = await extractSymbols(tree, content, lang);
    const lines = content.split('\n');

    if (symbols.length === 0) {
      // No symbols found — return entire file as one chunk (or split if too large)
      return splitLargeChunk({
        content,
        startLine: 1,
        endLine: lines.length,
      });
    }

    // Sort symbols by start position
    const sorted = [...symbols].sort((a, b) => a.startRow - b.startRow);

    const chunks: TreeSitterChunk[] = [];
    let lastEndRow = 0; // 0-based, exclusive

    for (const symbol of sorted) {
      // Collect any orphan lines before this symbol (imports, comments, blank lines)
      const gapStart = lastEndRow;
      const symbolStartWithDoc = findChunkStart(symbol, lines, gapStart);

      if (symbolStartWithDoc > gapStart) {
        // There are orphan lines between the previous symbol and this one
        const orphanContent = lines.slice(gapStart, symbolStartWithDoc).join('\n');
        if (orphanContent.trim().length > 20) {
          chunks.push({
            content: orphanContent,
            startLine: gapStart + 1, // 1-based
            endLine: symbolStartWithDoc,
          });
        }
      }

      // Create chunk for this symbol
      const chunkStartRow = symbolStartWithDoc;
      const chunkEndRow = symbol.endRow + 1; // exclusive, 0-based

      const symbolContent = lines.slice(chunkStartRow, chunkEndRow).join('\n');

      chunks.push({
        content: symbolContent,
        startLine: chunkStartRow + 1, // 1-based
        endLine: chunkEndRow,
        symbolName: symbol.name,
        symbolType: symbol.type,
        signature: symbol.signature,
        docComment: symbol.docComment,
      });

      lastEndRow = Math.max(lastEndRow, chunkEndRow);
    }

    // Remaining lines after the last symbol
    if (lastEndRow < lines.length) {
      const remainingContent = lines.slice(lastEndRow).join('\n');
      if (remainingContent.trim().length > 20) {
        chunks.push({
          content: remainingContent,
          startLine: lastEndRow + 1,
          endLine: lines.length,
        });
      }
    }

    // Filter empty chunks and split oversized ones
    const filtered = chunks.filter(c => c.content.trim().length > 0);
    return filtered.flatMap(splitLargeChunk);
  } finally {
    // Free the tree to avoid memory leaks
    tree.delete();
  }
}

/**
 * Find where a chunk should start, including leading doc comments
 * and decorators that belong to this symbol.
 *
 * Walks backward from the symbol's start to include:
 * - Adjacent comment lines (doc comments)
 * - Decorator lines (e.g., @decorator)
 * - Blank lines between decorator/comment groups and the definition
 */
function findChunkStart(
  symbol: SymbolInfo,
  lines: string[],
  minRow: number,
): number {
  let start = symbol.startRow;

  // Walk backward to include comments and decorators
  while (start > minRow) {
    const prevLine = lines[start - 1]?.trim();
    if (!prevLine) {
      // Blank line — check if there's a comment/decorator above it
      if (start - 2 >= minRow) {
        const lineAboveBlank = lines[start - 2]?.trim();
        if (
          lineAboveBlank &&
          (lineAboveBlank.startsWith('//') ||
            lineAboveBlank.startsWith('/*') ||
            lineAboveBlank.startsWith('*') ||
            lineAboveBlank.startsWith('#') ||
            lineAboveBlank.startsWith('@') ||
            lineAboveBlank.startsWith('///'))
        ) {
          start--;
          continue;
        }
      }
      break;
    }

    if (
      prevLine.startsWith('//') ||
      prevLine.startsWith('/*') ||
      prevLine.startsWith('*') ||
      prevLine.startsWith('*/') ||
      prevLine.startsWith('#') ||
      prevLine.startsWith('@') ||
      prevLine.startsWith('///') ||
      prevLine.startsWith('"""') ||
      prevLine.startsWith("'''")
    ) {
      start--;
    } else {
      break;
    }
  }

  return start;
}

/**
 * Split a chunk that exceeds MAX_CHUNK_CHARS into smaller pieces.
 * Preserves metadata on the first sub-chunk.
 */
function splitLargeChunk(chunk: TreeSitterChunk): TreeSitterChunk[] {
  if (chunk.content.length <= MAX_CHUNK_CHARS) {
    return [chunk];
  }

  const lines = chunk.content.split('\n');
  const result: TreeSitterChunk[] = [];
  let currentLines: string[] = [];
  let currentSize = 0;
  let currentStartLine = chunk.startLine;
  let isFirst = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineSize = line.length + 1;

    if (currentSize + lineSize > MAX_CHUNK_CHARS && currentLines.length > 0) {
      const subChunk: TreeSitterChunk = {
        content: currentLines.join('\n'),
        startLine: currentStartLine,
        endLine: currentStartLine + currentLines.length - 1,
      };

      // Copy metadata only to the first sub-chunk
      if (isFirst) {
        subChunk.symbolName = chunk.symbolName;
        subChunk.symbolType = chunk.symbolType;
        subChunk.signature = chunk.signature;
        subChunk.docComment = chunk.docComment;
        isFirst = false;
      }

      result.push(subChunk);
      currentLines = [];
      currentSize = 0;
      currentStartLine = chunk.startLine + i;
    }

    currentLines.push(line);
    currentSize += lineSize;
  }

  if (currentLines.length > 0) {
    const subChunk: TreeSitterChunk = {
      content: currentLines.join('\n'),
      startLine: currentStartLine,
      endLine: currentStartLine + currentLines.length - 1,
    };

    if (isFirst) {
      subChunk.symbolName = chunk.symbolName;
      subChunk.symbolType = chunk.symbolType;
      subChunk.signature = chunk.signature;
      subChunk.docComment = chunk.docComment;
    }

    result.push(subChunk);
  }

  return result;
}
