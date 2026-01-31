import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { getProjectRoot, getClaudeDir, getConfig } from '../lib/config.js';

interface AnalyzeOptions {
  parallel?: boolean;
  openrouter?: boolean;
  background?: boolean;
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
  const { parallel = true, openrouter = false, background = false } = options;
  const projectRoot = getProjectRoot();
  const claudeDir = getClaudeDir();
  const brainDir = path.join(claudeDir, 'brain');

  // Background mode: spawn detached process and exit
  if (background) {
    const logFile = path.join(claudeDir, 'analyze.log');
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
  const progressFile = path.join(claudeDir, 'analyze.progress.json');
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

  console.log('🧠 Analyzing project with Claude agents...\n');
  console.log(`Project: ${projectRoot}`);
  console.log(`Mode: ${parallel ? 'parallel' : 'sequential'}`);
  console.log(`Backend: ${openrouter ? 'OpenRouter API' : 'Claude Code CLI'}\n`);

  writeProgress('starting', 0, 4);

  // Ensure brain structure exists
  await ensureBrainStructure(brainDir, projectRoot);

  // Define agents
  const projectName = path.basename(projectRoot);
  const agents = getAgents(brainDir, projectName);

  if (openrouter) {
    await runAgentsOpenRouter(agents, projectRoot, writeProgress);
    await generateIndexFiles(brainDir, projectName);
    writeProgress('completed', agents.length, agents.length);
    console.log('\n✅ Brain vault generated!');
    console.log(`\nNext steps:`);
    console.log(`  1. Review generated docs in .claude/brain/`);
    console.log(`  2. Run \`succ index\` to create embeddings`);
    console.log(`  3. Open in Obsidian for graph view`);
    return;
  }

  // Use Claude Code CLI
  if (parallel) {
    await runAgentsParallel(agents);
  } else {
    await runAgentsSequential(agents);
  }

  // Generate index files
  await generateIndexFiles(brainDir, projectName);

  console.log('\n✅ Brain vault generated!');
  console.log(`\nNext steps:`);
  console.log(`  1. Review generated docs in .claude/brain/`);
  console.log(`  2. Run \`succ index\` to create embeddings`);
  console.log(`  3. Open in Obsidian for graph view`);
}

function getAgents(brainDir: string, projectName: string): Agent[] {
  const projectDir = path.join(brainDir, '01_Projects', projectName);

  // Shorter prompts for faster execution
  const frontmatter = (desc: string, rel: string = 'high') =>
    `Start with this YAML frontmatter:\n---\ndescription: "${desc}"\nproject: ${projectName}\ntype: technical\nrelevance: ${rel}\n---\n\n`;

  return [
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
      prompt: `${frontmatter('Coding conventions and patterns', 'medium')}Create "# Conventions" document.

Add "**Parent:** [[Architecture Overview]]" after title.

Document: naming conventions, file organization, common patterns, error handling approach.

Output ONLY markdown.`,
    },
    {
      name: 'dependencies',
      outputPath: path.join(projectDir, 'Technical', 'Dependencies.md'),
      prompt: `${frontmatter('Key dependencies and their purposes', 'medium')}Create "# Dependencies" document.

Add "**Parent:** [[Architecture Overview]]" after title.

List important dependencies with: name, purpose, where used. Group by category.

Output ONLY markdown.`,
    },
  ];
}

async function runAgentsParallel(agents: Agent[]): Promise<void> {
  console.log(`Starting ${agents.length} agents in parallel...\n`);

  const promises = agents.map((agent) => runClaudeAgent(agent));
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

async function runAgentsSequential(agents: Agent[]): Promise<void> {
  console.log(`Running ${agents.length} agents sequentially...\n`);

  for (const agent of agents) {
    try {
      await runClaudeAgent(agent);
      console.log(`✓ ${agent.name}`);
    } catch (error) {
      console.log(`✗ ${agent.name}: ${error}`);
    }
  }
}

function runClaudeAgent(agent: Agent): Promise<void> {
  return new Promise((resolve, reject) => {
    // Ensure output directory exists
    const outputDir = path.dirname(agent.outputPath);
    fs.mkdirSync(outputDir, { recursive: true });

    // Run claude CLI with -p (print mode), fast model, and capture stdout
    const proc = spawn('claude', [
      '-p', agent.prompt,
      '--permission-mode', 'bypassPermissions',
      '--model', 'haiku',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        // Write output to file
        fs.writeFileSync(agent.outputPath, stdout.trim());
        resolve();
      } else {
        reject(new Error(stderr || `Exit code ${code}, no output`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });

    // Timeout after 3 minutes per agent
    setTimeout(() => {
      proc.kill();
      reject(new Error('Timeout (3 min)'));
    }, 180000);
  });
}

type ProgressFn = (status: string, completed: number, total: number, current?: string) => void;

/**
 * Run agents using OpenRouter API directly (faster, no tool calls)
 */
async function runAgentsOpenRouter(
  agents: Agent[],
  projectRoot: string,
  writeProgress: ProgressFn
): Promise<void> {
  console.log(`Running ${agents.length} agents via OpenRouter API...\n`);

  // Gather project context
  writeProgress('gathering_context', 0, agents.length, 'Gathering project context');
  const context = await gatherProjectContext(projectRoot);

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
        const outputDir = path.dirname(agent.outputPath);
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(agent.outputPath, content.trim());
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
