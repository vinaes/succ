/**
 * Hierarchical Summaries — RAPTOR-style multi-level abstraction.
 *
 * Generates zoom-level summaries: file → directory → module → repo.
 * Different query granularity needs different zoom levels:
 *   "What does hashPassword do?" → file-level
 *   "What does the auth module do?" → directory-level
 *   "Describe this project" → repo-level
 *
 * Summaries are stored as memory nodes with level metadata,
 * enabling search at the appropriate zoom based on query specificity.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { logInfo, logWarn } from '../fault-logger.js';
import { getProjectRoot } from '../config.js';
import { callLLM } from '../llm.js';
import { EXTENSION_TO_LANGUAGE } from '../tree-sitter/types.js';

// ============================================================================
// Types
// ============================================================================

export type SummaryLevel = 'file' | 'directory' | 'module' | 'repo';

export interface HierarchicalSummary {
  /** Relative path from project root (file or directory) */
  path: string;
  /** Zoom level */
  level: SummaryLevel;
  /** LLM-generated summary text */
  summary: string;
  /** Key exported symbols (for file level) */
  symbols?: string[];
  /** Number of files covered */
  fileCount: number;
  /** Total lines of code covered */
  lineCount: number;
  /** Child paths (for directory/module/repo levels) */
  children?: string[];
}

export interface HierarchicalSummaryResult {
  summaries: HierarchicalSummary[];
  totalFiles: number;
  totalDirectories: number;
  levels: Record<SummaryLevel, number>;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_EXCLUDES = new Set([
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
  '.succ',
  '.claude',
]);

const CODE_EXTENSIONS = new Set([
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
]);

// Max chars to send to LLM for summarization
const MAX_FILE_CONTENT_CHARS = 6000;
const MAX_DIR_CONTENT_CHARS = 8000;

// ============================================================================
// File-level summary
// ============================================================================

interface FileInfo {
  relativePath: string;
  absolutePath: string;
  content: string;
  lineCount: number;
  symbols: string[];
}

function extractExportedSymbols(content: string, ext: string): string[] {
  const symbols: string[] = [];

  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    const patterns = [
      /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g,
      /export\s+(?:const|let|var)\s+(\w+)/g,
      /export\s+(?:default\s+)?class\s+(\w+)/g,
      /export\s+interface\s+(\w+)/g,
      /export\s+type\s+(\w+)/g,
      /export\s+enum\s+(\w+)/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        symbols.push(match[1]);
      }
    }
  } else if (ext === '.py') {
    let match;
    const defPat = /^def\s+(\w+)/gm;
    while ((match = defPat.exec(content)) !== null) {
      if (!match[1].startsWith('_')) symbols.push(match[1]);
    }
    const classPat = /^class\s+(\w+)/gm;
    while ((match = classPat.exec(content)) !== null) {
      symbols.push(match[1]);
    }
  } else if (ext === '.go') {
    const patterns = [/^func\s+(\w+)/gm, /^type\s+(\w+)\s+(?:struct|interface)/gm];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1][0] === match[1][0].toUpperCase()) symbols.push(match[1]);
      }
    }
  } else if (ext === '.rs') {
    const patterns = [/pub\s+(?:async\s+)?fn\s+(\w+)/g, /pub\s+(?:struct|enum|trait)\s+(\w+)/g];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        symbols.push(match[1]);
      }
    }
  }

  return [...new Set(symbols)];
}

async function summarizeFile(file: FileInfo): Promise<string> {
  const truncated = file.content.slice(0, MAX_FILE_CONTENT_CHARS);
  const symbolList =
    file.symbols.length > 0 ? `\nExported symbols: ${file.symbols.join(', ')}` : '';

  const prompt = `Summarize this source file in 2-3 sentences. Focus on its purpose, what it provides, and its role in the project. Be specific about functionality, not generic.

File: ${file.relativePath} (${file.lineCount} lines)${symbolList}

\`\`\`
${truncated}
\`\`\`

Summary:`;

  return await callLLM(prompt);
}

// ============================================================================
// Directory-level summary
// ============================================================================

async function summarizeDirectory(
  dirPath: string,
  fileSummaries: HierarchicalSummary[]
): Promise<string> {
  const fileDescriptions = fileSummaries
    .map((s) => `- ${path.basename(s.path)}: ${s.summary}`)
    .join('\n')
    .slice(0, MAX_DIR_CONTENT_CHARS);

  const prompt = `Summarize what this directory/module does in 2-3 sentences based on its files. Focus on the module's overall responsibility and how its parts work together.

Directory: ${dirPath}
Files (${fileSummaries.length}):
${fileDescriptions}

Summary:`;

  return await callLLM(prompt);
}

// ============================================================================
// Main generation pipeline
// ============================================================================

/**
 * Generate hierarchical summaries for a codebase.
 *
 * Builds summaries bottom-up: files → directories → module groups → repo.
 *
 * @param rootPath - Project root (default: getProjectRoot())
 * @param options - Generation options
 */
export async function generateHierarchicalSummaries(
  rootPath?: string,
  options?: {
    /** Only summarize files matching these extensions */
    extensions?: Set<string>;
    /** Directories to exclude */
    excludes?: Set<string>;
    /** Max files to summarize (default: 200) */
    maxFiles?: number;
    /** Max concurrent LLM calls (default: 3) */
    concurrency?: number;
    /** Generate repo-level summary (default: true) */
    includeRepo?: boolean;
  }
): Promise<HierarchicalSummaryResult> {
  const root = rootPath ?? getProjectRoot();
  const extensions = options?.extensions ?? CODE_EXTENSIONS;
  const excludes = options?.excludes ?? DEFAULT_EXCLUDES;
  const maxFiles = options?.maxFiles ?? 200;
  const rawConcurrency = options?.concurrency;
  const concurrency =
    typeof rawConcurrency === 'number' && Number.isFinite(rawConcurrency) && rawConcurrency > 0
      ? Math.floor(rawConcurrency)
      : 3;
  const includeRepo = options?.includeRepo ?? true;

  const summaries: HierarchicalSummary[] = [];
  const levels: Record<SummaryLevel, number> = { file: 0, directory: 0, module: 0, repo: 0 };

  // 1. Collect all code files
  const files: FileInfo[] = [];
  await collectFiles(root, root, extensions, excludes, files, maxFiles);

  logInfo('hierarchical', `Collected ${files.length} files for summarization`);

  // 2. Generate file-level summaries (with concurrency control)
  const fileSummaries: HierarchicalSummary[] = [];

  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (file) => {
        try {
          const summary = await summarizeFile(file);
          return {
            path: file.relativePath,
            level: 'file' as SummaryLevel,
            summary,
            symbols: file.symbols,
            fileCount: 1,
            lineCount: file.lineCount,
          };
        } catch (error) {
          logWarn('hierarchical', `Failed to summarize ${file.relativePath}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      })
    );

    for (const result of results) {
      if (result) {
        fileSummaries.push(result);
        summaries.push(result);
        levels.file++;
      }
    }
  }

  // 3. Group by directory and generate directory-level summaries
  const dirGroups = new Map<string, HierarchicalSummary[]>();
  for (const fileSummary of fileSummaries) {
    const dir = path.dirname(fileSummary.path);
    const group = dirGroups.get(dir) ?? [];
    group.push(fileSummary);
    dirGroups.set(dir, group);
  }

  const dirSummaries: HierarchicalSummary[] = [];
  const dirEntries = [...dirGroups.entries()].filter(([, files]) => files.length >= 1);

  for (let i = 0; i < dirEntries.length; i += concurrency) {
    const batch = dirEntries.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async ([dir, dirFiles]) => {
        try {
          const summary = await summarizeDirectory(dir, dirFiles);
          const totalLines = dirFiles.reduce((sum, f) => sum + f.lineCount, 0);
          return {
            path: dir,
            level: 'directory' as SummaryLevel,
            summary,
            fileCount: dirFiles.length,
            lineCount: totalLines,
            children: dirFiles.map((f) => f.path),
          };
        } catch (error) {
          logWarn('hierarchical', `Failed to summarize directory ${dir}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      })
    );

    for (const result of results) {
      if (result) {
        dirSummaries.push(result);
        summaries.push(result);
        levels.directory++;
      }
    }
  }

  // 4. Group directories into modules (top-level src/* directories)
  const moduleGroups = new Map<string, HierarchicalSummary[]>();
  for (const dirSummary of dirSummaries) {
    // Extract module: first 2 path segments (e.g., "src/lib", "src/mcp")
    const parts = dirSummary.path.split('/');
    // Guard against root paths creating a cycle with the repo node
    const moduleKey =
      dirSummary.path === '.' || dirSummary.path === ''
        ? '__root__'
        : parts.length >= 2
          ? parts.slice(0, 2).join('/')
          : parts[0];
    const group = moduleGroups.get(moduleKey) ?? [];
    group.push(dirSummary);
    moduleGroups.set(moduleKey, group);
  }

  const moduleSummaries: HierarchicalSummary[] = [];
  const moduleEntries = [...moduleGroups.entries()].filter(([, dirs]) => dirs.length >= 1);

  for (const [moduleKey, moduleDirs] of moduleEntries) {
    try {
      const dirDescriptions = moduleDirs
        .map((d) => `- ${d.path}: ${d.summary}`)
        .join('\n')
        .slice(0, MAX_DIR_CONTENT_CHARS);

      const totalFiles = moduleDirs.reduce((sum, d) => sum + d.fileCount, 0);
      const totalLines = moduleDirs.reduce((sum, d) => sum + d.lineCount, 0);

      const prompt = `Summarize this code module in 2-3 sentences. Focus on its architectural role, major subsystems, and how they fit together.

Module: ${moduleKey}
Sub-directories (${moduleDirs.length}):
${dirDescriptions}

Summary:`;

      const summary = await callLLM(prompt);
      const moduleSummary: HierarchicalSummary = {
        path: moduleKey,
        level: 'module',
        summary,
        fileCount: totalFiles,
        lineCount: totalLines,
        children: moduleDirs.map((d) => d.path),
      };
      moduleSummaries.push(moduleSummary);
      summaries.push(moduleSummary);
      levels.module++;
    } catch (error) {
      logWarn('hierarchical', `Failed to summarize module ${moduleKey}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 5. Generate repo-level summary
  if (includeRepo && moduleSummaries.length > 0) {
    try {
      const moduleDescriptions = moduleSummaries
        .map((m) => `- ${m.path} (${m.fileCount} files): ${m.summary}`)
        .join('\n')
        .slice(0, MAX_DIR_CONTENT_CHARS);

      const totalFiles = files.length;
      const totalLines = files.reduce((sum, f) => sum + f.lineCount, 0);

      const prompt = `Summarize this entire codebase in 3-4 sentences. What does it do? What are its major components? What technologies does it use?

Project root: ${path.basename(root)}
Modules (${moduleSummaries.length}):
${moduleDescriptions}

Total: ${totalFiles} files, ~${totalLines} lines of code

Summary:`;

      const summary = await callLLM(prompt);
      summaries.push({
        path: '.',
        level: 'repo',
        summary,
        fileCount: totalFiles,
        lineCount: totalLines,
        children: moduleSummaries.map((m) => m.path),
      });
      levels.repo++;
    } catch (error) {
      logWarn('hierarchical', `Failed to generate repo summary`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logInfo(
    'hierarchical',
    `Generated ${summaries.length} summaries: ${levels.file} file, ${levels.directory} dir, ${levels.module} module, ${levels.repo} repo`
  );

  return {
    summaries,
    totalFiles: files.length,
    totalDirectories: dirGroups.size,
    levels,
  };
}

/**
 * Get the appropriate summary level for a query based on specificity.
 *
 * Heuristic: specific symbol/file queries → file level first,
 * then explicit scope keywords, then broad repo phrases.
 * Symbol checks must precede generic repo phrases so that
 * "what does myFunction do" resolves to file, not repo.
 */
export function inferSummaryLevel(query: string): SummaryLevel {
  const lower = query.toLowerCase();

  // File path detection — tokens containing a recognized code extension route to file scope
  const tokens = query.split(/\s+/);
  for (const token of tokens) {
    const ext = path.extname(token).slice(1).toLowerCase(); // strip leading dot
    if (ext && ext in EXTENSION_TO_LANGUAGE) return 'file';
  }

  // Specific symbol name check (camelCase, snake_case) — precise signal
  if (/[a-z][A-Z]/.test(query) || /[a-zA-Z]{2,}_[a-zA-Z]{2,}/.test(query)) return 'file';

  // Directory-level indicators (checked before repo to handle "describe this folder")
  const dirWords = ['directory', 'folder', 'namespace', 'dir '];
  if (dirWords.some((w) => lower.includes(w))) return 'directory';

  // Module-level indicators (checked before repo — "describe auth module" → module)
  const moduleWords = ['module', 'subsystem', 'component', 'layer', 'package'];
  if (moduleWords.some((w) => lower.includes(w))) return 'module';

  // Repo-level indicators — broad phrases that only match repo-scope queries
  const repoWords = [
    'project',
    'codebase',
    'repository',
    'overview',
    'architecture',
    'describe this',
    'what does this do',
  ];
  if (repoWords.some((w) => lower.includes(w))) return 'repo';

  // Default to directory (good middle ground)
  return 'directory';
}

// ============================================================================
// File Collection
// ============================================================================

async function collectFiles(
  dir: string,
  root: string,
  extensions: Set<string>,
  excludes: Set<string>,
  result: FileInfo[],
  maxFiles: number
): Promise<void> {
  if (result.length >= maxFiles) return;

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    logWarn('hierarchical', `Failed to read directory: ${dir}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const entry of entries) {
    if (result.length >= maxFiles) return;
    if (excludes.has(entry.name) || entry.name.startsWith('.')) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await collectFiles(fullPath, root, extensions, excludes, result, maxFiles);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!extensions.has(ext)) continue;

      try {
        const content = await fsp.readFile(fullPath, 'utf-8');
        const lineCount = content.split('\n').length;
        const symbols = extractExportedSymbols(content, ext);
        const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');

        result.push({
          relativePath,
          absolutePath: fullPath,
          content,
          lineCount,
          symbols,
        });
      } catch (error) {
        logWarn('hierarchical', `Failed to read file: ${fullPath}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
