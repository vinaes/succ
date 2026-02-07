import spawn from 'cross-spawn';
import { spawnClaudeCLI } from '../lib/llm.js';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import ora from 'ora';
import { getProjectRoot, getSuccDir, getConfig } from '../lib/config.js';
import { withLock } from '../lib/lock.js';
import {
  loadAnalyzeState, saveAnalyzeState, getGitHead, getChangedFiles,
  hashFile, shouldRerunAgent, type AnalyzeState
} from '../lib/analyze-state.js';

interface AnalyzeOptions {
  parallel?: boolean;
  openrouter?: boolean;
  local?: boolean;  // Use local LLM API
  background?: boolean;
  fast?: boolean;   // Fast mode: fewer agents, smaller context
  force?: boolean;  // Force full re-analysis (skip incremental)
}

interface Agent {
  name: string;
  outputPath: string;
  prompt: string;
}

/**
 * Analyze project and generate brain vault using Claude Code agents
 */
export async function analyze(options: AnalyzeOptions = {}): Promise<void> {
  const { parallel = true, openrouter = false, local = false, background = false, fast = false } = options;

  // Determine mode from options or config
  const config = getConfig();
  let mode: 'claude' | 'openrouter' | 'local' = 'claude';
  if (local) {
    mode = 'local';
  } else if (openrouter) {
    mode = 'openrouter';
  } else if (config.analyze_mode) {
    mode = config.analyze_mode;
  }
  const projectRoot = getProjectRoot();
  const succDir = getSuccDir();
  const brainDir = path.join(succDir, 'brain');

  // Background mode: spawn detached process and exit
  if (background) {
    const logFile = path.join(succDir, 'analyze.log');
    const args = ['analyze'];
    if (!parallel) args.push('--sequential');
    if (openrouter) args.push('--openrouter');
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

  const backendName = mode === 'local'
    ? `Local LLM (${config.analyze_model || 'not configured'})`
    : mode === 'openrouter'
      ? 'OpenRouter API'
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

  // Define agents
  const projectName = path.basename(projectRoot);
  let agents = getAgents(brainDir, projectName, fast);

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

  // Gather project context (used by all modes now)
  writeProgress('gathering_context', 0, agents.length, 'Gathering project context');
  const context = await gatherProjectContext(projectRoot, fast);

  // Helper to save incremental state after successful run
  const saveState = () => {
    const newState: AnalyzeState = {
      lastRun: new Date().toISOString(),
      gitCommit: currentHead,
      fileCount: 0,
      agents: {},
    };
    // Merge with previous state for agents we skipped
    if (prevState) {
      Object.assign(newState.agents, prevState.agents);
    }
    // Update state for agents we just ran
    for (const agent of agents) {
      newState.agents[agent.name] = {
        lastRun: new Date().toISOString(),
        outputHash: hashFile(agent.outputPath),
      };
    }
    saveAnalyzeState(succDir, newState);
  };

  // Run agents based on mode
  if (mode === 'openrouter') {
    await runAgentsOpenRouter(agents, context, writeProgress, fast);
    await generateIndexFiles(brainDir, projectName);
    saveState();
    writeProgress('completed', agents.length, agents.length);
    console.log('\n✅ Brain vault generated!');
    console.log(`\nNext steps:`);
    console.log(`  1. Review generated docs in .succ/brain/`);
    console.log(`  2. Run \`succ index\` to create embeddings`);
    console.log(`  3. Open in Obsidian for graph view`);
    return;
  }

  if (mode === 'local') {
    await runAgentsLocal(agents, context, writeProgress, fast);
    await generateIndexFiles(brainDir, projectName);
    saveState();
    writeProgress('completed', agents.length, agents.length);
    console.log('\n✅ Brain vault generated!');
    console.log(`\nNext steps:`);
    console.log(`  1. Review generated docs in .succ/brain/`);
    console.log(`  2. Run \`succ index\` to create embeddings`);
    console.log(`  3. Open in Obsidian for graph view`);
    return;
  }

  // Default: Use Claude Code CLI (with tools disabled, context passed in prompt)
  if (parallel) {
    await runAgentsParallel(agents, context);
  } else {
    await runAgentsSequential(agents, context);
  }

  // Generate index files
  await generateIndexFiles(brainDir, projectName);
  saveState();

  console.log('\n✅ Brain vault generated!');
  console.log(`\nNext steps:`);
  console.log(`  1. Review generated docs in .succ/brain/`);
  console.log(`  2. Run \`succ index\` to create embeddings`);
  console.log(`  3. Open in Obsidian for graph view`);
}

function getAgents(brainDir: string, projectName: string, fast = false): Agent[] {
  const projectDir = path.join(brainDir, '01_Projects', projectName);

  // Helper for frontmatter
  const frontmatter = (desc: string, type: string = 'technical', rel: string = 'high') =>
    `Start with this YAML frontmatter:\n---\ndescription: "${desc}"\nproject: ${projectName}\ntype: ${type}\nrelevance: ${rel}\n---\n\n`;

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

    // Systems documentation - creates individual files for each detected system
    {
      name: 'systems-overview',
      outputPath: path.join(projectDir, 'Systems', 'Systems Overview.md'),
      prompt: `${frontmatter('Core systems and their interactions', 'systems')}Analyze this codebase and identify DISTINCT SYSTEMS/MODULES.

Your task has TWO parts:

## PART 1: Create Systems Overview (MOC)
Create "# Systems Overview" as a Map of Content linking to individual system files.

Format:
\`\`\`
# Systems Overview

**Parent:** [[${projectName}]]

## Core Systems

| System | Description | Key Files |
|--------|-------------|-----------|
| [[Embedding System]] | Handles vector embeddings | embeddings.ts |
| [[Database System]] | SQLite storage layer | db.js |
...

## System Interactions

[Describe how systems interact with each other]
\`\`\`

## PART 2: Create Individual System Files
After the MOC, output EACH system as a separate document using this delimiter:

===FILE: {System Name}.md===

Each system file should have:
- YAML frontmatter with description, project: ${projectName}, type: system
- Title matching filename
- **Parent:** [[Systems Overview]]
- Sections: Purpose, Key Components, Key Files, Dependencies, API/Interface

Example output structure:
\`\`\`
---
description: "Core systems and their interactions"
...
---

# Systems Overview
...table with [[wikilinks]]...

===FILE: Embedding System.md===
---
description: "Vector embedding generation and management"
project: ${projectName}
type: system
---

# Embedding System

**Parent:** [[Systems Overview]]

## Purpose
...

===FILE: Database System.md===
---
description: "SQLite storage layer"
...
\`\`\`

IMPORTANT:
- Only create files for systems that ACTUALLY EXIST in this codebase
- Use [[wikilinks]] to link between systems
- Each system file must start with ===FILE: {name}.md===
- Output ONLY markdown, no explanations`,
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

    // Features (from actual code) - creates individual files for major features
    {
      name: 'features',
      outputPath: path.join(projectDir, 'Features', 'Features Overview.md'),
      prompt: `${frontmatter('Implemented features and capabilities', 'features')}Analyze this codebase and identify MAJOR FEATURES.

Your task has TWO parts:

## PART 1: Create Features Overview (MOC)
Create "# Features Overview" as a Map of Content linking to individual feature files.

Format:
\`\`\`
# Features Overview

**Parent:** [[${projectName}]]

## Core Features

| Feature | Description | Status |
|---------|-------------|--------|
| [[Memory System]] | Persistent semantic memory | Implemented |
| [[Search]] | Vector similarity search | Implemented |
...

## Feature Categories

- **Core**: Main functionality
- **Integration**: External integrations
- **CLI**: Command-line interface
\`\`\`

## PART 2: Create Individual Feature Files
After the MOC, output MAJOR features as separate documents using this delimiter:

===FILE: {Feature Name}.md===

Each feature file should have:
- YAML frontmatter with description, project: ${projectName}, type: feature
- Title matching filename
- **Parent:** [[Features Overview]]
- Sections: Overview, Capabilities, Key Files, Usage Examples, Related Features

Example:
\`\`\`
---
description: "Implemented features and capabilities"
...
---

# Features Overview
...table with [[wikilinks]]...

===FILE: Memory System.md===
---
description: "Persistent semantic memory storage"
project: ${projectName}
type: feature
---

# Memory System

**Parent:** [[Features Overview]]

## Overview
...

## Capabilities
- Save observations, decisions, learnings
- Semantic search across memories
...
\`\`\`

IMPORTANT:
- Only create files for MAJOR features (not every small function)
- Group related small features into one file
- Use [[wikilinks]] to link between features and systems
- Each feature file must start with ===FILE: {name}.md===
- Output ONLY markdown, no explanations`,
    },
  ];

  // Fast mode: skip the slowest multi-file agents
  if (fast) {
    const skipAgents = ['systems-overview', 'features'];
    return agents.filter(a => !skipAgents.includes(a.name));
  }

  return agents;
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
 * Run agents using OpenRouter API directly (faster, no tool calls)
 */
async function runAgentsOpenRouter(
  agents: Agent[],
  context: string,
  writeProgress: ProgressFn,
  fast = false
): Promise<void> {
  console.log(`Running ${agents.length} agents via OpenRouter API...\n`);

  let config;
  try {
    config = getConfig();
  } catch {
    console.error('Error: OPENROUTER_API_KEY not set');
    console.error('Set it via env var or ~/.succ/config.json');
    process.exit(1);
  }

  const totalStart = Date.now();
  const timings: AgentTiming[] = [];
  let completed = 0;
  for (const agent of agents) {
    writeProgress('running', completed, agents.length, agent.name);
    const spinner = ora(`${agent.name}`).start();
    const agentStart = Date.now();

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openrouter_api_key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/cpz/succ',
          'X-Title': 'succ',
        },
        body: JSON.stringify({
          model: fast ? 'anthropic/claude-3-haiku' : 'anthropic/claude-3.5-haiku',
          messages: [
            {
              role: 'user',
              content: `You are analyzing a software project. Here is the project structure and key files:\n\n${context}\n\n---\n\n${agent.prompt}`,
            },
          ],
          max_tokens: fast ? 2048 : 4096,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API error: ${response.status} - ${error}`);
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = data.choices[0]?.message?.content;

      if (content) {
        // Write output (handles both single and multi-file)
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
      const elapsed = Date.now() - agentStart;
      spinner.fail(`${agent.name}: ${error}`);
      timings.push({ name: agent.name, durationMs: elapsed, success: false });
    }
  }

  printTimingSummary(timings, Date.now() - totalStart);
}

/**
 * Run agents using local LLM API (Ollama, LM Studio, llama.cpp, etc.)
 */
async function runAgentsLocal(
  agents: Agent[],
  context: string,
  writeProgress: ProgressFn,
  fast = false
): Promise<void> {
  const config = getConfig();

  const apiUrl = config.analyze_api_url;
  const model = config.analyze_model;
  const temperature = config.analyze_temperature ?? 0.3;
  const defaultMaxTokens = fast ? 2048 : 4096;
  const maxTokens = config.analyze_max_tokens ?? defaultMaxTokens;

  if (!apiUrl) {
    console.error('Error: analyze_api_url not configured');
    console.error('Set it in ~/.succ/config.json:');
    console.error('  "analyze_api_url": "http://localhost:11434/v1"  // Ollama');
    console.error('  "analyze_api_url": "http://localhost:1234/v1"   // LM Studio');
    process.exit(1);
  }

  if (!model) {
    console.error('Error: analyze_model not configured');
    console.error('Set it in ~/.succ/config.json:');
    console.error('  "analyze_model": "qwen2.5-coder:32b"  // Ollama');
    console.error('  "analyze_model": "deepseek-coder-v2"  // LM Studio');
    process.exit(1);
  }

  console.log(`Running ${agents.length} agents via local LLM...`);
  console.log(`  API: ${apiUrl}`);
  console.log(`  Model: ${model}\n`);

  const totalStart = Date.now();
  const timings: AgentTiming[] = [];
  let completed = 0;
  for (const agent of agents) {
    writeProgress('running', completed, agents.length, agent.name);
    const spinner = ora(`${agent.name}`).start();
    const agentStart = Date.now();

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Add API key if configured
      if (config.analyze_api_key) {
        headers['Authorization'] = `Bearer ${config.analyze_api_key}`;
      }

      // Build the completion endpoint URL
      const completionUrl = apiUrl.endsWith('/v1')
        ? `${apiUrl}/chat/completions`
        : apiUrl.endsWith('/')
          ? `${apiUrl}v1/chat/completions`
          : `${apiUrl}/v1/chat/completions`;

      const response = await fetch(completionUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
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
          temperature,
          max_tokens: maxTokens,
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
      const content = data.choices[0]?.message?.content;

      if (content) {
        // Write output (handles both single and multi-file)
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
      const elapsed = Date.now() - agentStart;
      spinner.fail(`${agent.name}: ${error}`);
      timings.push({ name: agent.name, durationMs: elapsed, success: false });
    }
  }

  printTimingSummary(timings, Date.now() - totalStart);
}

/**
 * Gather project context for OpenRouter analysis
 */
async function gatherProjectContext(projectRoot: string, fast = false): Promise<string> {
  const parts: string[] = [];

  // Get file tree
  const files = await glob('**/*.{ts,js,go,py,md,json}', {
    cwd: projectRoot,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/vendor/**'],
    nodir: true,
  });

  const fileLimit = fast ? 20 : 50;
  parts.push('## File Structure\n```');
  parts.push(files.slice(0, fileLimit).join('\n'));
  if (files.length > fileLimit) parts.push(`... and ${files.length - fileLimit} more files`);
  parts.push('```\n');

  // Read key files
  const keyFiles = ['package.json', 'go.mod', 'pyproject.toml', 'Cargo.toml', 'README.md'];
  for (const keyFile of keyFiles) {
    const filePath = path.join(projectRoot, keyFile);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').slice(0, 2000);
      parts.push(`## ${keyFile}\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }

  // Read a few source files
  const sourceFileLimit = fast ? 3 : 5;
  const truncateLimit = fast ? 1000 : 1500;
  const sourceFiles = files.filter(f => f.endsWith('.ts') || f.endsWith('.go') || f.endsWith('.py')).slice(0, sourceFileLimit);
  for (const sourceFile of sourceFiles) {
    const filePath = path.join(projectRoot, sourceFile);
    const content = fs.readFileSync(filePath, 'utf-8').slice(0, truncateLimit);
    parts.push(`## ${sourceFile}\n\`\`\`\n${content}\n\`\`\`\n`);
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
  mode?: 'claude' | 'openrouter' | 'local';
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
  const config = getConfig();
  const projectRoot = getProjectRoot();
  const succDir = getSuccDir();
  const brainDir = path.join(succDir, 'brain');

  // Determine mode (default to config or 'claude', but 'claude' not supported for single file)
  let mode = options.mode || config.analyze_mode || 'claude';

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

    if (mode === 'local') {
      const apiUrl = config.analyze_api_url;
      const model = config.analyze_model;

      if (!apiUrl || !model) {
        return {
          success: false,
          error: 'Local LLM not configured. Set analyze_api_url and analyze_model in ~/.succ/config.json',
        };
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (config.analyze_api_key) {
        headers['Authorization'] = `Bearer ${config.analyze_api_key}`;
      }

      const completionUrl = apiUrl.endsWith('/v1')
        ? `${apiUrl}/chat/completions`
        : apiUrl.endsWith('/')
          ? `${apiUrl}v1/chat/completions`
          : `${apiUrl}/v1/chat/completions`;

      const response = await fetch(completionUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: 'You are an expert software documentation writer. Generate clear, concise documentation.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: config.analyze_temperature ?? 0.3,
          max_tokens: config.analyze_max_tokens ?? 4096,
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
      content = data.choices[0]?.message?.content || null;
    } else if (mode === 'openrouter') {
      const apiKey = config.openrouter_api_key;
      if (!apiKey) {
        return { success: false, error: 'OpenRouter API key not configured' };
      }

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/vinaes/succ',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-3-haiku',
          messages: [
            {
              role: 'system',
              content: 'You are an expert software documentation writer. Generate clear, concise documentation.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 4096,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        return { success: false, error: `OpenRouter error: ${response.status} - ${error}` };
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      content = data.choices[0]?.message?.content || null;
    } else {
      // Claude CLI mode
      try {
        const { spawnClaudeCLISync } = await import('../lib/llm.js');
        content = spawnClaudeCLISync(prompt, { tools: '', model: 'haiku', timeout: 120000 }) || null;
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
