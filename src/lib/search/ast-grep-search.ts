/**
 * ast-grep structural pattern matching integration.
 *
 * Provides structural code search using @ast-grep/napi — tree-sitter-based
 * pattern matching with metavariable support ($VAR, $$VAR, $$$VAR).
 *
 * Built-in languages: TypeScript, JavaScript, TSX, CSS, HTML
 * Dynamic languages (via @ast-grep/lang-*): Python, Go, Rust, Java, C, C++,
 *   C#, Ruby, Kotlin, Swift, Bash, Scala, PHP, JSON, YAML
 *
 * Examples:
 *   - "catch ($ERR) { }" — find empty catch blocks
 *   - "console.log($$$ARGS)" — find all console.log calls
 *   - "await $EXPR" — find all await expressions
 *   - "def $NAME($$$ARGS): $BODY" — find Python functions
 *   - "func $NAME($$$ARGS) { $$$BODY }" — find Go functions
 */

import pLimit from 'p-limit';
import { logWarn } from '../fault-logger.js';
import { getErrorMessage, DependencyError } from '../errors.js';

// Lazy-loaded to avoid startup cost when not used
let astGrepModule: typeof import('@ast-grep/napi') | null = null;
let dynamicLangsRegistered = false;

/**
 * Dynamic language packages to register.
 * Each entry: [npm package name, registration key]
 * These are tried at init time — missing packages are silently skipped.
 */
const DYNAMIC_LANG_PACKAGES: Array<[string, string]> = [
  ['@ast-grep/lang-python', 'python'],
  ['@ast-grep/lang-go', 'go'],
  ['@ast-grep/lang-rust', 'rust'],
  ['@ast-grep/lang-java', 'java'],
  ['@ast-grep/lang-c', 'c'],
  ['@ast-grep/lang-cpp', 'cpp'],
  ['@ast-grep/lang-csharp', 'csharp'],
  ['@ast-grep/lang-ruby', 'ruby'],
  ['@ast-grep/lang-kotlin', 'kotlin'],
  ['@ast-grep/lang-swift', 'swift'],
  ['@ast-grep/lang-bash', 'bash'],
  ['@ast-grep/lang-scala', 'scala'],
  ['@ast-grep/lang-php', 'php'],
  ['@ast-grep/lang-json', 'json'],
  ['@ast-grep/lang-yaml', 'yaml'],
];

/** Track which dynamic languages were successfully registered */
const registeredDynamicLangs = new Set<string>();

/**
 * Load ast-grep and register all available dynamic languages.
 * registerDynamicLanguage() must be called exactly ONCE (OnceLock in Rust).
 * Missing language packages are silently skipped.
 */
async function getAstGrep(): Promise<typeof import('@ast-grep/napi')> {
  if (!astGrepModule) {
    try {
      astGrepModule = await import('@ast-grep/napi');
    } catch (err) {
      logWarn('ast-grep', `Failed to load @ast-grep/napi: ${getErrorMessage(err)}`);
      throw new Error(
        'ast-grep is not available. Install @ast-grep/napi to use structural pattern search.',
        { cause: err }
      );
    }

    // Register dynamic languages exactly once
    if (!dynamicLangsRegistered) {
      dynamicLangsRegistered = true;
      await registerAllDynamicLanguages(astGrepModule);
    }
  }
  return astGrepModule;
}

/**
 * Try to import and register all available @ast-grep/lang-* packages.
 * Missing packages are silently skipped — only installed ones activate.
 */
async function registerAllDynamicLanguages(sg: typeof import('@ast-grep/napi')): Promise<void> {
  const registrations: Record<string, unknown> = {};

  const results = await Promise.allSettled(
    DYNAMIC_LANG_PACKAGES.map(async ([pkg, name]) => {
      try {
        const mod = await import(pkg);
        return { name, registration: mod.default ?? mod };
      } catch {
        // Package not installed — expected for optional language support
        logWarn('ast-grep', `Optional lang package ${pkg} not available`);
        return null;
      }
    })
  );

  const loadedNames: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      registrations[result.value.name] = result.value.registration;
      loadedNames.push(result.value.name);
    }
  }

  if (Object.keys(registrations).length > 0) {
    try {
      sg.registerDynamicLanguage(registrations as Parameters<typeof sg.registerDynamicLanguage>[0]);
      for (const name of loadedNames) {
        registeredDynamicLangs.add(name);
      }
    } catch (err) {
      logWarn('ast-grep', `Failed to register dynamic languages: ${getErrorMessage(err)}`);
    }
  }
}

/**
 * File extension → ast-grep language name mapping.
 *
 * Built-in languages use PascalCase (matching Lang enum).
 * Dynamic languages use lowercase (matching registration key).
 */
const LANG_MAP: Record<string, string> = {
  // Built-in (5 languages, always available)
  ts: 'TypeScript',
  tsx: 'Tsx',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  css: 'Css',
  html: 'Html',
  htm: 'Html',
  // Dynamic — registered from @ast-grep/lang-* packages
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cu: 'cpp',
  ino: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  rbw: 'ruby',
  gemspec: 'ruby',
  kt: 'kotlin',
  ktm: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  bats: 'bash',
  scala: 'scala',
  sc: 'scala',
  sbt: 'scala',
  php: 'php',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
};

/** Built-in languages that don't need dynamic registration */
const BUILTIN_LANGS = new Set(['TypeScript', 'JavaScript', 'Tsx', 'Css', 'Html']);

/** Result from a structural pattern match */
export interface PatternMatch {
  /** Matched code text */
  text: string;
  /** File path (without storage prefix) */
  file_path: string;
  /** Start line (1-indexed) */
  start_line: number;
  /** End line (1-indexed) */
  end_line: number;
  /** Start column */
  start_column: number;
  /** AST node kind (e.g., "catch_clause", "call_expression") */
  node_kind: string;
  /** Extracted metavariable bindings ($VAR → matched text) */
  metavars: Record<string, string>;
}

/**
 * Get the ast-grep language name for a file extension.
 */
function getLangForExtension(ext: string): string | null {
  return LANG_MAP[ext.toLowerCase()] ?? null;
}

/**
 * Get file extension from path.
 */
function getExtension(filePath: string): string {
  const parts = filePath.split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

/**
 * Check if a language is available (built-in or registered).
 */
function isLangAvailable(langName: string): boolean {
  return BUILTIN_LANGS.has(langName) || registeredDynamicLangs.has(langName);
}

/**
 * Extract metavariable names from a pattern string.
 * Matches $VAR, $$VAR, $$$VAR patterns.
 * Returns entries with the bare name and whether the metavar is variadic ($$$).
 */
function extractMetavarNames(pattern: string): Array<{ name: string; variadic: boolean }> {
  const raw = pattern.match(/\$+[A-Z_][A-Z0-9_]*/g);
  if (!raw) return [];
  const seen = new Map<string, boolean>();
  for (const m of raw) {
    const dollarPrefix = m.match(/^\$+/)![0];
    const name = m.slice(dollarPrefix.length);
    // $$$VAR = variadic, $$VAR or $VAR = single
    if (!seen.has(name)) {
      seen.set(name, dollarPrefix.length >= 3);
    }
  }
  return [...seen.entries()].map(([name, variadic]) => ({ name, variadic }));
}

/**
 * Search a single file's content for structural pattern matches.
 */
export async function searchPatternInContent(
  content: string,
  filePath: string,
  pattern: string,
  lang?: string
): Promise<PatternMatch[]> {
  try {
    const sg = await getAstGrep();

    const ext = getExtension(filePath);
    const langName = lang ?? getLangForExtension(ext);
    if (!langName) return [];
    if (!isLangAvailable(langName)) return [];

    const root = sg.parse(langName, content);
    const matches = root.root().findAll(pattern);
    const metavarNames = extractMetavarNames(pattern);

    return matches.map((node) => {
      const range = node.range();
      const metavars: Record<string, string> = {};
      for (const { name, variadic } of metavarNames) {
        if (variadic) {
          const multi = node.getMultipleMatches(name);
          if (multi && multi.length > 0) {
            // Extract the full source span (preserving whitespace between nodes)
            const firstRange = multi[0].range();
            const lastRange = multi[multi.length - 1].range();
            metavars[name] = content.slice(firstRange.start.index, lastRange.end.index);
          }
        } else {
          const matched = node.getMatch(name);
          if (matched) {
            metavars[name] = matched.text();
          }
        }
      }

      return {
        text: node.text(),
        file_path: filePath,
        start_line: range.start.line + 1,
        end_line: range.end.line + 1,
        start_column: range.start.column,
        node_kind: String(node.kind()),
        metavars,
      };
    });
  } catch (err) {
    const msg = getErrorMessage(err);
    logWarn('ast-grep', `Pattern search failed for ${filePath}: ${msg}`);
    throw new DependencyError(`Pattern search failed for ${filePath}: ${msg}`, {
      filePath,
      pattern,
    });
  }
}

/**
 * Search multiple files for structural pattern matches.
 */
export async function searchPatternInFiles(
  files: Array<{ filePath: string; content: string }>,
  pattern: string,
  lang?: string,
  limit: number = 50
): Promise<PatternMatch[]> {
  const concurrency = pLimit(5);

  const settled = await Promise.allSettled(
    files.map((file) =>
      concurrency(() => searchPatternInContent(file.content, file.filePath, pattern, lang))
    )
  );

  const results: PatternMatch[] = [];
  let lastError: unknown = null;
  let failCount = 0;

  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      failCount++;
      lastError = outcome.reason;
      continue;
    }
    for (const match of outcome.value) {
      if (results.length >= limit) return results;
      results.push(match);
    }
  }

  // If every file failed, the pattern itself is likely invalid — propagate
  if (failCount === files.length && files.length > 0 && lastError) {
    throw lastError;
  }

  return results;
}

/**
 * Format pattern match results for MCP tool output.
 */
export function formatPatternResults(
  matches: PatternMatch[],
  output: 'full' | 'lean' | 'signatures' = 'full'
): string {
  if (matches.length === 0) return 'No structural matches found.';

  if (output === 'lean') {
    return matches
      .map((m, i) => {
        const vars = Object.entries(m.metavars)
          .map(([k, v]) => `$${k}=${v.length > 40 ? v.slice(0, 40) + '...' : v}`)
          .join(', ');
        const varsStr = vars ? ` {${vars}}` : '';
        return `${i + 1}. ${m.file_path}:${m.start_line}-${m.end_line} [${m.node_kind}]${varsStr}`;
      })
      .join('\n');
  }

  if (output === 'signatures') {
    return matches
      .map((m, i) => {
        const firstLine = m.text.split('\n')[0].trim();
        const display = firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine;
        return `${i + 1}. ${m.file_path}:${m.start_line} [${m.node_kind}] — ${display}`;
      })
      .join('\n');
  }

  return matches
    .map((m, i) => {
      const vars = Object.entries(m.metavars)
        .map(([k, v]) => `  $${k} = ${v}`)
        .join('\n');
      const varsBlock = vars ? `\nMetavariables:\n${vars}` : '';
      return `### ${i + 1}. ${m.file_path}:${m.start_line}-${m.end_line} [${m.node_kind}]${varsBlock}\n\n\`\`\`\n${m.text}\n\`\`\``;
    })
    .join('\n\n---\n\n');
}

/**
 * List supported languages for structural pattern search.
 */
export function getSupportedLanguages(): string[] {
  const builtIn = [...BUILTIN_LANGS];
  const dynamic = [...registeredDynamicLangs];
  return [...new Set([...builtIn, ...dynamic])].sort();
}

/**
 * Check if ast-grep is available (package installed).
 */
export async function isAstGrepAvailable(): Promise<boolean> {
  try {
    await getAstGrep();
    return true;
  } catch (_err) {
    // getAstGrep() already logs the detailed warning — only trace here
    logWarn('ast-grep', `availability check failed: ${getErrorMessage(_err)}`);
    return false;
  }
}
