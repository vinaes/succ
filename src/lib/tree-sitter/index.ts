/**
 * Tree-sitter code intelligence infrastructure.
 *
 * Public API for consumers (chunker.ts, bm25.ts, analyze.ts, etc.)
 */

// Types
export type { SymbolInfo, SymbolType, TreeSitterChunk, LanguageConfig } from './types.js';
export {
  EXTENSION_TO_LANGUAGE,
  LANGUAGE_TO_WASM,
  LANGUAGES_WITH_QUERIES,
  getLanguageForExtension,
  getWasmFileForLanguage,
} from './types.js';

// Parser
export type { Tree, Node, Query, QueryMatch, QueryCapture } from './parser.js';
export {
  initTreeSitter,
  getParserForLanguage,
  getParserForFile,
  loadLanguage,
  parseCode,
  parseFile,
  isGrammarCached,
  listCachedGrammars,
  clearGrammarCache,
  getGrammarsDir,
  resetParserState,
} from './parser.js';

// Queries
export { getQueryForLanguage, getSupportedQueryLanguages } from './queries.js';

// Extractor
export {
  extractSymbols,
  extractFunctions,
  extractClasses,
  extractInterfaces,
  extractTypes,
  extractIdentifiers,
  resetQueryCache,
} from './extractor.js';

// Chunker
export { chunkCodeWithTreeSitter } from './chunker-ts.js';
