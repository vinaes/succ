import spawn from 'cross-spawn';
import { spawnClaudeCLI } from '../lib/llm.js';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import ora from 'ora';
import { getProjectRoot, getSuccDir, getConfig, getLLMTaskConfig } from '../lib/config.js';
import { withLock } from '../lib/lock.js';
import {
  loadAnalyzeState, saveAnalyzeState, getGitHead, getChangedFiles,
  hashFile, shouldRerunAgent, type AnalyzeState
} from '../lib/analyze-state.js';
import { logError, logWarn } from '../lib/fault-logger.js';

interface AnalyzeOptions {
  parallel?: boolean;
  api?: boolean;
  background?: boolean;
  fast?: boolean;
  force?: boolean;
}

interface Agent {
  name: string;
  outputPath: string;
  prompt: string;
}

interface ProjectProfile {
  languages: string[];
  sourceExtensions: string[];
  testPatterns: string[];
  ignoreDirectories: string[];
  projectFiles: string[];
  entryPoints: string[];
  keyFiles: string[];
  systems: Array<{ name: string; keyFile: string; description: string }>;
  features: Array<{ name: string; keyFile: string; description: string }>;
}

interface ProfileItem {
  name: string;
  keyFile: string;
  description: string;
}

interface MultiPassOptions {
  type: 'systems' | 'features';
  projectName: string;
  items: ProfileItem[];
  callLLM: (prompt: string, context: string) => Promise<string>;
  concurrency: number;
  broadContext: string;
  projectRoot: string;
  onProgress: (completed: number, total: number, current: string) => void;
}

interface MultiPassResult {
  succeeded: Array<{ name: string; content: string }>;
  failed: Array<{ name: string; error: string }>;
}

/**
 * Analyze project and generate brain vault using Claude Code agents
 */
export async function analyze(options: AnalyzeOptions = {}): Promise<void> {
  const { parallel = true, api = false, background = false, fast = false } = options;

  // Determine mode from options or config
  const analyzeCfg = getLLMTaskConfig('analyze');
  let mode: 'claude' | 'api' = api ? 'api' : (analyzeCfg.mode as 'claude' | 'api');
  const projectRoot = getProjectRoot();
  const succDir = getSuccDir();
  const brainDir = path.join(succDir, 'brain');

  // Background mode: spawn detached process and exit
  if (background) {
    const logFile = path.join(succDir, 'analyze.log');
    const args = ['analyze'];
    if (!parallel) args.push('--sequential');
    if (mode === 'api') args.push('--api');
    if (fast) args.push('--fast');

    // Spawn detached process
    const child = spawn(process.execPath, [process.argv[1], ...args], {
      detached: true,
      stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')],
      cwd: projectRoot,
      windowsHide: true, // Hide CMD window on Windows (works without detached)
    });

    child.unref();

    console.log('🚀 Analysis started in background');
    console.log(`   Log file: ${logFile}`);
    console.log(`   Check progress: succ status`);
    console.log(`   Or view log: succ daemon logs`);
    return;
  }

  // Write progress file
  const progressFile = path.join(succDir, 'analyze.progress.json');
  const writeProgress = (status: string, completed: number, total: number, current?: string) => {
    fs.writeFileSync(progressFile, JSON.stringify({
      status,
      completed,
      total,
      current,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2));
  };

  const backendName = mode === 'api'
    ? `API (${analyzeCfg.model || 'not configured'} @ ${analyzeCfg.api_url})`
    : 'Claude Code CLI';

  console.log('🧠 Analyzing project with Claude agents...\n');
  console.log(`Project: ${projectRoot}`);
  console.log(`Mode: ${parallel ? 'parallel' : 'sequential'}${fast ? ' (fast)' : ''}`);
  console.log(`Backend: ${backendName}`);
  if (fast) console.log(`Fast mode: 5 agents, reduced context`);
  console.log('');

  writeProgress('starting', 0, 4);

  // Ensure brain structure exists
  await ensureBrainStructure(brainDir, projectRoot);

  // Pass 0: LLM project profiling
  const profileSpinner = ora('Profiling project with LLM...').start();
  let profile: ProjectProfile;
  try {
    profile = await profileProjectWithLLM(projectRoot, mode, fast);
    profileSpinner.succeed(
      `Profiled: ${profile.languages.join(', ')} — ${profile.systems.length} systems, ${profile.features.length} features`
    );
  } catch (err) {
    logError('analyze', 'LLM profiling failed', err instanceof Error ? err : undefined);
    profile = getDefaultProfile();
    profileSpinner.warn('LLM profiling failed, using fallback profile');
  }
  console.log('');

  // Define agents (with profile for enriched prompts)
  const projectName = path.basename(projectRoot);
  let agents = getAgents(brainDir, projectName);

  // Incremental analyze: skip agents whose outputs are still fresh
  const currentHead = getGitHead(projectRoot);
  const prevState = options.force ? null : loadAnalyzeState(succDir);

  if (prevState && prevState.gitCommit && currentHead) {
    const changedFiles = getChangedFiles(projectRoot, prevState.gitCommit);
    const skippable = agents.filter(a => !shouldRerunAgent(a.name, prevState, changedFiles));
    const rerun = agents.filter(a => shouldRerunAgent(a.name, prevState, changedFiles));

    if (skippable.length > 0 && rerun.length < agents.length) {
      console.log(`Incremental: skipping ${skippable.length} unchanged agent(s): ${skippable.map(a => a.name).join(', ')}`);
      console.log(`Re-running ${rerun.length} agent(s): ${rerun.map(a => a.name).join(', ')}\n`);
      agents = rerun;
    }

    if (agents.length === 0) {
      console.log('All agents are up to date. Use --force to re-run all.');
      writeProgress('completed', 0, 0);
      return;
    }
  }

  // Pass 1: Gather context using profile
  writeProgress('gathering_context', 0, agents.length, 'Gathering project context');
  const context = await gatherProjectContext(projectRoot, profile, fast);

  // Run single-file agents based on mode
  if (mode === 'api') {
    await runAgentsApi(agents, context, writeProgress, fast);
  } else {
    // Default: Claude Code CLI
    if (parallel) {
      await runAgentsParallel(agents, context);
    } else {
      await runAgentsSequential(agents, context);
    }
  }

  // Multi-pass: individual API calls per system/feature (skipped in fast mode)
  if (!fast && mode !== 'claude' && (profile.systems.length > 0 || profile.features.length > 0)) {
    const concurrency = analyzeCfg.concurrency ?? 3;
    const multiPassMaxTokens = analyzeCfg.max_tokens ?? 8192;
    const callLLM = createLLMCaller(mode, multiPassMaxTokens);
    // Reuse the LLM-guided context already gathered (profile-aware file tree + key files)
    const broadContext = context;
    const projectDir = path.join(brainDir, '01_Projects', projectName);

    // Systems multi-pass
    if (profile.systems.length > 0) {
      const systemsDir = path.join(projectDir, 'Systems');
      const systemsOverviewPath = path.join(systemsDir, 'Systems Overview.md');
      fs.mkdirSync(systemsDir, { recursive: true });
      cleanAgentSubfiles(systemsDir, systemsOverviewPath);

      console.log(`\nSystems documentation (${profile.systems.length} systems, concurrency ${concurrency})...`);
      const sysResults = await runMultiPassItems({
        type: 'systems',
        projectName,
        items: profile.systems,
        callLLM,
        concurrency,
        broadContext,
        projectRoot,
        onProgress: (done, total, name) => {
          writeProgress('running', done, total, `system: ${name}`);
          console.log(`  [${done}/${total}] ${name}`);
        },
      });

      // Write individual system files
      for (const item of sysResults.succeeded) {
        const filePath = path.join(systemsDir, `${item.name}.md`);
        fs.writeFileSync(filePath, item.content, 'utf-8');
      }
      // Write programmatic MOC
      const mocItems = sysResults.succeeded.map(s => {
        const orig = profile.systems.find(p => sanitizeFilename(p.name) === s.name);
        return { name: s.name, description: orig?.description || '', keyFile: orig?.keyFile || '' };
      });
      fs.writeFileSync(systemsOverviewPath, buildMocContent('systems', projectName, mocItems), 'utf-8');

      if (sysResults.failed.length > 0) {
        console.log(`  ⚠ ${sysResults.failed.length} system(s) failed: ${sysResults.failed.map(f => f.name).join(', ')}`);
      }
      console.log(`  ${sysResults.succeeded.length}/${profile.systems.length} systems documented`);
    }

    // Features multi-pass
    if (profile.features.length > 0) {
      const featuresDir = path.join(projectDir, 'Features');
      const featuresOverviewPath = path.join(featuresDir, 'Features Overview.md');
      fs.mkdirSync(featuresDir, { recursive: true });
      cleanAgentSubfiles(featuresDir, featuresOverviewPath);

      console.log(`\nFeatures documentation (${profile.features.length} features, concurrency ${concurrency})...`);
      const featResults = await runMultiPassItems({
        type: 'features',
        projectName,
        items: profile.features,
        callLLM,
        concurrency,
        broadContext,
        projectRoot,
        onProgress: (done, total, name) => {
          writeProgress('running', done, total, `feature: ${name}`);
          console.log(`  [${done}/${total}] ${name}`);
        },
      });

      // Write individual feature files
      for (const item of featResults.succeeded) {
        const filePath = path.join(featuresDir, `${item.name}.md`);
        fs.writeFileSync(filePath, item.content, 'utf-8');
      }
      // Write programmatic MOC
      const mocItems = featResults.succeeded.map(f => {
        const orig = profile.features.find(p => sanitizeFilename(p.name) === f.name);
        return { name: f.name, description: orig?.description || '', keyFile: orig?.keyFile || '' };
      });
      fs.writeFileSync(featuresOverviewPath, buildMocContent('features', projectName, mocItems), 'utf-8');

      if (featResults.failed.length > 0) {
        console.log(`  ⚠ ${featResults.failed.length} feature(s) failed: ${featResults.failed.map(f => f.name).join(', ')}`);
      }
      console.log(`  ${featResults.succeeded.length}/${profile.features.length} features documented`);
    }
  }

  // Update incremental state with multi-pass markers
  const addMultiPassState = (state: AnalyzeState) => {
    if (!fast && (profile.systems.length > 0 || profile.features.length > 0)) {
      state.agents['systems-overview'] = { lastRun: new Date().toISOString(), outputHash: '' };
      state.agents['features'] = { lastRun: new Date().toISOString(), outputHash: '' };
    }
  };

  // Generate index files and save state
  await generateIndexFiles(brainDir, projectName);
  const newState: AnalyzeState = {
    lastRun: new Date().toISOString(),
    gitCommit: currentHead,
    fileCount: 0,
    agents: {},
  };
  if (prevState) {
    Object.assign(newState.agents, prevState.agents);
  }
  for (const agent of agents) {
    newState.agents[agent.name] = {
      lastRun: new Date().toISOString(),
      outputHash: hashFile(agent.outputPath),
    };
  }
  addMultiPassState(newState);
  saveAnalyzeState(succDir, newState);

  console.log('\n✅ Brain vault generated!');
  console.log(`\nNext steps:`);
  console.log(`  1. Review generated docs in .succ/brain/`);
  console.log(`  2. Run \`succ index\` to create embeddings`);
  console.log(`  3. Open in Obsidian for graph view`);
}

function getAgents(brainDir: string, projectName: string): Agent[] {
  const projectDir = path.join(brainDir, '01_Projects', projectName);

  // Obsidian formatting guide — injected into every agent prompt
  const obsidianGuide = [
    'OUTPUT FORMAT: Obsidian-compatible markdown for a knowledge vault.',
    '',
    'Use these freely:',
    '- **[[wikilinks]]** to link between docs (e.g. [[Architecture Overview]], [[Memory System]])',
    '- **Mermaid diagrams** for architecture, data flows, sequences, class relations:',
    '  ```mermaid',
    '  graph TD',
    '    A[CLI] --> B[MCP Server]',
    '    B --> C[Storage]',
    '  ```',
    '- **ASCII art** for quick diagrams when Mermaid is overkill',
    '- **Tables** for structured data (deps, configs, API params, comparisons)',
    '- **Code blocks** with language tags (```typescript, ```bash)',
    '- **Callouts**: > [!note], > [!warning], > [!tip]',
    '- **Bold** for key terms, `inline code` for file paths and identifiers',
    '',
    'Be thorough and visual. Prefer diagrams over walls of text.',
    'Reference REAL file paths from the codebase — never guess or hallucinate paths.',
    '',
  ].join('\n');

  // Helper for frontmatter + obsidian guide
  const frontmatter = (desc: string, type: string = 'technical', rel: string = 'high') =>
    `Start with this YAML frontmatter:\n---\ndescription: "${desc}"\nproject: ${projectName}\ntype: ${type}\nrelevance: ${rel}\n---\n\n${obsidianGuide}`;

  const agents: Agent[] = [
    // Technical documentation
    {
      name: 'architecture',
      outputPath: path.join(projectDir, 'Technical', 'Architecture Overview.md'),
      prompt: `${frontmatter('High-level architecture overview')}Create "# Architecture Overview" document.

Add "**Parent:** [[${projectName}]]" after title.

Include sections: Overview, Tech Stack, Directory Structure, Entry Points, Data Flow.

Use [[wikilinks]] for related concepts. Output ONLY markdown.`,
    },
    {
      name: 'api',
      outputPath: path.join(projectDir, 'Technical', 'API Reference.md'),
      prompt: `${frontmatter('API endpoints and interfaces')}Create "# API Reference" document.

Add "**Parent:** [[Architecture Overview]]" after title.

List all API endpoints, CLI commands, or main public functions with their parameters and return types.

Output ONLY markdown.`,
    },
    {
      name: 'conventions',
      outputPath: path.join(projectDir, 'Technical', 'Conventions.md'),
      prompt: `${frontmatter('Coding conventions and patterns', 'technical', 'medium')}Create "# Conventions" document.

Add "**Parent:** [[Architecture Overview]]" after title.

Document: naming conventions, file organization, common patterns, error handling approach.

Output ONLY markdown.`,
    },
    {
      name: 'dependencies',
      outputPath: path.join(projectDir, 'Technical', 'Dependencies.md'),
      prompt: `${frontmatter('Key dependencies and their purposes', 'technical', 'medium')}Create "# Dependencies" document.

Add "**Parent:** [[Architecture Overview]]" after title.

List important dependencies with: name, purpose, where used. Group by category.

Output ONLY markdown.`,
    },

    // Strategy (if business logic exists)
    {
      name: 'strategy',
      outputPath: path.join(projectDir, 'Strategy', 'Project Strategy.md'),
      prompt: `${frontmatter('Project goals and strategic direction', 'strategy')}Create "# Project Strategy" document.

Add "**Parent:** [[${projectName}]]" after title.

Based on the codebase, describe:
- What problem this project solves
- Target users/audience
- Key differentiators
- Current capabilities
- Potential growth areas

If this is a library/tool, focus on its use cases. Output ONLY markdown.`,
    },

  ];

  return agents;
}

// ─── Multi-pass helpers ─────────────────────────────────────────────

/**
 * Sanitize a profile item name into a safe filename.
 * Replaces /\:*?"<>| with dashes, collapses runs, trims.
 */
function sanitizeFilename(name: string): string {
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
function buildMocContent(
  type: 'systems' | 'features',
  projectName: string,
  items: Array<{ name: string; description: string; keyFile: string }>,
): string {
  const typeLabel = type === 'systems' ? 'Systems' : 'Features';
  const typeSingular = type === 'systems' ? 'system' : 'feature';
  const parentLink = type === 'systems'
    ? `[[Architecture Overview]]`
    : `[[${projectName}]]`;

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
    lines.push(`| ${typeSingular[0].toUpperCase() + typeSingular.slice(1)} | Description | Key File |`);
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
function buildItemPrompt(
  type: 'systems' | 'features',
  projectName: string,
  item: ProfileItem,
): string {
  const parentLink = type === 'systems'
    ? '[[Systems Overview]]'
    : '[[Features Overview]]';

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
function gatherItemContext(
  projectRoot: string,
  item: ProfileItem,
  broadHeader: string,
): string {
  const parts: string[] = [broadHeader];

  // Full keyFile content (up to 8000 chars)
  if (item.keyFile) {
    const keyFilePath = path.join(projectRoot, item.keyFile);
    if (fs.existsSync(keyFilePath)) {
      try {
        const content = fs.readFileSync(keyFilePath, 'utf-8').slice(0, 8000);
        parts.push(`## Key File: ${item.keyFile}\n\`\`\`\n${content}\n\`\`\`\n`);
      } catch { /* skip unreadable */ }
    }
  }

  // Up to 3 sibling files from the same directory (3000 chars each)
  if (item.keyFile) {
    const keyDir = path.dirname(path.join(projectRoot, item.keyFile));
    if (fs.existsSync(keyDir)) {
      try {
        const siblings = fs.readdirSync(keyDir)
          .filter(f => f !== path.basename(item.keyFile) && /\.(ts|js|py|rs|go|java|rb)$/i.test(f))
          .slice(0, 3);
        for (const sibling of siblings) {
          const siblingPath = path.join(keyDir, sibling);
          try {
            const content = fs.readFileSync(siblingPath, 'utf-8').slice(0, 3000);
            const relPath = path.relative(projectRoot, siblingPath).replace(/\\/g, '/');
            parts.push(`## ${relPath}\n\`\`\`\n${content}\n\`\`\`\n`);
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  }

  return parts.join('\n');
}

/**
 * Run multi-pass: individual API calls per system/feature with concurrency control.
 */
async function runMultiPassItems(opts: MultiPassOptions): Promise<MultiPassResult> {
  const { type, projectName, items, callLLM, concurrency, broadContext, projectRoot, onProgress } = opts;
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
    await new Promise<void>(resolve => { waiters.push(resolve); });
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
    await new Promise(resolve => setTimeout(resolve, 200));

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
            await new Promise(resolve => setTimeout(resolve, 1000));
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
          await new Promise(resolve => setTimeout(resolve, 1000));
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
 * Factory: returns a callLLM function for the given mode.
 */
function createLLMCaller(
  mode: 'api' | 'claude',
  maxTokens: number,
): (prompt: string, context: string) => Promise<string> {
  return async (prompt: string, context: string) => {
    const fullPrompt = `You are analyzing a software project. Here is the project context:\n\n${context}\n\n---\n\n${prompt}`;

    if (mode === 'api') {
      return callApiRaw(fullPrompt, maxTokens);
    } else {
      // Claude CLI mode — use spawnClaudeCLI
      return spawnClaudeCLI(fullPrompt);
    }
  };
}

async function runAgentsParallel(agents: Agent[], context: string): Promise<void> {
  console.log(`Starting ${agents.length} agents in parallel...\n`);

  const totalStart = Date.now();
  const agentStarts = agents.map(() => Date.now());
  const promises = agents.map((agent, i) => {
    agentStarts[i] = Date.now();
    return runClaudeAgent(agent, context);
  });
  const results = await Promise.allSettled(promises);

  const timings: AgentTiming[] = [];
  results.forEach((result, index) => {
    const elapsed = Date.now() - agentStarts[index];
    if (result.status === 'fulfilled') {
      console.log(`✓ ${agents[index].name} (${formatDuration(elapsed)})`);
      timings.push({ name: agents[index].name, durationMs: elapsed, success: true });
    } else {
      console.log(`✗ ${agents[index].name}: ${result.reason}`);
      timings.push({ name: agents[index].name, durationMs: elapsed, success: false });
    }
  });

  printTimingSummary(timings, Date.now() - totalStart);
}

/**
 * Clean markdown output by removing code fences and preamble text that LLMs sometimes add
 */
function cleanMarkdownOutput(content: string): string {
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
function parseMultiFileOutput(content: string, baseDir: string): Array<{ path: string; content: string }> {
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
          content: fileContent
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
function cleanAgentSubfiles(outputDir: string, overviewPath: string): void {
  if (!fs.existsSync(outputDir)) return;

  const overviewName = path.basename(overviewPath).toLowerCase();
  const entries = fs.readdirSync(outputDir);

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;

    // Skip the overview file itself — it gets overwritten
    if (entry.toLowerCase() === overviewName) continue;

    // Skip non-analyze files (decision exports, session logs, MOC stubs, manual docs)
    const lowerEntry = entry.toLowerCase();
    if (lowerEntry.startsWith('2026-') || lowerEntry.startsWith('2025-') ||
        lowerEntry === 'sessions.md' || lowerEntry === 'decisions.md' ||
        lowerEntry === 'technical.md' || lowerEntry === 'strategy.md') continue;

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
async function writeAgentOutput(agent: Agent, content: string): Promise<void> {
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

async function runAgentsSequential(agents: Agent[], context: string): Promise<void> {
  console.log(`Running ${agents.length} agents sequentially...\n`);

  const totalStart = Date.now();
  const timings: AgentTiming[] = [];
  for (const agent of agents) {
    const spinner = ora(`${agent.name}`).start();
    const agentStart = Date.now();
    try {
      await runClaudeAgent(agent, context);
      const elapsed = Date.now() - agentStart;
      spinner.succeed(`${agent.name} (${formatDuration(elapsed)})`);
      timings.push({ name: agent.name, durationMs: elapsed, success: true });
    } catch (error) {
      logError('analyze', `Agent ${agent.name} failed`, error instanceof Error ? error : new Error(String(error)));
      const elapsed = Date.now() - agentStart;
      spinner.fail(`${agent.name}: ${error}`);
      timings.push({ name: agent.name, durationMs: elapsed, success: false });
    }
  }

  printTimingSummary(timings, Date.now() - totalStart);
}

async function runClaudeAgent(agent: Agent, context: string): Promise<void> {
  // Ensure output directory exists
  const outputDir = path.dirname(agent.outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  // Build prompt with context
  const fullPrompt = `You are analyzing a software project. Here is the project structure and key files:

${context}

---

${agent.prompt}`;

  const stdout = await spawnClaudeCLI(fullPrompt, { tools: '', model: 'haiku', timeout: 180000 });

  if (stdout) {
    await writeAgentOutput(agent, stdout);
  } else {
    throw new Error('No output from Claude CLI');
  }
}

type ProgressFn = (status: string, completed: number, total: number, current?: string) => void;

interface AgentTiming {
  name: string;
  durationMs: number;
  success: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function printTimingSummary(timings: AgentTiming[], totalMs: number): void {
  console.log('\n--- Timing Summary ---');
  for (const t of timings) {
    const icon = t.success ? '✓' : '✗';
    console.log(`  ${icon} ${t.name}: ${formatDuration(t.durationMs)}`);
  }
  console.log(`  Total: ${formatDuration(totalMs)}`);
}

/**
 * Run agents using API endpoint (OpenRouter, Ollama, LM Studio, llama.cpp, etc.)
 */
async function runAgentsApi(
  agents: Agent[],
  context: string,
  writeProgress: ProgressFn,
  fast = false
): Promise<void> {
  const cfg = getLLMTaskConfig('analyze');

  console.log(`Running ${agents.length} agents via API...`);
  console.log(`  Endpoint: ${cfg.api_url}`);
  console.log(`  Model: ${cfg.model}\n`);

  const totalStart = Date.now();
  const timings: AgentTiming[] = [];
  let completed = 0;
  for (const agent of agents) {
    writeProgress('running', completed, agents.length, agent.name);
    const spinner = ora(`${agent.name}`).start();
    const agentStart = Date.now();

    // Multi-file agents (systems-overview, features) need more output tokens
    const isMultiFile = agent.prompt.includes('===FILE:');
    const agentMaxTokens = cfg.max_tokens
      ?? (isMultiFile ? (fast ? 4096 : 32768) : (fast ? 2048 : 8192));

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (cfg.api_key) {
        headers['Authorization'] = `Bearer ${cfg.api_key}`;
      }
      // Auto-add OpenRouter headers
      if (cfg.api_url.includes('openrouter.ai')) {
        headers['HTTP-Referer'] = 'https://succ.ai';
        headers['X-Title'] = 'succ';
      }

      // Build the completion endpoint URL
      const apiUrl = cfg.api_url;
      const completionUrl = apiUrl.endsWith('/v1')
        ? `${apiUrl}/chat/completions`
        : apiUrl.endsWith('/v1/')
          ? `${apiUrl}chat/completions`
          : apiUrl.endsWith('/')
            ? `${apiUrl}v1/chat/completions`
            : `${apiUrl}/v1/chat/completions`;

      const response = await fetch(completionUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            {
              role: 'system',
              content: 'You are an expert software documentation writer. Analyze the provided code and generate high-quality technical documentation in markdown format. Be precise and thorough.',
            },
            {
              role: 'user',
              content: `You are analyzing a software project. Here is the project structure and key files:\n\n${context}\n\n---\n\n${agent.prompt}`,
            },
          ],
          temperature: cfg.temperature ?? 0.3,
          max_tokens: agentMaxTokens,
          stream: false,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API error: ${response.status} - ${error}`);
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;

      if (content) {
        await writeAgentOutput(agent, content);
        completed++;
        const elapsed = Date.now() - agentStart;
        spinner.succeed(`${agent.name} (${formatDuration(elapsed)})`);
        timings.push({ name: agent.name, durationMs: elapsed, success: true });
      } else {
        const elapsed = Date.now() - agentStart;
        spinner.fail(`${agent.name}: No content returned`);
        timings.push({ name: agent.name, durationMs: elapsed, success: false });
      }
    } catch (error) {
      logError('analyze', `Agent ${agent.name} failed`, error instanceof Error ? error : new Error(String(error)));
      const elapsed = Date.now() - agentStart;
      spinner.fail(`${agent.name}: ${error}`);
      timings.push({ name: agent.name, durationMs: elapsed, success: false });
    }
  }

  printTimingSummary(timings, Date.now() - totalStart);
}

/**
 * LLM-based project profiling (Pass 0).
 * Sends the file tree to the LLM and gets back a structured profile:
 * languages, extensions, entry points, systems, features.
 */
async function profileProjectWithLLM(
  projectRoot: string,
  mode: 'claude' | 'api',
  fast: boolean,
): Promise<ProjectProfile> {
  // 1. Gather raw file tree (lightweight — only paths, no content)
  const allFiles = await glob('**/*', {
    cwd: projectRoot,
    ignore: [
      '**/node_modules/**', '**/.git/**', '**/dist/**', '**/.succ/**',
      '**/vendor/**', '**/coverage/**', '**/__pycache__/**',
      '**/target/**', '**/.next/**', '**/.cache/**',
    ],
    nodir: true,
  });

  const treeLimit = fast ? 200 : 300;
  const fileTree = allFiles.slice(0, treeLimit).join('\n');
  const truncMsg = allFiles.length > treeLimit
    ? `\n... and ${allFiles.length - treeLimit} more files` : '';

  // 2. Build profiling prompt
  const prompt = `Analyze this project's file tree and respond with ONLY valid JSON (no markdown, no explanation).

## File Tree
\`\`\`
${fileTree}${truncMsg}
\`\`\`

Respond with this exact JSON structure:
{
  "languages": ["typescript", "javascript"],
  "sourceExtensions": [".ts", ".js"],
  "testPatterns": ["**/*.test.ts", "**/*.spec.ts", "**/*_test.go"],
  "ignoreDirectories": ["node_modules", "dist", ".succ", "coverage"],
  "projectFiles": ["package.json", "tsconfig.json", "README.md"],
  "entryPoints": ["src/cli.ts", "src/index.ts"],
  "keyFiles": ["src/lib/storage.ts", "src/mcp/server.ts"],
  "systems": [
    {"name": "Storage System", "keyFile": "src/lib/storage.ts", "description": "SQLite persistence layer"},
    {"name": "Embedding System", "keyFile": "src/lib/embeddings.ts", "description": "Vector embeddings"}
  ],
  "features": [
    {"name": "Memory System", "keyFile": "src/commands/memories.ts", "description": "Persistent semantic memory"},
    {"name": "Hybrid Search", "keyFile": "src/lib/search.ts", "description": "BM25 + vector search"}
  ]
}

Rules:
- Be EXHAUSTIVE — identify EVERY distinct system/module and EVERY user-facing feature
- Systems = internal modules/subsystems (storage, search, config, embedding, CLI, etc.)
- Features = user-facing capabilities (commands, API endpoints, integrations)
- keyFile = the most representative source file for that system/feature
- testPatterns should use glob patterns with ** prefix
- Do NOT include test files, build artifacts, or documentation in keyFiles
- Respond ONLY with valid JSON — no markdown fences, no explanation
- Use COMPACT JSON format (minimize whitespace) to save tokens`;

  // 3. Call LLM based on mode (with retry for flaky free models)
  let responseText = '';
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (mode === 'api') {
        responseText = await callApiRaw(prompt, 4096);
      } else {
        responseText = await spawnClaudeCLI(prompt, { tools: '', model: 'haiku', timeout: 60000 });
      }
    } catch (err) {
      logWarn('analyze', `LLM profiling call attempt ${attempt + 1} failed`, { error: String(err) });
      if (attempt === maxRetries) console.warn(`⚠ LLM profiling call failed: ${err}`);
    }
    if (responseText) break;
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 1000)); // brief pause before retry
    }
  }

  if (!responseText) {
    logWarn('analyze', 'LLM profiling returned empty response after retries');
    console.warn('⚠ LLM profiling returned empty response after retries');
    return getDefaultProfile();
  }

  // 4. Parse JSON (robust extraction)
  let jsonStr = '';

  // Strategy 1: Extract from markdown fenced code block
  const fenceMatch = responseText.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Strategy 2: Find first { to last } (raw JSON object)
  if (!jsonStr) {
    const firstBrace = responseText.indexOf('{');
    const lastBrace = responseText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = responseText.slice(firstBrace, lastBrace + 1);
    }
  }

  // Strategy 3: Use cleaned response as-is
  if (!jsonStr) {
    jsonStr = responseText
      .replace(/^```json?\s*\n?/i, '')
      .replace(/\n?```\s*$/, '')
      .trim();
  }

  // Try parse, then try repair if truncated
  let parsed: ProjectProfile | null = null;
  try {
    parsed = JSON.parse(jsonStr) as ProjectProfile;
  } catch {
    // Attempt to repair truncated JSON by closing open brackets
    const repaired = repairTruncatedJSON(jsonStr);
    if (repaired) {
      try {
        parsed = JSON.parse(repaired) as ProjectProfile;
        console.log('  (repaired truncated JSON)');
      } catch { /* still broken */ }
    }
  }

  if (parsed) {
    // Validate required arrays exist
    if (!Array.isArray(parsed.languages)) parsed.languages = ['unknown'];
    if (!Array.isArray(parsed.sourceExtensions)) parsed.sourceExtensions = [];
    if (!Array.isArray(parsed.testPatterns)) parsed.testPatterns = [];
    if (!Array.isArray(parsed.ignoreDirectories)) parsed.ignoreDirectories = [];
    if (!Array.isArray(parsed.projectFiles)) parsed.projectFiles = [];
    if (!Array.isArray(parsed.entryPoints)) parsed.entryPoints = [];
    if (!Array.isArray(parsed.keyFiles)) parsed.keyFiles = [];
    if (!Array.isArray(parsed.systems)) parsed.systems = [];
    if (!Array.isArray(parsed.features)) parsed.features = [];
    return parsed;
  }

  logWarn('analyze', 'Could not parse LLM profile response, using fallback');
  console.warn('⚠ Could not parse LLM profile response, using fallback');
  return getDefaultProfile();
}

function getDefaultProfile(): ProjectProfile {
  return {
    languages: ['unknown'],
    sourceExtensions: ['.ts', '.js', '.py', '.go', '.rs', '.java', '.rb', '.php'],
    testPatterns: ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**'],
    ignoreDirectories: ['node_modules', 'dist', '.git', '.succ', 'vendor', 'coverage'],
    projectFiles: ['package.json', 'README.md', 'go.mod', 'pyproject.toml', 'Cargo.toml'],
    entryPoints: [],
    keyFiles: [],
    systems: [],
    features: [],
  };
}

/**
 * Attempt to repair truncated JSON by closing open strings, arrays, and objects.
 * Returns repaired string or null if beyond repair.
 */
function repairTruncatedJSON(json: string): string | null {
  if (!json || !json.startsWith('{')) return null;

  // Trim to last complete value boundary (after a comma, colon, or bracket)
  let trimmed = json.replace(/,\s*$/, ''); // trailing comma
  // Remove incomplete string value at the end (e.g., ..."descr)
  trimmed = trimmed.replace(/,\s*"[^"]*$/, '');         // trailing incomplete key
  trimmed = trimmed.replace(/:\s*"[^"]*$/, ': ""');      // truncated string value — close it
  trimmed = trimmed.replace(/:\s*$/, ': null');           // colon with no value

  // Count open brackets/braces and close them
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;
  for (const ch of trimmed) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    if (ch === '}') openBraces--;
    if (ch === '[') openBrackets++;
    if (ch === ']') openBrackets--;
  }

  // Close unclosed brackets/braces
  for (let i = 0; i < openBrackets; i++) trimmed += ']';
  for (let i = 0; i < openBraces; i++) trimmed += '}';

  return trimmed;
}

/**
 * Raw API call to any OpenAI-compatible endpoint (shared by profiling and agents)
 * Reads config from llm.analyze.*
 */
async function callApiRaw(prompt: string, maxTokens: number): Promise<string> {
  const cfg = getLLMTaskConfig('analyze');
  const apiUrl = cfg.api_url;

  const completionUrl = apiUrl.endsWith('/v1')
    ? `${apiUrl}/chat/completions`
    : apiUrl.endsWith('/v1/')
      ? `${apiUrl}chat/completions`
      : apiUrl.endsWith('/')
        ? `${apiUrl}v1/chat/completions`
        : `${apiUrl}/v1/chat/completions`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.api_key) {
    headers['Authorization'] = `Bearer ${cfg.api_key}`;
  }
  if (apiUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://succ.ai';
    headers['X-Title'] = 'succ';
  }

  const response = await fetch(completionUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
    }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }
  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Gather project context using LLM-generated profile.
 * Reads entry points, key files, and per-directory samples.
 */
async function gatherProjectContext(
  projectRoot: string,
  profile: ProjectProfile,
  fast = false,
): Promise<string> {
  const parts: string[] = [];

  // Header with detected info
  parts.push(`## Project: ${path.basename(projectRoot)}`);
  parts.push(`Languages: ${profile.languages.join(', ')}`);
  if (profile.systems.length > 0) {
    parts.push(`Identified systems: ${profile.systems.map(s => s.name).join(', ')}`);
  }
  if (profile.features.length > 0) {
    parts.push(`Identified features: ${profile.features.map(f => f.name).join(', ')}`);
  }
  parts.push('');

  // Build glob from detected extensions
  const sourceGlobs = profile.sourceExtensions.map(ext => `**/*${ext}`);
  const allGlobs = [...sourceGlobs, '**/*.md', '**/*.json', '**/*.yaml', '**/*.yml', '**/*.toml'];

  const ignorePatterns = [
    ...profile.ignoreDirectories.map(d => `**/${d}/**`),
    ...profile.testPatterns.map(p => p.startsWith('**/') ? p : `**/${p}`),
    '**/*.d.ts',
  ];

  const files = await glob(allGlobs, {
    cwd: projectRoot,
    ignore: ignorePatterns,
    nodir: true,
  });

  // Full file tree
  const treeLimit = fast ? 100 : 500;
  parts.push('## File Structure\n```');
  parts.push(files.slice(0, treeLimit).join('\n'));
  if (files.length > treeLimit) parts.push(`... and ${files.length - treeLimit} more files`);
  parts.push('```\n');

  // Read project files (package.json, README.md, etc.)
  for (const keyFile of profile.projectFiles) {
    const filePath = path.join(projectRoot, keyFile);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').slice(0, 3000);
      parts.push(`## ${keyFile}\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }

  // Read LLM-identified entry points and key files first
  const priorityFiles = [...new Set([...profile.entryPoints, ...profile.keyFiles])];
  const selectedFiles: string[] = [];

  for (const f of priorityFiles) {
    const filePath = path.join(projectRoot, f);
    if (fs.existsSync(filePath) && !selectedFiles.includes(f)) {
      selectedFiles.push(f);
    }
  }

  // Also read key files from identified systems/features
  for (const sys of profile.systems) {
    if (sys.keyFile && !selectedFiles.includes(sys.keyFile)) {
      const filePath = path.join(projectRoot, sys.keyFile);
      if (fs.existsSync(filePath)) selectedFiles.push(sys.keyFile);
    }
  }
  for (const feat of profile.features) {
    if (feat.keyFile && !selectedFiles.includes(feat.keyFile)) {
      const filePath = path.join(projectRoot, feat.keyFile);
      if (fs.existsSync(filePath)) selectedFiles.push(feat.keyFile);
    }
  }

  // Fill remaining slots with broad directory coverage
  const extSet = new Set(profile.sourceExtensions);
  const sourceFiles = files.filter(f => extSet.has(path.extname(f)));
  const dirMap = new Map<string, string[]>();
  for (const f of sourceFiles) {
    const dir = path.dirname(f);
    if (!dirMap.has(dir)) dirMap.set(dir, []);
    dirMap.get(dir)!.push(f);
  }

  const maxPerDir = fast ? 1 : 2;
  const maxTotal = fast ? 15 : 40;
  for (const [, dirFiles] of dirMap) {
    for (const f of dirFiles.slice(0, maxPerDir)) {
      if (!selectedFiles.includes(f) && selectedFiles.length < maxTotal) {
        selectedFiles.push(f);
      }
    }
  }

  // Read selected source files
  const charLimit = fast ? 1500 : 3000;
  for (const sourceFile of selectedFiles) {
    const filePath = path.join(projectRoot, sourceFile);
    try {
      const content = fs.readFileSync(filePath, 'utf-8').slice(0, charLimit);
      parts.push(`## ${sourceFile}\n\`\`\`\n${content}\n\`\`\`\n`);
    } catch { /* skip unreadable */ }
  }

  return parts.join('\n');
}

async function ensureBrainStructure(brainDir: string, projectRoot: string): Promise<void> {
  const projectName = path.basename(projectRoot);

  const dirs = [
    brainDir,
    path.join(brainDir, '.meta'),
    path.join(brainDir, '.obsidian'),
    path.join(brainDir, '00_Inbox'),
    path.join(brainDir, '01_Projects', projectName, 'Technical'),
    path.join(brainDir, '01_Projects', projectName, 'Decisions'),
    path.join(brainDir, '01_Projects', projectName, 'Features'),
    path.join(brainDir, '02_Knowledge'),
    path.join(brainDir, '03_Archive'),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function generateIndexFiles(brainDir: string, projectName: string): Promise<void> {
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
├── 00_Inbox/                       # Quick captures
├── 01_Projects/
│   └── ${projectName}/ → [[${projectName}]]
│       ├── Technical/             # Architecture, API, patterns
│       ├── Decisions/             # ADRs
│       └── Features/              # Feature specs
├── 02_Knowledge/                   # Research, competitors
└── 03_Archive/                     # Old/superseded
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

  fs.writeFileSync(
    path.join(brainDir, '01_Projects', projectName, `${projectName}.md`),
    projectMd
  );

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
      { query: 'path:Technical', color: { a: 1, rgb: 2201331 } }, // Blue
      { query: 'path:Decisions', color: { a: 1, rgb: 10040217 } }, // Purple
      { query: 'path:Features', color: { a: 1, rgb: 5025616 } }, // Green
      { query: 'path:02_Knowledge', color: { a: 1, rgb: 16776960 } }, // Yellow
      { query: 'path:03_Archive', color: { a: 1, rgb: 8421504 } }, // Gray
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

/**
 * Analyze a single file and generate documentation in brain vault
 */
export interface AnalyzeFileOptions {
  mode?: 'claude' | 'api';
}

export interface AnalyzeFileResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

/**
 * Gather minimal project context for single file analysis
 */
function gatherMinimalContext(projectRoot: string): string {
  const parts: string[] = [];

  // Read package.json for project info
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      parts.push(`Project: ${pkg.name || path.basename(projectRoot)}`);
      if (pkg.description) parts.push(`Description: ${pkg.description}`);
      if (pkg.dependencies) {
        const deps = Object.keys(pkg.dependencies).slice(0, 10).join(', ');
        parts.push(`Key dependencies: ${deps}`);
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Try other project files if no package.json
  if (parts.length === 0) {
    const projectFiles = ['go.mod', 'pyproject.toml', 'Cargo.toml'];
    for (const pf of projectFiles) {
      const pfPath = path.join(projectRoot, pf);
      if (fs.existsSync(pfPath)) {
        parts.push(`Project type: ${pf.replace(/\.[^.]+$/, '')}`);
        break;
      }
    }
  }

  // Get basic file structure (just top-level dirs)
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'dist', 'build', 'vendor'].includes(e.name))
      .map(e => e.name)
      .slice(0, 8);
    if (dirs.length > 0) {
      parts.push(`Main directories: ${dirs.join(', ')}`);
    }
  } catch {
    // Ignore errors
  }

  return parts.join('\n');
}

/**
 * Get list of existing brain vault documents for wikilink suggestions
 */
function getExistingBrainDocs(brainDir: string): string[] {
  const docs: string[] = [];

  if (!fs.existsSync(brainDir)) {
    return docs;
  }

  function walkDir(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.name.endsWith('.md')) {
          // Get document title (filename without .md)
          const docName = entry.name.replace(/\.md$/, '');
          docs.push(docName);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  walkDir(brainDir);
  return [...new Set(docs)]; // Remove duplicates
}

export async function analyzeFile(
  filePath: string,
  options: AnalyzeFileOptions = {}
): Promise<AnalyzeFileResult> {
  const projectRoot = getProjectRoot();
  const succDir = getSuccDir();
  const brainDir = path.join(succDir, 'brain');

  // Determine mode
  const analyzeCfg = getLLMTaskConfig('analyze');
  let mode: 'claude' | 'api' = options.mode || (analyzeCfg.mode as 'claude' | 'api');

  // Check file exists
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectRoot, filePath);

  if (!fs.existsSync(absolutePath)) {
    return { success: false, error: `File not found: ${absolutePath}` };
  }

  // Read file content
  const fileContent = fs.readFileSync(absolutePath, 'utf-8');
  const fileName = path.basename(filePath);
  const relativePath = path.relative(projectRoot, absolutePath);
  const ext = path.extname(filePath).toLowerCase();

  // Determine output path in brain vault
  const projectName = path.basename(projectRoot);
  const outputDir = path.join(brainDir, '01_Projects', projectName, 'Files');
  const outputPath = path.join(outputDir, `${fileName}.md`);

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Ensure Files.md MOC exists
  const filesMocPath = path.join(brainDir, '01_Projects', projectName, 'Files.md');
  if (!fs.existsSync(filesMocPath)) {
    const filesMocContent = `---
description: "Source code file documentation"
project: ${projectName}
type: index
relevance: high
---

# Files

**Parent:** [[${projectName}]]

Map of documented source files. Each file analysis includes purpose, key components, dependencies, and usage.

## Documented Files

_Files are automatically added here when analyzed._
`;
    fs.writeFileSync(filesMocPath, filesMocContent);
  }

  // Gather minimal project context
  const projectContext = gatherMinimalContext(projectRoot);

  // Get existing brain docs for wikilink suggestions
  const existingDocs = getExistingBrainDocs(brainDir);
  const wikilinksSection = existingDocs.length > 0
    ? `\n## Existing Documentation (use these for [[wikilinks]]):\n${existingDocs.slice(0, 50).join(', ')}\n`
    : '';

  // Build analysis prompt
  const prompt = `Analyze this source file and create documentation.

## Project Context
${projectContext}
${wikilinksSection}
## File to Analyze
File: ${relativePath}
Extension: ${ext}

Content:
\`\`\`${ext.slice(1) || 'text'}
${fileContent.slice(0, 10000)}${fileContent.length > 10000 ? '\n... (truncated)' : ''}
\`\`\`

---

Create a documentation file following these rules:

1. YAML frontmatter (MUST be first):
---
description: "Brief description of this file's purpose"
project: ${projectName}
type: file-analysis
relevance: medium
file: ${relativePath}
---

2. Document structure:
# ${fileName}

**Parent:** [[Files]]
**Path:** \`${relativePath}\`

## Purpose
What this file does and why it exists.

## Key Components
Main functions, classes, exports with brief descriptions.

## Dependencies
What it imports/requires. Use [[wikilinks]] ONLY for documents listed in "Existing Documentation" section above.

## Usage
How this file is used in the project. Reference related files with [[wikilinks]] ONLY if they exist in the documentation list.

CRITICAL FORMATTING RULES:
- Your response MUST start with exactly \`---\` on the first line
- NO text before the frontmatter (no "Let me...", "Here is...", "Based on...")
- The first 3 characters of your output must be the three dashes
- **Parent:** must be [[Files]] (not [[lib]] or folder names)
- ONLY use [[wikilinks]] for documents that exist in the "Existing Documentation" list
- If a related file doesn't have documentation yet, just mention it as plain text (no brackets)`;

  try {
    let content: string | null = null;

    if (mode === 'api') {
      const cfg = getLLMTaskConfig('analyze');
      const apiUrl = cfg.api_url;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (cfg.api_key) {
        headers['Authorization'] = `Bearer ${cfg.api_key}`;
      }
      if (apiUrl.includes('openrouter.ai')) {
        headers['HTTP-Referer'] = 'https://succ.ai';
        headers['X-Title'] = 'succ';
      }

      const completionUrl = apiUrl.endsWith('/v1')
        ? `${apiUrl}/chat/completions`
        : apiUrl.endsWith('/v1/')
          ? `${apiUrl}chat/completions`
          : apiUrl.endsWith('/')
            ? `${apiUrl}v1/chat/completions`
            : `${apiUrl}/v1/chat/completions`;

      const response = await fetch(completionUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            {
              role: 'system',
              content: 'You are an expert software documentation writer. Generate clear, concise documentation.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: cfg.temperature ?? 0.3,
          max_tokens: cfg.max_tokens ?? 4096,
          stream: false,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        return { success: false, error: `API error: ${response.status} - ${error}` };
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      content = data.choices?.[0]?.message?.content || null;
    } else {
      // Claude CLI mode (async — supports both process and ws transport)
      try {
        const { spawnClaudeCLI } = await import('../lib/llm.js');
        content = await spawnClaudeCLI(prompt, { tools: '', model: 'haiku', timeout: 120000 }) || null;
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    if (!content) {
      return { success: false, error: 'No content returned from LLM' };
    }

    // Clean output (remove preamble, code fences)
    const cleanedContent = cleanMarkdownOutput(content);

    // Write output
    fs.writeFileSync(outputPath, cleanedContent);

    return { success: true, outputPath };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
