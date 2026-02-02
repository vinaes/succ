import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { getProjectRoot, getSuccDir, getConfig } from '../lib/config.js';
import { withLock, getLockStatus } from '../lib/lock.js';

interface AnalyzeOptions {
  parallel?: boolean;
  openrouter?: boolean;
  local?: boolean;  // Use local LLM API
  background?: boolean;
  daemon?: boolean;  // Continuous background analysis mode
  interval?: number;  // Interval in minutes for daemon mode (default: 30)
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
  const { parallel = true, openrouter = false, local = false, background = false, daemon = false, interval = 30 } = options;

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

  // Daemon mode: continuous background analysis as separate daemon
  if (daemon) {
    await manageDaemon(projectRoot, succDir, brainDir, interval, openrouter);
    return;
  }

  // Background mode: spawn detached process and exit
  if (background) {
    const logFile = path.join(succDir, 'analyze.log');
    const args = ['analyze'];
    if (!parallel) args.push('--sequential');
    if (openrouter) args.push('--openrouter');

    // Spawn detached process
    const child = spawn(process.execPath, [process.argv[1], ...args], {
      detached: true,
      stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')],
      cwd: projectRoot,
    });

    child.unref();

    console.log('🚀 Analysis started in background');
    console.log(`   Log file: ${logFile}`);
    console.log(`   Check progress: tail -f "${logFile}"`);
    console.log(`   Or run: succ status`);
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
  console.log(`Mode: ${parallel ? 'parallel' : 'sequential'}`);
  console.log(`Backend: ${backendName}\n`);

  writeProgress('starting', 0, 4);

  // Ensure brain structure exists
  await ensureBrainStructure(brainDir, projectRoot);

  // Define agents
  const projectName = path.basename(projectRoot);
  const agents = getAgents(brainDir, projectName);

  // Gather project context (used by all modes now)
  writeProgress('gathering_context', 0, agents.length, 'Gathering project context');
  const context = await gatherProjectContext(projectRoot);

  // Run agents based on mode
  if (mode === 'openrouter') {
    await runAgentsOpenRouter(agents, context, writeProgress);
    await generateIndexFiles(brainDir, projectName);
    writeProgress('completed', agents.length, agents.length);
    console.log('\n✅ Brain vault generated!');
    console.log(`\nNext steps:`);
    console.log(`  1. Review generated docs in .succ/brain/`);
    console.log(`  2. Run \`succ index\` to create embeddings`);
    console.log(`  3. Open in Obsidian for graph view`);
    return;
  }

  if (mode === 'local') {
    await runAgentsLocal(agents, context, writeProgress);
    await generateIndexFiles(brainDir, projectName);
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

  console.log('\n✅ Brain vault generated!');
  console.log(`\nNext steps:`);
  console.log(`  1. Review generated docs in .succ/brain/`);
  console.log(`  2. Run \`succ index\` to create embeddings`);
  console.log(`  3. Open in Obsidian for graph view`);
}

function getAgents(brainDir: string, projectName: string): Agent[] {
  const projectDir = path.join(brainDir, '01_Projects', projectName);

  // Helper for frontmatter
  const frontmatter = (desc: string, type: string = 'technical', rel: string = 'high') =>
    `Start with this YAML frontmatter:\n---\ndescription: "${desc}"\nproject: ${projectName}\ntype: ${type}\nrelevance: ${rel}\n---\n\n`;

  return [
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
}

async function runAgentsParallel(agents: Agent[], context: string): Promise<void> {
  console.log(`Starting ${agents.length} agents in parallel...\n`);

  const promises = agents.map((agent) => runClaudeAgent(agent, context));
  const results = await Promise.allSettled(promises);

  let succeeded = 0;
  let failed = 0;

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      succeeded++;
      console.log(`✓ ${agents[index].name}`);
    } else {
      failed++;
      console.log(`✗ ${agents[index].name}: ${result.reason}`);
    }
  });

  console.log(`\nCompleted: ${succeeded}/${agents.length} agents`);
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

  for (const agent of agents) {
    try {
      await runClaudeAgent(agent, context);
      console.log(`✓ ${agent.name}`);
    } catch (error) {
      console.log(`✗ ${agent.name}: ${error}`);
    }
  }
}

/**
 * Manage daemon - start, stop, or check status
 */
async function manageDaemon(
  projectRoot: string,
  succDir: string,
  brainDir: string,
  intervalMinutes: number,
  openrouter: boolean
): Promise<void> {
  const pidFile = path.join(succDir, 'daemon.pid');
  const logFile = path.join(succDir, 'daemon.log');

  // Check if daemon is already running
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isProcessRunning(pid)) {
      console.log(`🔄 Daemon already running (PID: ${pid})`);
      console.log(`   Log: ${logFile}`);
      console.log(`   Stop: succ analyze --stop`);
      console.log(`   Status: succ analyze --status`);
      return;
    } else {
      // Stale pid file, remove it
      fs.unlinkSync(pidFile);
    }
  }

  console.log('🚀 Starting daemon...');

  // Spawn detached process that runs the actual daemon loop
  const child = spawn(process.execPath, [
    process.argv[1],
    'analyze',
    '--daemon-worker',
    '--interval', String(intervalMinutes),
    ...(openrouter ? ['--openrouter'] : [])
  ], {
    detached: true,
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
    cwd: projectRoot,
    env: { ...process.env, SUCC_DAEMON: '1' }
  });

  // Write PID file
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();

  console.log(`✅ Daemon started (PID: ${child.pid})`);
  console.log(`   Log: ${logFile}`);
  console.log(`   Interval: ${intervalMinutes} minutes`);
  console.log(`\n   Stop:   succ analyze --stop`);
  console.log(`   Status: succ analyze --status`);
}

/**
 * Check if a process is running by PID
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop daemon
 */
export async function stopAnalyzeDaemon(): Promise<void> {
  const succDir = getSuccDir();
  const pidFile = path.join(succDir, 'daemon.pid');

  if (!fs.existsSync(pidFile)) {
    console.log('No daemon running');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);

  if (isProcessRunning(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`✅ Daemon stopped (PID: ${pid})`);
    } catch (e) {
      console.error(`Failed to stop daemon: ${e}`);
    }
  } else {
    console.log('Daemon not running (stale PID file)');
  }

  fs.unlinkSync(pidFile);
}

/**
 * Show daemon status
 */
export async function analyzeDaemonStatus(): Promise<void> {
  const succDir = getSuccDir();
  const pidFile = path.join(succDir, 'daemon.pid');
  const stateFile = path.join(succDir, 'daemon.state.json');
  const logFile = path.join(succDir, 'daemon.log');

  console.log('📊 Daemon Status\n');

  // Check daemon
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isProcessRunning(pid)) {
      console.log(`Daemon: ✅ Running (PID: ${pid})`);
    } else {
      console.log('Daemon: ⚠️  Not running (stale PID file)');
    }
  } else {
    console.log('Daemon: ⏹️  Stopped');
  }

  // Check lock status
  const lockStatus = getLockStatus();
  if (lockStatus.locked && lockStatus.info) {
    console.log(`Lock: 🔒 Held by PID ${lockStatus.info.pid} (${lockStatus.info.operation})`);
  } else {
    console.log('Lock: 🔓 Free');
  }

  // Check state
  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as DaemonState;
      console.log(`\nRuns completed: ${state.runsCompleted}`);
      console.log(`Memories created: ${state.memoriesCreated}`);
      console.log(`Documents updated: ${state.documentsUpdated}`);
      if (state.lastRun) {
        console.log(`Last run: ${state.lastRun}`);
      }
    } catch {
      console.log('\nState: Unable to read');
    }
  }

  console.log(`\nLog file: ${logFile}`);
}

/**
 * Internal: Run daemon worker (called by daemon process)
 */
export async function runDaemonWorker(intervalMinutes: number, openrouter: boolean): Promise<void> {
  const projectRoot = getProjectRoot();
  const succDir = getSuccDir();
  const brainDir = path.join(succDir, 'brain');

  await runDaemonMode(projectRoot, succDir, brainDir, intervalMinutes, openrouter);
}

interface RunAgentOptions {
  noTimeout?: boolean;  // For daemon mode - no timeout
}

function runClaudeAgent(agent: Agent, context: string, options: RunAgentOptions = {}): Promise<void> {
  const { noTimeout = false } = options;

  return new Promise((resolve, reject) => {
    // Ensure output directory exists
    const outputDir = path.dirname(agent.outputPath);
    fs.mkdirSync(outputDir, { recursive: true });

    // Build prompt with context
    const fullPrompt = `You are analyzing a software project. Here is the project structure and key files:

${context}

---

${agent.prompt}`;

    // Write prompt to temp file to avoid command line length issues
    const tempPromptFile = path.join(outputDir, `.${agent.name}-prompt.txt`);
    fs.writeFileSync(tempPromptFile, fullPrompt);

    // Run claude CLI with:
    // - --tools "" to disable all tools (no file reading, just generate from context)
    // - --model haiku for speed
    // - -p for print mode
    // - Read prompt from stdin via cat
    const proc = spawn('claude', [
      '-p',
      '--tools', '',
      '--model', 'haiku',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    // Send prompt via stdin
    proc.stdin?.write(fullPrompt);
    proc.stdin?.end();

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', async (code) => {
      // Clean up temp file
      try { fs.unlinkSync(tempPromptFile); } catch {}

      if (code === 0 && stdout.trim()) {
        // Write output (handles both single and multi-file)
        await writeAgentOutput(agent, stdout.trim());
        resolve();
      } else {
        reject(new Error(stderr || `Exit code ${code}, no output`));
      }
    });

    proc.on('error', (err) => {
      try { fs.unlinkSync(tempPromptFile); } catch {}
      reject(err);
    });

    // Timeout only for non-daemon mode (3 minutes for multi-file agents)
    if (!noTimeout) {
      setTimeout(() => {
        proc.kill();
        try { fs.unlinkSync(tempPromptFile); } catch {}
        reject(new Error('Timeout (3 min)'));
      }, 180000);
    }
  });
}

type ProgressFn = (status: string, completed: number, total: number, current?: string) => void;

/**
 * Run agents using OpenRouter API directly (faster, no tool calls)
 */
async function runAgentsOpenRouter(
  agents: Agent[],
  context: string,
  writeProgress: ProgressFn
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

  let completed = 0;
  for (const agent of agents) {
    writeProgress('running', completed, agents.length, agent.name);
    console.log(`  ${agent.name}...`);

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
          model: 'anthropic/claude-3.5-haiku',
          messages: [
            {
              role: 'user',
              content: `You are analyzing a software project. Here is the project structure and key files:\n\n${context}\n\n---\n\n${agent.prompt}`,
            },
          ],
          max_tokens: 4096,
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
        console.log(`  ✓ ${agent.name}`);
      } else {
        console.log(`  ✗ ${agent.name}: No content returned`);
      }
    } catch (error) {
      console.log(`  ✗ ${agent.name}: ${error}`);
    }
  }
}

/**
 * Run agents using local LLM API (Ollama, LM Studio, llama.cpp, etc.)
 */
async function runAgentsLocal(
  agents: Agent[],
  context: string,
  writeProgress: ProgressFn
): Promise<void> {
  const config = getConfig();

  const apiUrl = config.analyze_api_url;
  const model = config.analyze_model;
  const temperature = config.analyze_temperature ?? 0.3;
  const maxTokens = config.analyze_max_tokens ?? 4096;

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

  let completed = 0;
  for (const agent of agents) {
    writeProgress('running', completed, agents.length, agent.name);
    console.log(`  ${agent.name}...`);

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
        console.log(`  ✓ ${agent.name}`);
      } else {
        console.log(`  ✗ ${agent.name}: No content returned`);
      }
    } catch (error) {
      console.log(`  ✗ ${agent.name}: ${error}`);
    }
  }
}

/**
 * Gather project context for OpenRouter analysis
 */
async function gatherProjectContext(projectRoot: string): Promise<string> {
  const parts: string[] = [];

  // Get file tree
  const files = await glob('**/*.{ts,js,go,py,md,json}', {
    cwd: projectRoot,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/vendor/**'],
    nodir: true,
  });

  parts.push('## File Structure\n```');
  parts.push(files.slice(0, 50).join('\n'));
  if (files.length > 50) parts.push(`... and ${files.length - 50} more files`);
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
  const sourceFiles = files.filter(f => f.endsWith('.ts') || f.endsWith('.go') || f.endsWith('.py')).slice(0, 5);
  for (const sourceFile of sourceFiles) {
    const filePath = path.join(projectRoot, sourceFile);
    const content = fs.readFileSync(filePath, 'utf-8').slice(0, 1500);
    parts.push(`## ${sourceFile}\n\`\`\`\n${content}\n\`\`\`\n`);
  }

  return parts.join('\n');
}

/**
 * Daemon mode: continuous background analysis
 * Runs periodically to discover new patterns, update docs, save to memory
 */
async function runDaemonMode(
  projectRoot: string,
  succDir: string,
  brainDir: string,
  intervalMinutes: number,
  openrouter: boolean
): Promise<void> {
  const { execFileSync } = await import('child_process');
  const logFile = path.join(succDir, 'daemon.log');
  const stateFile = path.join(succDir, 'daemon.state.json');

  const log = (msg: string) => {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    fs.appendFileSync(logFile, line);
    console.log(msg);
  };

  log(`🔄 Starting daemon mode (interval: ${intervalMinutes} min)`);
  log(`   Log: ${logFile}`);
  log(`   Stop: kill the process or Ctrl+C`);

  // Load or initialize state
  let state: DaemonState = {
    lastRun: null,
    runsCompleted: 0,
    memoriesCreated: 0,
    documentsUpdated: 0,
    lastGitCommit: null,
  };

  if (fs.existsSync(stateFile)) {
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    } catch {
      // Invalid state, use default
    }
  }

  const saveState = () => {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  };

  // Get current git commit safely
  const getCurrentCommit = (): string | null => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
    } catch {
      return null;
    }
  };

  // Check if this is the first run (no brain vault exists yet)
  const projectName = path.basename(projectRoot);
  const systemsOverviewPath = path.join(brainDir, '01_Projects', projectName, 'Systems', 'Systems Overview.md');
  const isFirstRun = !fs.existsSync(systemsOverviewPath);

  // Run analysis loop
  const runAnalysis = async (forceFullAnalysis: boolean = false) => {
    log(`\n--- Daemon run #${state.runsCompleted + 1} ---`);

    try {
      // Check if codebase changed since last run
      const currentCommit = getCurrentCommit();
      const codeChanged = currentCommit !== state.lastGitCommit;

      // Gather context
      const context = await gatherProjectContext(projectRoot);

      // First run or force full: run all 7 agents to create brain vault
      if (forceFullAnalysis || (isFirstRun && state.runsCompleted === 0)) {
        log('🧠 Running full analysis (first run or forced)...');

        // Ensure brain structure exists
        await ensureBrainStructure(brainDir, projectRoot);

        const agents = getAgents(brainDir, projectName);

        for (const agent of agents) {
          try {
            log(`  Running ${agent.name}...`);
            if (openrouter) {
              await runAgentOpenRouter(agent, context);
            } else {
              await runClaudeAgent(agent, context, { noTimeout: true });
            }
            state.documentsUpdated++;
            log(`  ✓ ${agent.name}`);
          } catch (e) {
            log(`  ✗ ${agent.name}: ${e}`);
          }
        }

        // Generate index files
        await generateIndexFiles(brainDir, projectName);
        log('✅ Full brain vault generated');
      } else {
        // Incremental analysis
        if (!codeChanged && state.lastRun) {
          log('No code changes detected, running discovery only...');
        }

        // Run discovery agent to find new patterns/learnings
        const discoveries = await runDiscoveryAgent(context, openrouter);

        if (discoveries.length > 0) {
          log(`Found ${discoveries.length} discoveries`);

          // Save discoveries to memory (with deduplication)
          for (const discovery of discoveries) {
            const saved = await saveDiscoveryToMemory(discovery);
            if (saved) {
              state.memoriesCreated++;
              log(`  + Saved: ${discovery.title.substring(0, 50)}...`);
            } else {
              log(`  ~ Skipped (duplicate): ${discovery.title.substring(0, 30)}...`);
            }
          }
        } else {
          log('No new discoveries found');
        }

        // Update technical docs if code changed significantly
        if (codeChanged) {
          log('Code changed, updating documentation...');
          const agents = getAgents(brainDir, projectName);
          // Update architecture, api, systems-overview, features on code change
          const agentsToUpdate = agents.filter(a =>
            ['architecture', 'api', 'systems-overview', 'features'].includes(a.name)
          );

          for (const agent of agentsToUpdate) {
            try {
              log(`  Updating ${agent.name}...`);
              if (openrouter) {
                await runAgentOpenRouter(agent, context);
              } else {
                await runClaudeAgent(agent, context, { noTimeout: true });
              }
              state.documentsUpdated++;
              log(`  ✓ Updated ${agent.name}`);
            } catch (e) {
              log(`  ✗ Failed ${agent.name}: ${e}`);
            }
          }
        }
      }

      state.lastRun = new Date().toISOString();
      state.lastGitCommit = currentCommit;
      state.runsCompleted++;
      saveState();

      log(`Run completed. Total: ${state.memoriesCreated} memories, ${state.documentsUpdated} docs updated`);
    } catch (error) {
      log(`Error in daemon run: ${error}`);
    }
  };

  // Initial run (full analysis if first time)
  await runAnalysis(isFirstRun);

  // Schedule periodic runs (incremental)
  const intervalMs = intervalMinutes * 60 * 1000;
  setInterval(() => runAnalysis(false), intervalMs);

  // Keep process alive
  log(`\nNext run in ${intervalMinutes} minutes. Press Ctrl+C to stop.`);
}

interface DaemonState {
  lastRun: string | null;
  runsCompleted: number;
  memoriesCreated: number;
  documentsUpdated: number;
  lastGitCommit: string | null;
}

interface Discovery {
  type: 'learning' | 'pattern' | 'decision' | 'observation';
  title: string;
  content: string;
  tags: string[];
}

/**
 * Run a discovery agent to find patterns, learnings, and insights
 */
async function runDiscoveryAgent(
  context: string,
  openrouter: boolean
): Promise<Discovery[]> {
  const prompt = `You are analyzing a software project to discover patterns, learnings, and insights worth remembering.

Project context:
${context}

---

Analyze this codebase and identify:
1. **Patterns** - Recurring code patterns, architectural patterns, design decisions
2. **Learnings** - Interesting techniques, workarounds, solutions to problems
3. **Observations** - Notable things about code quality, structure, dependencies

Output a JSON array of discoveries. Each discovery should have:
- type: "learning" | "pattern" | "observation"
- title: Short title (max 60 chars)
- content: Detailed description (2-4 sentences)
- tags: Array of relevant tags

Example output:
[
  {
    "type": "pattern",
    "title": "Command pattern for CLI",
    "content": "Uses command pattern with separate files per command in src/commands/. Each exports an async function matching the command name.",
    "tags": ["architecture", "cli", "patterns"]
  }
]

Output ONLY the JSON array, no other text.`;

  try {
    let response: string;

    if (openrouter) {
      const config = getConfig();
      const result = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openrouter_api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-3.5-haiku',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2048,
        }),
      });
      const data = await result.json() as { choices: Array<{ message: { content: string } }> };
      response = data.choices[0]?.message?.content || '[]';
    } else {
      // Use Claude CLI via spawn (safer than exec)
      response = await new Promise<string>((resolve, reject) => {
        const proc = spawn('claude', ['-p', '--tools', '', '--model', 'haiku'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true,
        });

        proc.stdin?.write(prompt);
        proc.stdin?.end();

        let stdout = '';
        proc.stdout?.on('data', (data) => { stdout += data.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(`Exit code ${code}`));
        });
        proc.on('error', reject);

        setTimeout(() => { proc.kill(); reject(new Error('Timeout')); }, 60000);
      });
    }

    // Parse JSON from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Save discovery to memory with deduplication
 * Uses file-based locking to prevent race conditions with CLI
 */
async function saveDiscoveryToMemory(discovery: Discovery): Promise<boolean> {
  try {
    return await withLock('daemon-memory', async () => {
      // Check for duplicates using semantic similarity
      const { saveMemory, searchMemories } = await import('../lib/db.js');
      const { getEmbedding } = await import('../lib/embeddings.js');

      // Generate embedding for the discovery
      const searchText = discovery.title + ' ' + discovery.content;
      const embedding = await getEmbedding(searchText);

      // Search for similar memories
      const similar = searchMemories(embedding, 3, 0.3);

      // If very similar memory exists (>0.85 similarity), skip
      for (const mem of similar) {
        if (mem.similarity > 0.85) {
          return false; // Duplicate found
        }
      }

      // Save new memory with the embedding we already have
      const memoryTags = discovery.tags.length > 0 ? discovery.tags : ['daemon'];
      saveMemory(
        discovery.content,
        embedding,
        memoryTags,
        `daemon-${discovery.type}`,
        {
          type: discovery.type as 'observation' | 'decision' | 'learning' | 'error' | 'pattern',
          deduplicate: false, // Already checked above
        }
      );

      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Run single agent via OpenRouter
 */
async function runAgentOpenRouter(agent: Agent, context: string): Promise<void> {
  const config = getConfig();
  const fullPrompt = `You are analyzing a software project. Here is the project structure and key files:\n\n${context}\n\n---\n\n${agent.prompt}`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouter_api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-3.5-haiku',
      messages: [{ role: 'user', content: fullPrompt }],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  const content = data.choices[0]?.message?.content;

  if (content) {
    // Write output (handles both single and multi-file)
    await writeAgentOutput(agent, content);
  }
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
