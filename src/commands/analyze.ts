import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getProjectRoot, getClaudeDir } from '../lib/config.js';

interface AnalyzeOptions {
  parallel?: boolean;
  openrouter?: boolean;
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
  const { parallel = true, openrouter = false } = options;
  const projectRoot = getProjectRoot();
  const claudeDir = getClaudeDir();
  const brainDir = path.join(claudeDir, 'brain');

  console.log('🧠 Analyzing project with Claude agents...\n');
  console.log(`Project: ${projectRoot}`);
  console.log(`Mode: ${parallel ? 'parallel' : 'sequential'}`);
  console.log(`Backend: ${openrouter ? 'OpenRouter API' : 'Claude Code CLI'}\n`);

  // Ensure brain structure exists
  await ensureBrainStructure(brainDir, projectRoot);

  // Define agents
  const projectName = path.basename(projectRoot);
  const agents = getAgents(brainDir, projectName);

  if (openrouter) {
    // Use OpenRouter API (fallback)
    console.log('OpenRouter mode not yet implemented. Use Claude CLI mode.');
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

  return [
    {
      name: 'architecture',
      outputPath: path.join(projectDir, 'Technical', 'Architecture Overview.md'),
      prompt: `Analyze this project's architecture. Create a markdown document with:

1. YAML frontmatter:
\`\`\`yaml
---
description: "High-level architecture overview"
project: ${projectName}
type: technical
relevance: high
---
\`\`\`

2. Title: # Architecture Overview

3. **Parent:** [[${projectName}]]

4. Sections:
- ## Overview (2-3 sentences about the system)
- ## Tech Stack (list with brief descriptions)
- ## Directory Structure (key folders explained)
- ## Entry Points (main files, how to run)
- ## Data Flow (how data moves through the system)
- ## Key Components (important modules/packages)

5. Add [[wikilinks]] to related concepts.

Output ONLY the markdown content, no explanations.`,
    },
    {
      name: 'api',
      outputPath: path.join(projectDir, 'Technical', 'API Reference.md'),
      prompt: `Analyze this project's API endpoints/routes. Create a markdown document with:

1. YAML frontmatter:
\`\`\`yaml
---
description: "API endpoints and routes reference"
project: ${projectName}
type: technical
relevance: high
---
\`\`\`

2. Title: # API Reference

3. **Parent:** [[Architecture Overview]]

4. For each endpoint/route:
- Method and path
- Brief description
- Key parameters
- Response format

5. Group by resource/domain.

If no API found, document CLI commands or main functions instead.

Output ONLY the markdown content, no explanations.`,
    },
    {
      name: 'conventions',
      outputPath: path.join(projectDir, 'Technical', 'Conventions.md'),
      prompt: `Analyze this project's coding conventions and patterns. Create a markdown document with:

1. YAML frontmatter:
\`\`\`yaml
---
description: "Coding conventions, patterns, and style guide"
project: ${projectName}
type: technical
relevance: medium
---
\`\`\`

2. Title: # Conventions

3. **Parent:** [[Architecture Overview]]

4. Sections:
- ## Naming Conventions (files, functions, variables)
- ## File Organization (how code is structured)
- ## Patterns Used (common patterns in the codebase)
- ## Error Handling (how errors are handled)
- ## Testing (test structure if present)

5. Include code examples where helpful.

Output ONLY the markdown content, no explanations.`,
    },
    {
      name: 'dependencies',
      outputPath: path.join(projectDir, 'Technical', 'Dependencies.md'),
      prompt: `Analyze this project's key dependencies. Create a markdown document with:

1. YAML frontmatter:
\`\`\`yaml
---
description: "Key dependencies and their purposes"
project: ${projectName}
type: technical
relevance: medium
---
\`\`\`

2. Title: # Dependencies

3. **Parent:** [[Architecture Overview]]

4. For each important dependency:
- Name and version
- What it's used for
- Where it's used in the codebase

5. Group by category (framework, database, utils, dev tools).

Focus on the important ones, not every tiny package.

Output ONLY the markdown content, no explanations.`,
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

    // Run claude CLI
    const proc = spawn('claude', ['-p', agent.prompt, '--output', agent.outputPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let stderr = '';

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `Exit code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      proc.kill();
      reject(new Error('Timeout'));
    }, 120000);
  });
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
