/**
 * Brain Vault Export Formats — JSON, markdown pack, searchable snapshot.
 *
 * Phase 5.4: Export brain vault contents in multiple formats
 * for CI artifacts, sharing, and backup.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { getSuccDir, getProjectRoot } from './config.js';
import { logInfo, logWarn } from './fault-logger.js';

const require = createRequire(import.meta.url);
let _pkgVersion: string | undefined;
function getPackageVersion(): string {
  if (_pkgVersion) return _pkgVersion;
  try {
    const pkg = require('../../package.json') as { version: string };
    _pkgVersion = pkg.version;
  } catch {
    _pkgVersion = '0.0.0';
  }
  return _pkgVersion;
}

// ============================================================================
// Types
// ============================================================================

export interface BrainDoc {
  /** Relative path within brain vault */
  relativePath: string;
  /** Document title (from first heading or filename) */
  title: string;
  /** Raw markdown content */
  content: string;
  /** Frontmatter metadata (if any) */
  frontmatter: Record<string, unknown>;
  /** File modification time */
  modifiedAt: string;
  /** File size in bytes */
  sizeBytes: number;
}

export interface BrainExportResult {
  /** Format of the export */
  format: 'json' | 'markdown' | 'snapshot';
  /** Number of documents exported */
  documentCount: number;
  /** Total content size in bytes */
  totalBytes: number;
  /** Output path (if written to file) */
  outputPath?: string;
  /** Inline content (for small exports) */
  content?: string;
}

export interface BrainSnapshot {
  /** Export timestamp */
  exportedAt: string;
  /** Project root path */
  projectRoot: string;
  /** succ version */
  version: string;
  /** Brain vault documents */
  documents: BrainDoc[];
  /** Summary statistics */
  stats: {
    totalDocuments: number;
    totalBytes: number;
    categories: Record<string, number>;
  };
}

// ============================================================================
// Reading Brain Vault
// ============================================================================

/**
 * Read all markdown documents from the brain vault.
 */
export function readBrainVault(brainDir?: string): BrainDoc[] {
  const dir = brainDir ?? path.join(getSuccDir(), 'brain');

  if (!fs.existsSync(dir)) {
    logWarn('brain-export', `Brain vault not found at ${dir}`);
    return [];
  }

  const docs: BrainDoc[] = [];
  walkBrainDir(dir, dir, docs);

  docs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  logInfo('brain-export', `Read ${docs.length} brain vault documents`);
  return docs;
}

function walkBrainDir(baseDir: string, currentDir: string, docs: BrainDoc[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch (error) {
    logWarn('brain-export', `Failed to read directory: ${currentDir}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') || entry.name === '.meta') {
        walkBrainDir(baseDir, fullPath, docs);
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const stat = fs.statSync(fullPath);
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        const { title, frontmatter } = parseBrainDoc(content, entry.name);

        docs.push({
          relativePath,
          title,
          content,
          frontmatter,
          modifiedAt: stat.mtime.toISOString(),
          sizeBytes: stat.size,
        });
      } catch (error) {
        logWarn('brain-export', `Failed to read ${fullPath}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/**
 * Parse a brain doc for title and frontmatter.
 */
function parseBrainDoc(
  content: string,
  filename: string
): { title: string; frontmatter: Record<string, unknown> } {
  let frontmatter: Record<string, unknown> = {};
  let body = content;

  // Parse YAML frontmatter (handle both LF and CRLF line endings)
  const normalized = content.replace(/\r\n/g, '\n');
  if (normalized.startsWith('---\n')) {
    const endIdx = normalized.indexOf('\n---\n', 4);
    if (endIdx !== -1) {
      const fmBlock = normalized.substring(4, endIdx);
      frontmatter = parseSimpleYaml(fmBlock);
      body = normalized.substring(endIdx + 5);
    }
  }

  // Extract title from frontmatter or first heading
  const rawTitle = frontmatter.title;
  let title = rawTitle != null ? String(rawTitle) : '';
  if (!title) {
    const headingMatch = body.match(/^#\s+(.+)/m);
    title = headingMatch?.[1] ?? filename.replace(/\.md$/, '');
  }

  return { title, frontmatter };
}

/**
 * Simple YAML key-value parser (no dependency needed for basic frontmatter).
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const match = line.match(/^(\w[\w-]*)\s*:\s*(.+)?$/);
    if (!match) continue;

    const key = match[1];
    let value: unknown = match[2]?.trim() ?? '';

    // Parse basic types
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (typeof value === 'string' && /^\d+$/.test(value)) value = parseInt(value, 10);
    else if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      // Simple array: [a, b, c]
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s) => s.length > 0);
    } else if (typeof value === 'string' && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (typeof value === 'string' && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

// ============================================================================
// Export Formats
// ============================================================================

/**
 * Export brain vault as JSON.
 */
export function exportBrainAsJson(outputPath?: string, brainDir?: string): BrainExportResult {
  const docs = readBrainVault(brainDir);
  const snapshot = createSnapshot(docs, brainDir);
  const json = JSON.stringify(snapshot, null, 2);

  if (outputPath) {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, json, 'utf-8');

    logInfo('brain-export', `Exported ${docs.length} docs as JSON to ${outputPath}`);
    return {
      format: 'json',
      documentCount: docs.length,
      totalBytes: Buffer.byteLength(json),
      outputPath,
    };
  }

  return {
    format: 'json',
    documentCount: docs.length,
    totalBytes: Buffer.byteLength(json),
    content: json,
  };
}

/**
 * Export brain vault as a single concatenated markdown file.
 */
export function exportBrainAsMarkdown(outputPath?: string, brainDir?: string): BrainExportResult {
  const docs = readBrainVault(brainDir);

  const lines: string[] = [];
  lines.push('# Brain Vault Export');
  lines.push('');
  lines.push(`> Exported at ${new Date().toISOString()}`);
  lines.push(`> ${docs.length} documents`);
  lines.push('');

  // Table of contents
  lines.push('## Table of Contents');
  lines.push('');
  const anchorCounts = new Map<string, number>();
  for (const doc of docs) {
    let anchor = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const count = anchorCounts.get(anchor) ?? 0;
    anchorCounts.set(anchor, count + 1);
    if (count > 0) anchor = `${anchor}-${count}`;
    lines.push(`- [${doc.title}](#${anchor})`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Document contents
  for (const doc of docs) {
    lines.push(`## ${doc.title}`);
    lines.push('');
    lines.push(`*Source: \`${doc.relativePath}\` | Modified: ${doc.modifiedAt}*`);
    lines.push('');
    // Strip frontmatter from content for the pack (handle CRLF)
    let body = doc.content.replace(/\r\n/g, '\n');
    if (body.startsWith('---\n')) {
      const endIdx = body.indexOf('\n---\n', 4);
      if (endIdx !== -1) {
        body = body.substring(endIdx + 5);
      }
    }
    lines.push(body.trim());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  const markdown = lines.join('\n');

  if (outputPath) {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, markdown, 'utf-8');

    logInfo('brain-export', `Exported ${docs.length} docs as markdown pack to ${outputPath}`);
    return {
      format: 'markdown',
      documentCount: docs.length,
      totalBytes: Buffer.byteLength(markdown),
      outputPath,
    };
  }

  return {
    format: 'markdown',
    documentCount: docs.length,
    totalBytes: Buffer.byteLength(markdown),
    content: markdown,
  };
}

/**
 * Export brain vault as a searchable snapshot (JSON with full text index metadata).
 */
export function exportBrainSnapshot(outputPath?: string, brainDir?: string): BrainExportResult {
  const docs = readBrainVault(brainDir);
  const snapshot = createSnapshot(docs, brainDir);

  // Add search index metadata
  const searchableSnapshot = {
    ...snapshot,
    searchIndex: docs.map((doc) => ({
      path: doc.relativePath,
      title: doc.title,
      // Extract headings for search
      headings: extractHeadings(doc.content),
      // Extract key terms (simple word frequency)
      keyTerms: extractKeyTerms(doc.content),
      wordCount: doc.content.trim() ? doc.content.trim().split(/\s+/).length : 0,
    })),
  };

  const json = JSON.stringify(searchableSnapshot, null, 2);

  if (outputPath) {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, json, 'utf-8');

    logInfo('brain-export', `Exported ${docs.length} docs as searchable snapshot to ${outputPath}`);
    return {
      format: 'snapshot',
      documentCount: docs.length,
      totalBytes: Buffer.byteLength(json),
      outputPath,
    };
  }

  return {
    format: 'snapshot',
    documentCount: docs.length,
    totalBytes: Buffer.byteLength(json),
    content: json,
  };
}

// ============================================================================
// Internal
// ============================================================================

function createSnapshot(docs: BrainDoc[], brainDir?: string): BrainSnapshot {
  const categories: Record<string, number> = {};
  for (const doc of docs) {
    const category = doc.relativePath.includes('/') ? doc.relativePath.split('/')[0] : 'root';
    categories[category] = (categories[category] ?? 0) + 1;
  }

  // Derive projectRoot from brainDir when caller provides an explicit vault path.
  // Default layout is <projectRoot>/.succ/brain, so go up two levels.
  const projectRoot = brainDir
    ? path.resolve(brainDir, '..', '..')
    : (getProjectRoot() ?? process.cwd());

  return {
    exportedAt: new Date().toISOString(),
    projectRoot,
    version: getPackageVersion(),
    documents: docs,
    stats: {
      totalDocuments: docs.length,
      totalBytes: docs.reduce((sum, d) => sum + d.sizeBytes, 0),
      categories,
    },
  };
}

function extractHeadings(content: string): string[] {
  const headings: string[] = [];
  const regex = /^#{1,6}\s+(.+)/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    headings.push(match[1].trim());
  }
  return headings;
}

function extractKeyTerms(content: string, limit: number = 20): string[] {
  // Strip markdown formatting
  const text = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/[#*_\[\]()>|~-]/g, ' ')
    .toLowerCase();

  // Count word frequency
  const words = text.split(/\s+/).filter((w) => w.length > 3);
  const freq = new Map<string, number>();
  const stopWords = new Set([
    'this',
    'that',
    'with',
    'from',
    'have',
    'will',
    'been',
    'they',
    'their',
    'what',
    'when',
    'where',
    'which',
    'while',
    'more',
    'about',
    'other',
    'than',
    'then',
    'these',
    'some',
    'your',
    'each',
    'make',
    'like',
    'just',
    'also',
    'into',
    'only',
    'over',
    'such',
    'after',
    'should',
    'would',
    'could',
  ]);

  for (const word of words) {
    if (stopWords.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  // Sort by frequency, take top N
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}
