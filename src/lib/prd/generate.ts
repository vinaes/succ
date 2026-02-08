/**
 * PRD Generator
 *
 * Generates a structured PRD markdown from a high-level description.
 * Enriches the LLM prompt with real codebase context.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { callLLM } from '../llm.js';
import { getProjectRoot, getConfig } from '../config.js';
import type { QualityGatesConfig } from '../config.js';
import { PRD_GENERATE_PROMPT } from '../../prompts/prd.js';
import { gatherCodebaseContext, formatContext } from './codebase-context.js';
import { createPrd, createGate } from './types.js';
import { savePrd, savePrdMarkdown, saveTasks } from './state.js';
import { parsePrd } from './parse.js';
import type { Prd, Task, QualityGate, ExecutionMode } from './types.js';

// ============================================================================
// Generate result
// ============================================================================

export interface GenerateResult {
  prd: Prd;
  markdown: string;
  tasks?: Task[];
  parseWarnings?: string[];
}

// ============================================================================
// Quality gate auto-detection (with monorepo support)
// ============================================================================

/** Config files we scan for when detecting project roots. */
const CONFIG_FILES = [
  'tsconfig.json', 'package.json', 'go.mod',
  'pyproject.toml', 'setup.py', 'Cargo.toml', '.golangci.yml',
];

/** Directories to skip during subdirectory scanning. */
const IGNORE_DIRS = new Set([
  'node_modules', 'dist', '.git', '.succ', '.claude', 'vendor',
  'coverage', '.next', '.cache', '__pycache__', 'build', 'out',
]);

/** A directory that contains project config files. */
export interface ProjectRoot {
  relPath: string;        // '' for root, 'frontend', 'apps/web', etc.
  configs: Set<string>;   // config file basenames found
}

/**
 * Check if a CLI tool is available on PATH.
 *
 * NOTE: execSync is used intentionally here — the binary name is always a
 * hardcoded string (e.g., 'golangci-lint'), never user input.
 */
export function binaryAvailable(name: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    execSync(cmd, { stdio: 'pipe', timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan for directories containing recognized config files.
 * Checks project root + up to maxDepth levels of subdirectories.
 */
export function discoverProjectRoots(root: string, maxDepth = 2): ProjectRoot[] {
  const results: ProjectRoot[] = [];

  function checkDir(dir: string): Set<string> {
    const found = new Set<string>();
    for (const f of CONFIG_FILES) {
      if (fs.existsSync(path.join(dir, f))) found.add(f);
    }
    return found;
  }

  // Check root
  const rootConfigs = checkDir(root);
  if (rootConfigs.size > 0) {
    results.push({ relPath: '', configs: rootConfigs });
  }

  // Scan subdirectories
  function scanDir(dir: string, relBase: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry) || entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      const rel = relBase ? `${relBase}/${entry}` : entry;
      const configs = checkDir(full);
      if (configs.size > 0) {
        results.push({ relPath: rel, configs });
      }
      if (depth < maxDepth) {
        scanDir(full, rel, depth + 1);
      }
    }
  }

  scanDir(root, '', 1);
  return results;
}

/**
 * Detect quality gates for a single project root directory.
 */
export function detectGatesForRoot(projectRoot: ProjectRoot, absRoot: string): QualityGate[] {
  const gates: QualityGate[] = [];
  const dir = projectRoot.relPath
    ? path.join(absRoot, projectRoot.relPath)
    : absRoot;
  const prefix = projectRoot.relPath
    ? `cd "${projectRoot.relPath.replace(/\\/g, '/')}" && `
    : '';

  // TypeScript
  if (projectRoot.configs.has('tsconfig.json')) {
    gates.push(createGate('typecheck', prefix + 'npx tsc --noEmit'));
  }

  // npm test
  if (projectRoot.configs.has('package.json')) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const testScript = pkg.scripts?.test ?? '';
      if (testScript && testScript !== 'echo "Error: no test specified" && exit 1') {
        if (testScript.includes('vitest') && !testScript.includes('--run')) {
          gates.push(createGate('test', prefix + 'npx vitest run --exclude "**/*integration*test*"'));
        } else {
          gates.push(createGate('test', prefix + testScript));
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  // Python
  if (projectRoot.configs.has('pyproject.toml') || projectRoot.configs.has('setup.py')) {
    gates.push(createGate('test', prefix + 'pytest'));
  }

  // Go
  if (projectRoot.configs.has('go.mod')) {
    gates.push(createGate('build', prefix + 'go build ./...'));
    gates.push(createGate('test', prefix + 'go test ./...'));
    gates.push(createGate('lint', prefix + 'go vet ./...'));

    // golangci-lint: add if .golangci.yml exists OR binary available
    if (projectRoot.configs.has('.golangci.yml') || binaryAvailable('golangci-lint')) {
      gates.push(createGate('lint', prefix + 'golangci-lint run', false)); // optional
    }
  }

  // Rust
  if (projectRoot.configs.has('Cargo.toml')) {
    gates.push(createGate('build', prefix + 'cargo build'));
    gates.push(createGate('test', prefix + 'cargo test'));
  }

  return gates;
}

/**
 * Convert a GateConfig from config.json into a QualityGate.
 */
function gateFromConfig(cfg: { type: string; command: string; required?: boolean; timeout_ms?: number }, prefix = ''): QualityGate {
  return createGate(
    cfg.type as QualityGate['type'],
    prefix + cfg.command,
    cfg.required ?? true,
    cfg.timeout_ms,
  );
}

/**
 * Detect quality gates based on project files and config.
 * Scans project root and up to 2 levels of subdirectories for monorepo support.
 * Root config files shadow subdirectory configs of the same type.
 * Config in .succ/config.json can add, disable, or override gates.
 */
export function detectQualityGates(configOverride?: QualityGatesConfig): QualityGate[] {
  const root = getProjectRoot();
  const gatesCfg: QualityGatesConfig | undefined = configOverride ?? getConfig().quality_gates;

  const gates: QualityGate[] = [];

  // Auto-detect from project files (default: true)
  if (gatesCfg?.auto_detect !== false) {
    const projectRoots = discoverProjectRoots(root);
    const rootEntry = projectRoots.find(r => r.relPath === '');
    const subEntries = projectRoots.filter(r => r.relPath !== '');
    const rootConfigTypes = new Set<string>();

    if (rootEntry) {
      gates.push(...detectGatesForRoot(rootEntry, root));
      for (const c of rootEntry.configs) rootConfigTypes.add(c);
    }

    for (const sub of subEntries) {
      const uniqueConfigs = new Set(
        [...sub.configs].filter(c => !rootConfigTypes.has(c))
      );
      if (uniqueConfigs.size === 0) continue;
      const filtered: ProjectRoot = { relPath: sub.relPath, configs: uniqueConfigs };
      gates.push(...detectGatesForRoot(filtered, root));
    }

    // Apply root-level disable filter
    if (gatesCfg?.disable?.length) {
      const disabled = new Set(gatesCfg.disable);
      for (let i = gates.length - 1; i >= 0; i--) {
        if (disabled.has(gates[i].type)) gates.splice(i, 1);
      }
    }

    // Apply per-subdir disable filters
    if (gatesCfg?.subdirs) {
      for (const [subdir, subdirCfg] of Object.entries(gatesCfg.subdirs)) {
        if (!subdirCfg.disable?.length) continue;
        const disabledTypes = new Set(subdirCfg.disable);
        const prefix = `cd "${subdir}" && `;
        for (let i = gates.length - 1; i >= 0; i--) {
          if (disabledTypes.has(gates[i].type) && gates[i].command.startsWith(prefix)) {
            gates.splice(i, 1);
          }
        }
      }
    }
  }

  // Append root-level config gates
  if (gatesCfg?.gates?.length) {
    for (const g of gatesCfg.gates) {
      gates.push(gateFromConfig(g));
    }
  }

  // Append per-subdirectory config gates
  if (gatesCfg?.subdirs) {
    for (const [subdir, subdirCfg] of Object.entries(gatesCfg.subdirs)) {
      if (!subdirCfg.gates?.length) continue;
      const prefix = `cd "${subdir}" && `;
      for (const g of subdirCfg.gates) {
        gates.push(gateFromConfig(g, prefix));
      }
    }
  }

  return gates;
}

/**
 * Parse custom gate specification: "type:command" or just "command"
 */
function parseGateSpec(spec: string): QualityGate {
  const parts = spec.split(':');
  if (parts.length >= 2) {
    const type = parts[0] as QualityGate['type'];
    const command = parts.slice(1).join(':');
    return createGate(type, command);
  }
  return createGate('custom', spec);
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Generate a PRD from a description.
 *
 * @param description - High-level feature description
 * @param options - Generation options
 * @returns GenerateResult with the PRD and markdown
 */
export async function generatePrd(
  description: string,
  options: {
    mode?: ExecutionMode;
    gates?: string;        // comma-separated gate specs
    autoParse?: boolean;
    model?: string;
  } = {}
): Promise<GenerateResult> {
  // 1. Gather codebase context
  const context = await gatherCodebaseContext(description);
  const contextStr = formatContext(context);

  // 2. Build prompt
  const prompt = PRD_GENERATE_PROMPT
    .replace('{codebase_context}', contextStr)
    .replace('{description}', description);

  // 3. Call LLM to generate PRD markdown
  const markdown = await callLLM(prompt, {
    maxTokens: 6000,
    temperature: 0.5,
    timeout: 120_000,  // PRD generation needs more time than default 30s
  });

  // 4. Detect or parse quality gates
  let qualityGates: QualityGate[];
  if (options.gates) {
    qualityGates = options.gates.split(',').map(s => parseGateSpec(s.trim()));
  } else {
    qualityGates = detectQualityGates();
  }

  // 5. Extract title from markdown
  const title = extractTitle(markdown, description);

  // 6. Create PRD object
  const prd = createPrd({
    title,
    description,
    execution_mode: options.mode ?? 'loop',
    goals: extractGoals(markdown),
    out_of_scope: extractOutOfScope(markdown),
    quality_gates: qualityGates,
  });

  // 7. Save PRD
  savePrd(prd);
  savePrdMarkdown(prd.id, markdown);

  const result: GenerateResult = { prd, markdown };

  // 8. Auto-parse if requested
  if (options.autoParse) {
    const parseResult = await parsePrd(markdown, prd.id, description);
    result.tasks = parseResult.tasks;
    result.parseWarnings = parseResult.warnings;

    // Save tasks and update PRD status to 'ready'
    if (parseResult.tasks.length > 0) {
      saveTasks(prd.id, parseResult.tasks);
      prd.status = 'ready';
      prd.stats.total_tasks = parseResult.tasks.length;
      savePrd(prd);
    }
  }

  return result;
}

// ============================================================================
// Extraction helpers
// ============================================================================

/**
 * Extract title from PRD markdown (first # heading)
 */
function extractTitle(markdown: string, fallback: string): string {
  const match = markdown.match(/^#\s+(?:PRD:\s*)?(.+)$/m);
  if (match) return match[1].trim();
  return fallback.slice(0, 80);
}

/**
 * Extract goals from PRD markdown
 */
function extractGoals(markdown: string): string[] {
  return extractListSection(markdown, 'Goals');
}

/**
 * Extract out of scope items from PRD markdown
 */
function extractOutOfScope(markdown: string): string[] {
  return extractListSection(markdown, 'Out of Scope');
}

/**
 * Extract a bullet list from a named section
 */
function extractListSection(markdown: string, sectionName: string): string[] {
  // Match section header and content until next section
  const pattern = new RegExp(
    `##\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
    'i'
  );
  const match = markdown.match(pattern);
  if (!match) return [];

  const content = match[1];
  const items: string[] = [];
  for (const line of content.split('\n')) {
    const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
    if (bulletMatch) {
      items.push(bulletMatch[1].trim());
    }
  }
  return items;
}
