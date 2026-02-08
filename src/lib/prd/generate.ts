/**
 * PRD Generator
 *
 * Generates a structured PRD markdown from a high-level description.
 * Enriches the LLM prompt with real codebase context.
 */

import fs from 'fs';
import path from 'path';
import { callLLM } from '../llm.js';
import { getProjectRoot } from '../config.js';
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
// Quality gate auto-detection
// ============================================================================

/**
 * Detect quality gates based on project files.
 */
function detectQualityGates(): QualityGate[] {
  const root = getProjectRoot();
  const gates: QualityGate[] = [];

  // TypeScript
  if (fs.existsSync(path.join(root, 'tsconfig.json'))) {
    gates.push(createGate('typecheck', 'npx tsc --noEmit'));
  }

  // npm test
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        gates.push(createGate('test', 'npm test'));
      }
    } catch {
      // ignore parse errors
    }
  }

  // Python
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'setup.py'))) {
    gates.push(createGate('test', 'pytest'));
  }

  // Go
  if (fs.existsSync(path.join(root, 'go.mod'))) {
    gates.push(createGate('build', 'go build ./...'));
    gates.push(createGate('test', 'go test ./...'));
  }

  // Rust
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    gates.push(createGate('build', 'cargo build'));
    gates.push(createGate('test', 'cargo test'));
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
