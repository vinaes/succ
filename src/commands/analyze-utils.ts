import fs from 'fs';
import path from 'path';
import { withLock } from '../lib/lock.js';
import type { Agent } from './analyze-agents.js';
import type { ProfileItem } from './analyze-profile.js';

export interface AgentTiming {
  name: string;
  durationMs: number;
  success: boolean;
}

export interface MultiPassOptions {
  type: 'systems' | 'features';
  projectName: string;
  items: ProfileItem[];
  callLLM: (prompt: string, context: string) => Promise<string>;
  concurrency: number;
  broadContext: string;
  projectRoot: string;
  onProgress: (completed: number, total: number, current: string) => void;
}

export interface MultiPassResult {
  succeeded: Array<{ name: string; content: string }>;
  failed: Array<{ name: string; error: string }>;
}

/**
 * Sanitize a profile item name into a safe filename.
 * Replaces /\:*?"<>| with dashes, collapses runs, trims.
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

/**
 * Programmatic MOC (Map of Content) for Systems Overview or Features Overview.
 * No LLM call — deterministic, zero-cost.
 */
export function buildMocContent(
  type: 'systems' | 'features',
  projectName: string,
  items: Array<{ name: string; description: string; keyFile: string }>
): string {
  const typeLabel = type === 'systems' ? 'Systems' : 'Features';
  const typeSingular = type === 'systems' ? 'system' : 'feature';
  const parentLink = type === 'systems' ? `[[Architecture Overview]]` : `[[${projectName}]]`;

  const lines: string[] = [
    '---',
    `description: "${typeLabel} overview and map of content"`,
    `project: ${projectName}`,
    `type: ${type === 'systems' ? 'systems' : 'features'}`,
    'relevance: high',
    '---',
    '',
    `# ${typeLabel} Overview`,
    '',
    `**Parent:** ${parentLink}`,
    '',
  ];

  if (items.length === 0) {
    lines.push(`No ${type} documented yet.`);
  } else {
    lines.push(
      `| ${typeSingular[0].toUpperCase() + typeSingular.slice(1)} | Description | Key File |`
    );
    lines.push('|--------|-------------|----------|');
    for (const item of items) {
      lines.push(`| [[${item.name}]] | ${item.description} | \`${item.keyFile}\` |`);
    }
    lines.push('');
    if (type === 'systems') {
      lines.push('See [[Architecture Overview]] for system interactions.');
    } else {
      lines.push(`See [[${projectName}]] for project overview.`);
    }
  }

  lines.push('');
  lines.push('---');
  return lines.join('\n');
}

/**
 * Build a focused LLM prompt for ONE system or feature.
 * Each item gets its own API call with full token budget.
 */
export function buildItemPrompt(
  type: 'systems' | 'features',
  projectName: string,
  item: ProfileItem
): string {
  const parentLink = type === 'systems' ? '[[Systems Overview]]' : '[[Features Overview]]';

  const frontmatter = [
    '---',
    `description: "${item.description}"`,
    `project: ${projectName}`,
    `type: ${type === 'systems' ? 'system' : 'feature'}`,
    'relevance: high',
    '---',
  ].join('\n');

  const obsidianGuide = [
    'OUTPUT FORMAT: Obsidian-compatible markdown.',
    'Use [[wikilinks]] to link to other docs. Use ```mermaid for diagrams.',
    'Use > [!note], > [!warning] for callouts.',
    'CRITICAL: NEVER put [[wikilinks]] inside ```mermaid blocks — they break rendering. Use plain text labels like A["Storage System"] instead.',
  ].join('\n');

  if (type === 'systems') {
    return `You are documenting ONE system of a software project called "${projectName}".

Write a detailed document for the "${item.name}" system.
Key file: \`${item.keyFile}\`
Description: ${item.description}

Your output MUST start with this exact YAML frontmatter:
${frontmatter}

Then write:
# ${item.name}

**Parent:** ${parentLink}

## Purpose
What this system does and why it exists. 2-3 sentences minimum.

## Key Components
Bullet list of major modules/classes/files with brief descriptions.

## Architecture
A \`\`\`mermaid diagram (flowchart, sequence, or class) showing how components interact.

## API / Interface
Real function signatures or types from the key file. Use \`\`\`typescript code blocks.
Show the ACTUAL exports and public API — do not invent signatures.

## Dependencies
Which other systems this depends on, using [[wikilinks]].

DEPTH REQUIREMENT: 300-500 words minimum. Reference REAL file paths from the codebase.
${obsidianGuide}

Output ONLY the markdown document. No preamble, no explanations.`;
  } else {
    return `You are documenting ONE feature of a software project called "${projectName}".

Write a detailed document for the "${item.name}" feature.
Key file: \`${item.keyFile}\`
Description: ${item.description}

Your output MUST start with this exact YAML frontmatter:
${frontmatter}

Then write:
# ${item.name}

**Parent:** ${parentLink}

## Overview
What this feature does from the USER's perspective. 2-3 sentences minimum.

## Capabilities
Bullet list of what users can do with this feature.

## Key Files
Real file paths with brief descriptions of each file's role.

## Usage Examples
Real CLI commands, MCP tool calls, or API examples showing how to use this feature.
Use \`\`\`bash or \`\`\`typescript code blocks.

## Data Flow
A \`\`\`mermaid diagram (flowchart or sequence) showing the processing pipeline.

## Related Features
Links to related features using [[wikilinks]].

## Configuration
Any config options, environment variables, or settings that affect this feature.

DEPTH REQUIREMENT: 300-500 words minimum. Reference REAL file paths from the codebase.
${obsidianGuide}

Output ONLY the markdown document. No preamble, no explanations.`;
  }
}

/**
 * Targeted context for one system/feature: broad header + keyFile + siblings.
 */
export function gatherItemContext(
  projectRoot: string,
  item: ProfileItem,
  broadHeader: string
): string {
  const parts: string[] = [broadHeader];

  // Full keyFile content (up to 8000 chars)
  if (item.keyFile) {
    const keyFilePath = path.join(projectRoot, item.keyFile);
    if (fs.existsSync(keyFilePath)) {
      try {
        const content = fs.readFileSync(keyFilePath, 'utf-8').slice(0, 8000);
        parts.push(`## Key File: ${item.keyFile}\n\`\`\`\n${content}\n\`\`\`\n`);
      } catch {
        /* skip unreadable */
      }
    }
  }

  // Up to 3 sibling files from the same directory (3000 chars each)
  if (item.keyFile) {
    const keyDir = path.dirname(path.join(projectRoot, item.keyFile));
    if (fs.existsSync(keyDir)) {
      try {
        const siblings = fs
          .readdirSync(keyDir)
          .filter(
            (f) => f !== path.basename(item.keyFile) && /\.(ts|js|py|rs|go|java|rb)$/i.test(f)
          )
          .slice(0, 3);
        for (const sibling of siblings) {
          const siblingPath = path.join(keyDir, sibling);
          try {
            const content = fs.readFileSync(siblingPath, 'utf-8').slice(0, 3000);
            const relPath = path.relative(projectRoot, siblingPath).replace(/\\/g, '/');
            parts.push(`## ${relPath}\n\`\`\`\n${content}\n\`\`\`\n`);
          } catch {
            /* skip */
          }
        }
      } catch {
        /* skip */
      }
    }
  }

  return parts.join('\n');
}

/**
 * Run multi-pass: individual API calls per system/feature with concurrency control.
 */
export async function runMultiPassItems(opts: MultiPassOptions): Promise<MultiPassResult> {
  const { type, projectName, items, callLLM, concurrency, broadContext, projectRoot, onProgress } =
    opts;
  const succeeded: Array<{ name: string; content: string }> = [];
  const failed: Array<{ name: string; error: string }> = [];

  // Manual semaphore for concurrency control (queue of waiters)
  let running = 0;
  const waiters: Array<() => void> = [];

  const acquireSlot = async () => {
    if (running < concurrency) {
      running++;
      return;
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
    running++;
  };

  const releaseSlot = () => {
    running--;
    if (waiters.length > 0) {
      const next = waiters.shift()!;
      next();
    }
  };

  let completed = 0;
  const total = items.length;

  const processItem = async (item: ProfileItem) => {
    await acquireSlot();

    // 200ms stagger to avoid rate limiting bursts
    await new Promise((resolve) => setTimeout(resolve, 200));

    const safeName = sanitizeFilename(item.name);
    const prompt = buildItemPrompt(type, projectName, item);
    const context = gatherItemContext(projectRoot, item, broadContext);

    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await callLLM(prompt, context);
        if (!raw || raw.trim().length < 50) {
          lastError = 'Empty or too-short response';
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          continue;
        }
        const content = cleanMarkdownOutput(raw);
        succeeded.push({ name: safeName, content });
        completed++;
        onProgress(completed, total, item.name);
        releaseSlot();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    // Both attempts failed
    failed.push({ name: safeName, error: lastError });
    completed++;
    onProgress(completed, total, `${item.name} (FAILED)`);
    releaseSlot();
  };

  // Launch all items concurrently (semaphore controls actual parallelism)
  await Promise.all(items.map(processItem));

  return { succeeded, failed };
}

/**
 * Clean markdown output by removing code fences and preamble text that LLMs sometimes add
 */
export function cleanMarkdownOutput(content: string): string {
  let cleaned = content.trim();

  // Remove leading ```markdown or ```md
  if (/^```(?:markdown|md)?\s*\n/i.test(cleaned)) {
    cleaned = cleaned.replace(/^```(?:markdown|md)?\s*\n/i, '');
  }

  // Remove trailing ```
  if (/\n```\s*$/.test(cleaned)) {
    cleaned = cleaned.replace(/\n```\s*$/, '');
  }

  // Remove any preamble text before YAML frontmatter (LLMs sometimes add explanations)
  // Look for the YAML frontmatter start and remove everything before it
  const yamlMatch = cleaned.match(/^[\s\S]*?(---\n[\s\S]*?\n---)/);
  if (yamlMatch && yamlMatch[1]) {
    const yamlStart = cleaned.indexOf('---\n');
    if (yamlStart > 0) {
      // There's text before the frontmatter, remove it
      cleaned = cleaned.substring(yamlStart);
    }
  }

  return cleaned.trim();
}

/**
 * Parse multi-file output from agents that create multiple files
 * Format: ===FILE: filename.md===\ncontent\n===FILE: next.md===
 */
export function parseMultiFileOutput(
  content: string,
  baseDir: string
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const cleaned = cleanMarkdownOutput(content);

  // Split by ===FILE: marker
  const parts = cleaned.split(/\n?===FILE:\s*/i);

  // First part is the main file content (before any ===FILE: markers)
  const mainContent = parts[0].trim();
  if (mainContent) {
    files.push({ path: '', content: mainContent }); // Empty path = use agent's outputPath
  }

  // Remaining parts are additional files
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const match = part.match(/^([^=\n]+\.md)===\s*\n?([\s\S]*)/i);
    if (match) {
      const filename = match[1].trim();
      const fileContent = cleanMarkdownOutput(match[2]);
      if (fileContent) {
        files.push({
          path: path.join(baseDir, filename),
          content: fileContent,
        });
      }
    }
  }

  return files;
}

/**
 * Clean old sub-files from a directory before writing new multi-file output.
 * Prevents duplicates when different models produce different filenames.
 * Keeps the overview file (agent's main outputPath) and non-analyze files.
 */
export function cleanAgentSubfiles(outputDir: string, overviewPath: string): void {
  if (!fs.existsSync(outputDir)) return;

  const overviewName = path.basename(overviewPath).toLowerCase();
  const entries = fs.readdirSync(outputDir);

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;

    // Skip the overview file itself — it gets overwritten
    if (entry.toLowerCase() === overviewName) continue;

    // Skip non-analyze files (decision exports, session logs, MOC stubs, manual docs)
    const lowerEntry = entry.toLowerCase();
    if (
      lowerEntry.startsWith('2026-') ||
      lowerEntry.startsWith('2025-') ||
      lowerEntry === 'sessions.md' ||
      lowerEntry === 'decisions.md' ||
      lowerEntry === 'technical.md' ||
      lowerEntry === 'strategy.md'
    )
      continue;

    const filePath = path.join(outputDir, entry);
    try {
      // Only delete files with analyze-generated frontmatter (project + type fields)
      const head = fs.readFileSync(filePath, 'utf-8').slice(0, 300);
      if (head.startsWith('---') && /^project:\s/m.test(head) && /^type:\s/m.test(head)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Skip files that can't be read
    }
  }
}

/**
 * Write agent output, handling multi-file outputs
 * Note: File writes are atomic (fs.writeFileSync), but we use lock
 * to prevent daemon from writing while CLI might be reading
 */
export async function writeAgentOutput(agent: Agent, content: string): Promise<void> {
  await withLock('daemon-write', async () => {
    const outputDir = path.dirname(agent.outputPath);
    fs.mkdirSync(outputDir, { recursive: true });

    // Check if this is multi-file output
    if (content.includes('===FILE:')) {
      // Clean old sub-files to prevent duplicates across model runs
      cleanAgentSubfiles(outputDir, agent.outputPath);

      const files = parseMultiFileOutput(content, outputDir);

      for (const file of files) {
        const filePath = file.path || agent.outputPath;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, file.content);
      }
    } else {
      // Single file output
      const cleanedOutput = cleanMarkdownOutput(content);
      fs.writeFileSync(agent.outputPath, cleanedOutput);
    }
  });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

export function printTimingSummary(timings: AgentTiming[], totalMs: number): void {
  console.log('\n--- Timing Summary ---');
  for (const t of timings) {
    const icon = t.success ? '✓' : '✗';
    console.log(`  ${icon} ${t.name}: ${formatDuration(t.durationMs)}`);
  }
  console.log(`  Total: ${formatDuration(totalMs)}`);
}

export async function ensureBrainStructure(brainDir: string, _projectRoot: string): Promise<void> {
  const dirs = [
    brainDir,
    path.join(brainDir, '.meta'),
    path.join(brainDir, '.obsidian'),
    path.join(brainDir, 'inbox'),
    path.join(brainDir, 'project', 'technical'),
    path.join(brainDir, 'project', 'decisions'),
    path.join(brainDir, 'project', 'features'),
    path.join(brainDir, 'knowledge'),
    path.join(brainDir, 'archive'),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export async function generateIndexFiles(brainDir: string, projectName: string): Promise<void> {
  // CLAUDE.md (root)
  const claudeMd = `# Brain Vault

Knowledge vault for ${projectName}. Stores decisions, ideas, research, learnings.

## Philosophy

**For Claude, not humans.** Structure for retrieval.

- **Filenames are claims** — Titles state what note argues
- **YAML frontmatter** — description, project, type, relevance
- **Wikilinks** — Connect ideas with \`[[note-name]]\`
- **Atomic notes** — One idea per file

## Structure

\`\`\`
CLAUDE.md (this file)
├── .meta/                          # Brain's self-knowledge
│   └── learnings.md               # Patterns, improvements log
├── inbox/                          # Quick captures
├── project/                        # → [[${projectName}]]
│   ├── technical/                 # Architecture, API, patterns
│   ├── decisions/                 # ADRs
│   └── features/                  # Feature specs
├── knowledge/                      # Research, ideas
└── archive/                        # Old/superseded
\`\`\`

## Quick Start

**Project overview:** [[${projectName}]]

**Architecture:** [[Architecture Overview]]
`;

  fs.writeFileSync(path.join(brainDir, 'CLAUDE.md'), claudeMd);

  // Project index
  const projectMd = `---
description: "${projectName} project knowledge base"
project: ${projectName}
type: index
relevance: high
---

# ${projectName}

**Parent:** [[CLAUDE]]

## Categories

| Category | Description |
|----------|-------------|
| Technical | Architecture, API, patterns |
| Decisions | Architecture decisions |
| Features | Feature specs |

## Quick Access

**Start here:** [[Architecture Overview]]

**API:** [[API Reference]]

**Conventions:** [[Conventions]]
`;

  fs.writeFileSync(path.join(brainDir, 'project', `${projectName}.md`), projectMd);

  // Learnings
  const learningsMd = `# Learnings

Lessons learned during development.

## Format

- **YYYY-MM-DD**: What was learned
`;

  const learningsPath = path.join(brainDir, '.meta', 'learnings.md');
  if (!fs.existsSync(learningsPath)) {
    fs.writeFileSync(learningsPath, learningsMd);
  }

  // Obsidian graph config
  const graphJson = {
    'collapse-filter': false,
    search: '',
    showTags: false,
    showAttachments: false,
    hideUnresolved: false,
    showOrphans: true,
    'collapse-color-groups': false,
    colorGroups: [
      { query: 'file:CLAUDE', color: { a: 1, rgb: 16007990 } }, // Red
      { query: `file:${projectName}`, color: { a: 1, rgb: 16750848 } }, // Orange
      { query: 'path:technical', color: { a: 1, rgb: 2201331 } }, // Blue
      { query: 'path:decisions', color: { a: 1, rgb: 10040217 } }, // Purple
      { query: 'path:features', color: { a: 1, rgb: 5025616 } }, // Green
      { query: 'path:knowledge', color: { a: 1, rgb: 16776960 } }, // Yellow
      { query: 'path:archive', color: { a: 1, rgb: 8421504 } }, // Gray
    ],
    'collapse-display': false,
    showArrow: false,
    textFadeMultiplier: 0,
    nodeSizeMultiplier: 1,
    lineSizeMultiplier: 1,
    'collapse-forces': false,
    centerStrength: 0.5,
    repelStrength: 10,
    linkStrength: 1,
    linkDistance: 250,
    scale: 1,
    close: false,
  };

  fs.writeFileSync(
    path.join(brainDir, '.obsidian', 'graph.json'),
    JSON.stringify(graphJson, null, 2)
  );
}
