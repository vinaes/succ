/**
 * Codebase Context Enrichment
 *
 * Gathers real project context for LLM prompts during PRD generation and parsing.
 * This ensures the LLM sees actual file structure, relevant code, memories, and docs
 * rather than guessing the architecture.
 *
 * Context budget: ~8500 tokens total
 * - File tree: ~2000 tokens
 * - Code search: ~3000 tokens
 * - Memories: ~2000 tokens
 * - Brain docs: ~1500 tokens
 */

import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { getProjectRoot, getSuccDir } from '../config.js';
import type { CodebaseContext } from './types.js';

// Rough char-to-token ratio (conservative: 1 token ≈ 4 chars)
const CHARS_PER_TOKEN = 4;

const BUDGET = {
  file_tree: 2000 * CHARS_PER_TOKEN,        // ~8000 chars
  code_search: 3000 * CHARS_PER_TOKEN,       // ~12000 chars
  memories: 2000 * CHARS_PER_TOKEN,          // ~8000 chars
  brain_docs: 1500 * CHARS_PER_TOKEN,        // ~6000 chars
};

// ============================================================================
// File Tree
// ============================================================================

/**
 * Build a formatted file tree showing project structure.
 * Shows top-level files + src/ two levels deep.
 */
async function gatherFileTree(): Promise<string> {
  const root = getProjectRoot();
  const lines: string[] = [];

  // Top-level entries
  const topLevel = await glob('*', {
    cwd: root,
    dot: false,
    // Exclude noise
    ignore: ['node_modules', 'dist', '.git', '.succ', '.claude', 'coverage', '.next', '.cache'],
  });

  for (const entry of topLevel.sort()) {
    const fullPath = path.join(root, entry);
    const isDir = fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
    lines.push(isDir ? `${entry}/` : entry);
  }

  // src/ two levels deep
  const srcDir = path.join(root, 'src');
  if (fs.existsSync(srcDir)) {
    // Use a pattern that limits depth to 2 levels: */* matches exactly 2 levels
    const srcL1 = await glob('*', { cwd: srcDir, dot: false });
    const srcL2 = await glob('*/*', {
      cwd: srcDir,
      dot: false,
      ignore: ['**/*.test.*', '**/*.spec.*'],
    });
    const srcEntries = [...srcL1, ...srcL2].filter((v, i, a) => a.indexOf(v) === i);

    for (const entry of srcEntries.sort()) {
      const fullPath = path.join(srcDir, entry);
      const isDir = fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
      lines.push(isDir ? `  src/${entry}/` : `  src/${entry}`);
    }
  }

  const result = lines.join('\n');
  return truncate(result, BUDGET.file_tree);
}

// ============================================================================
// Code Search (via succ MCP tools — called externally)
// ============================================================================

/**
 * Search for relevant code using succ's indexed code.
 * Uses tree-sitter for AST-based symbol extraction when available,
 * falls back to simple glob+read.
 */
async function gatherCodeSearch(description: string): Promise<string> {
  const root = getProjectRoot();
  const keywords = extractKeywords(description);
  const results: string[] = [];
  const seenFiles = new Set<string>();

  // Try AST-based symbol extraction for matched files
  let extractSymbols: ((code: string, lang: string) => Promise<Array<{ name: string; type: string; signature?: string; startRow: number; endRow: number }>>) | null = null;
  try {
    const { extractSymbols: _extract } = await import('../tree-sitter/extractor.js');
    const { parseCode } = await import('../tree-sitter/parser.js');
    extractSymbols = async (code: string, lang: string) => {
      const tree = await parseCode(code, lang);
      if (!tree) return [];
      const symbols = await _extract(tree, code, lang);
      tree.delete();
      return symbols;
    };
  } catch {
    // tree-sitter not available, will use fallback
  }

  // Search by filename match
  for (const keyword of keywords.slice(0, 5)) {
    const matches = await glob(`src/**/*${keyword.toLowerCase()}*`, {
      cwd: root,
      nodir: true,
      ignore: ['**/*.test.*', '**/*.spec.*', '**/node_modules/**'],
    });

    for (const match of matches.slice(0, 3)) {
      if (seenFiles.has(match)) continue;
      seenFiles.add(match);
      const fullPath = path.join(root, match);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');

      // Use AST symbols if available — much more compact and informative
      if (extractSymbols) {
        const ext = path.extname(match).slice(1);
        const langMap: Record<string, string> = { ts: 'typescript', tsx: 'tsx', js: 'javascript', py: 'python', go: 'go', rs: 'rust', java: 'java' };
        const lang = langMap[ext];
        if (lang) {
          const symbols = await extractSymbols(content, lang);
          if (symbols.length > 0) {
            const symbolLines = symbols.slice(0, 15).map(s =>
              `  ${s.type} ${s.name}${s.signature ? `: ${s.signature}` : ''} (L${s.startRow + 1})`
            );
            results.push(`--- ${match} (${symbols.length} symbols) ---\n${symbolLines.join('\n')}\n`);
            continue;
          }
        }
      }

      // Fallback: first 50 lines
      const lines = content.split('\n');
      results.push(`--- ${match} ---\n${lines.slice(0, 50).join('\n')}\n`);
    }
  }

  // Search for files containing keywords in content
  const srcFiles = await glob('src/**/*.ts', {
    cwd: root,
    nodir: true,
    ignore: ['**/*.test.*', '**/*.spec.*', '**/node_modules/**', '**/dist/**'],
  });

  for (const keyword of keywords.slice(0, 3)) {
    for (const file of srcFiles) {
      if (results.length >= 8) break;
      if (seenFiles.has(file)) continue;
      const fullPath = path.join(root, file);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');
      if (content.toLowerCase().includes(keyword.toLowerCase())) {
        seenFiles.add(file);
        const lines = content.split('\n');
        const matchingLines: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(keyword.toLowerCase())) {
            const start = Math.max(0, i - 2);
            const end = Math.min(lines.length, i + 3);
            matchingLines.push(`  L${i + 1}: ${lines.slice(start, end).join('\n  ')}`);
            if (matchingLines.length >= 3) break;
          }
        }
        if (matchingLines.length > 0) {
          results.push(`--- ${file} (matches: "${keyword}") ---\n${matchingLines.join('\n')}\n`);
        }
      }
    }
  }

  const result = results.join('\n');
  return truncate(result, BUDGET.code_search);
}

// ============================================================================
// Memories (placeholder — actual succ_recall requires MCP or direct DB access)
// ============================================================================

/**
 * Gather relevant memories from succ.
 * In CLI context, we do a simple search of recent decisions/learnings.
 */
async function gatherMemories(_description: string): Promise<string> {
  // In Phase 1, we'll use a simple approach:
  // Check if .succ/succ.db exists, and if so, note that memories are available.
  // Full integration with succ_recall happens when called from MCP context.
  const succDir = getSuccDir();
  const dbPath = path.join(succDir, 'succ.db');

  if (!fs.existsSync(dbPath)) {
    return '(No succ memories available — run `succ init` to enable)';
  }

  // For now, return a note that context is available.
  // The actual recall will be done by the LLM agent during execution (Phase 2).
  return '(succ memory system available — memories will be recalled during task execution)';
}

/**
 * Gather relevant brain vault documentation.
 */
async function gatherBrainDocs(_description: string): Promise<string> {
  const brainDir = path.join(getSuccDir(), 'brain');
  if (!fs.existsSync(brainDir)) {
    return '(No brain vault documentation available)';
  }

  // List available brain vault docs for context
  const docs = await glob('**/*.md', {
    cwd: brainDir,
    nodir: true,
  });

  if (docs.length === 0) {
    return '(Brain vault is empty)';
  }

  const lines = ['Available documentation in brain vault:'];
  for (const doc of docs.sort().slice(0, 20)) {
    lines.push(`  - ${doc}`);
  }

  return truncate(lines.join('\n'), BUDGET.brain_docs);
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Gather codebase context for LLM prompts.
 * Used by both generate.ts and parse.ts before calling LLM.
 *
 * @param description - The PRD description or content to gather context for
 * @returns CodebaseContext with formatted sections
 */
export async function gatherCodebaseContext(description: string): Promise<CodebaseContext> {
  const [file_tree, code_search_results, memories, brain_docs] = await Promise.all([
    gatherFileTree(),
    gatherCodeSearch(description),
    gatherMemories(description),
    gatherBrainDocs(description),
  ]);

  return { file_tree, code_search_results, memories, brain_docs };
}

/**
 * Format codebase context into a string for prompt injection
 */
export function formatContext(ctx: CodebaseContext): string {
  const sections: string[] = [];

  if (ctx.file_tree) {
    sections.push(`### Project File Structure\n\`\`\`\n${ctx.file_tree}\n\`\`\``);
  }

  if (ctx.code_search_results && !ctx.code_search_results.startsWith('(')) {
    sections.push(`### Relevant Source Code\n${ctx.code_search_results}`);
  }

  if (ctx.memories && !ctx.memories.startsWith('(')) {
    sections.push(`### Project Memories & Decisions\n${ctx.memories}`);
  }

  if (ctx.brain_docs && !ctx.brain_docs.startsWith('(')) {
    sections.push(`### Documentation\n${ctx.brain_docs}`);
  }

  return sections.join('\n\n');
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Extract keywords from a description for code search.
 * Simple approach: split on spaces, filter short/common words.
 */
function extractKeywords(description: string): string[] {
  const stopWords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
    'not', 'no', 'nor', 'so', 'yet', 'both', 'either', 'neither',
    'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other',
    'some', 'such', 'than', 'too', 'very', 'just', 'also', 'add',
    'implement', 'create', 'make', 'build', 'update', 'fix', 'change',
    'new', 'feature', 'support', 'system', 'module', 'function',
    // Russian stop words
    'в', 'на', 'с', 'и', 'не', 'для', 'из', 'по', 'что', 'как',
    'это', 'все', 'они', 'мы', 'он', 'она', 'его', 'её', 'их',
    'добавить', 'создать', 'сделать', 'новый', 'систему', 'модуль',
  ]);

  return description
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w))
    .slice(0, 10);
}

/**
 * Truncate a string to max chars, adding a note if truncated
 */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n... (truncated)';
}
