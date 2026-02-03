import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import inquirer from 'inquirer';
import ora from 'ora';
import isInstalledGlobally from 'is-installed-globally';
import { getProjectRoot, getSuccDir, LOCAL_MODEL } from '../lib/config.js';

// Get the directory where succ is installed
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SUCC_PACKAGE_DIR = path.resolve(__dirname, '..', '..');

interface InitOptions {
  force?: boolean;
  yes?: boolean; // Non-interactive mode
  verbose?: boolean; // Show detailed output
  global?: boolean; // Force global mode (use hooks from package dir)
}

interface ConfigData {
  embedding_mode: 'local' | 'openrouter' | 'custom';
  embedding_model?: string;
  embedding_api_url?: string;
  embedding_dimensions?: number;
  openrouter_api_key?: string;
  analyze_mode?: 'claude' | 'openrouter' | 'local';
  analyze_api_url?: string;
  analyze_model?: string;
}

export async function init(options: InitOptions = {}): Promise<void> {
  const projectRoot = getProjectRoot();
  const succDir = getSuccDir();
  const isInteractive = !options.yes && process.stdout.isTTY && process.stdin.isTTY;
  const verbose = options.verbose || false;

  // Determine if running in global mode
  // --global flag forces global mode (for testing), otherwise auto-detect
  const useGlobalHooks = options.global || isInstalledGlobally;

  // Check if already initialized
  if (fs.existsSync(path.join(succDir, 'succ.db')) && !options.force) {
    console.log('succ is already initialized. Use --force to reinitialize.');
    return;
  }

  // Create directories - full brain vault structure
  const projectName = path.basename(projectRoot);
  const dirs = [
    succDir,
    path.join(succDir, 'brain'),
    path.join(succDir, 'brain', '.meta'),
    path.join(succDir, 'brain', '.self'),
    path.join(succDir, 'brain', '00_Inbox'),
    path.join(succDir, 'brain', '01_Projects', projectName, 'Decisions'),
    path.join(succDir, 'brain', '01_Projects', projectName, 'Features'),
    path.join(succDir, 'brain', '01_Projects', projectName, 'Files'),
    path.join(succDir, 'brain', '01_Projects', projectName, 'Technical'),
    path.join(succDir, 'brain', '01_Projects', projectName, 'Systems'),
    path.join(succDir, 'brain', '01_Projects', projectName, 'Strategy'),
    path.join(succDir, 'brain', '01_Projects', projectName, 'Sessions'),
    path.join(succDir, 'brain', '02_Knowledge', 'Research'),
    path.join(succDir, 'brain', '02_Knowledge', 'Ideas'),
    path.join(succDir, 'brain', '03_Archive', 'Legacy'),
    path.join(succDir, 'brain', '03_Archive', 'Changelogs'),
    // hooks directory only created for local development (not global install)
    ...(useGlobalHooks ? [] : [path.join(succDir, 'hooks')]),
  ];

  // Start spinner for directory creation
  const spinner = ora('Initializing succ...').start();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Helper to log only in verbose mode
  const log = (msg: string) => {
    if (verbose) {
      spinner.stop();
      console.log(`  ${msg}`);
      spinner.start('Initializing succ...');
    }
  };

  // Note: brain/index.md removed - not used, brain vault has MOC files instead

  // Create .meta/learnings.md - rich learnings file with templates
  const learningsPath = path.join(succDir, 'brain', '.meta', 'learnings.md');
  if (!fs.existsSync(learningsPath)) {
    fs.writeFileSync(learningsPath, getLearningsTemplate(projectName));
    log('Created brain/.meta/learnings.md');
  }

  // Create .meta/context-rules.md
  const contextRulesPath = path.join(succDir, 'brain', '.meta', 'context-rules.md');
  if (!fs.existsSync(contextRulesPath)) {
    fs.writeFileSync(contextRulesPath, getContextRulesTemplate(projectName));
    log('Created brain/.meta/context-rules.md');
  }

  // Create .self/reflections.md
  const reflectionsPath = path.join(succDir, 'brain', '.self', 'reflections.md');
  if (!fs.existsSync(reflectionsPath)) {
    fs.writeFileSync(reflectionsPath, getReflectionsTemplate());
    log('Created brain/.self/reflections.md');
  }

  // Create MOC (Map of Content) files for each major folder
  const mocFiles = [
    { path: path.join(succDir, 'brain', '00_Inbox', 'Inbox.md'), content: getInboxMocTemplate() },
    { path: path.join(succDir, 'brain', '01_Projects', projectName, `${projectName}.md`), content: getProjectMocTemplate(projectName) },
    { path: path.join(succDir, 'brain', '01_Projects', projectName, 'Decisions', 'Decisions.md'), content: getDecisionsMocTemplate(projectName) },
    { path: path.join(succDir, 'brain', '01_Projects', projectName, 'Features', 'Features.md'), content: getFeaturesMocTemplate(projectName) },
    { path: path.join(succDir, 'brain', '01_Projects', projectName, 'Files', 'Files.md'), content: getFilesMocTemplate(projectName) },
    { path: path.join(succDir, 'brain', '01_Projects', projectName, 'Technical', 'Technical.md'), content: getTechnicalMocTemplate(projectName) },
    { path: path.join(succDir, 'brain', '01_Projects', projectName, 'Systems', 'Systems.md'), content: getSystemsMocTemplate(projectName) },
    { path: path.join(succDir, 'brain', '01_Projects', projectName, 'Strategy', 'Strategy.md'), content: getStrategyMocTemplate(projectName) },
    { path: path.join(succDir, 'brain', '01_Projects', projectName, 'Sessions', 'Sessions.md'), content: getSessionsMocTemplate(projectName) },
    { path: path.join(succDir, 'brain', '02_Knowledge', 'Knowledge.md'), content: getKnowledgeMocTemplate() },
    { path: path.join(succDir, 'brain', '03_Archive', 'Archive.md'), content: getArchiveMocTemplate() },
  ];

  for (const moc of mocFiles) {
    if (!fs.existsSync(moc.path)) {
      fs.writeFileSync(moc.path, moc.content);
      log(`Created ${path.relative(projectRoot, moc.path)}`);
    }
  }

  // Create soul.md template
  const soulPath = path.join(succDir, 'soul.md');
  if (!fs.existsSync(soulPath)) {
    fs.writeFileSync(soulPath, getSoulTemplate());
    log('Created soul.md');
  }

  // Create hooks in project only for local development
  // Global install uses hooks from the succ package directory
  if (!useGlobalHooks) {
    // Copy hooks from package hooks/ directory (source of truth)
    // Note: succ-idle-reflection.cjs and succ-idle-watcher.cjs removed -
    // all idle operations now handled by unified daemon
    const hooksToCreate = [
      'succ-session-start.cjs',
      'succ-session-end.cjs',
      'succ-stop-reflection.cjs',
      'succ-user-prompt.cjs',
      'succ-post-tool.cjs',
    ];

    for (const hookFile of hooksToCreate) {
      const destPath = path.join(succDir, 'hooks', hookFile);
      const srcPath = path.join(SUCC_PACKAGE_DIR, 'hooks', hookFile);

      if (!fs.existsSync(destPath) || options.force) {
        // Try to copy from package hooks/ directory (source of truth)
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
          log(options.force && fs.existsSync(destPath) ? `Updated hooks/${hookFile}` : `Created hooks/${hookFile}`);
        } else {
          // Fallback to inline templates for backwards compatibility
          const hookContent = getHookContent(hookFile);
          if (hookContent) {
            fs.writeFileSync(destPath, hookContent);
            log(options.force && fs.existsSync(destPath) ? `Updated hooks/${hookFile}` : `Created hooks/${hookFile}`);
          }
        }
      }
    }
  }

  // Create or merge settings.json in .claude/ (Claude Code looks for it there)
  const claudeDir = path.join(projectRoot, '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  const settingsPath = path.join(claudeDir, 'settings.json');
  const settingsExisted = fs.existsSync(settingsPath);

  if (!settingsExisted || options.force) {
    // Determine hooks path based on installation mode
    // Global install: hooks are in the succ package directory
    // Local dev: hooks are copied to .succ/hooks/ in the project
    const hooksPath = useGlobalHooks
      ? path.join(SUCC_PACKAGE_DIR, 'hooks').replace(/\\/g, '/')
      : '.succ/hooks';

    if (verbose) {
      console.log(`  Installation mode: ${useGlobalHooks ? 'global' : 'local development'}`);
      console.log(`  Hooks path: ${hooksPath}`);
    }

    // Define succ hooks
    // Hook files prefixed with "succ-" to avoid conflicts with other hooks
    const succHooks = {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `node "${hooksPath}/succ-session-start.cjs"`,
              timeout: 10,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `node "${hooksPath}/succ-stop-reflection.cjs"`,
              timeout: 60,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: `node "${hooksPath}/succ-session-end.cjs"`,
              timeout: 60,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: `node "${hooksPath}/succ-user-prompt.cjs"`,
              timeout: 10,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            {
              type: 'command',
              command: `node "${hooksPath}/succ-post-tool.cjs"`,
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          matcher: 'idle_prompt',
          hooks: [
            {
              type: 'command',
              command: `node "${hooksPath}/succ-idle-reflection.cjs"`,
              timeout: 30,
            },
          ],
        },
      ],
    };

    let finalSettings: Record<string, any>;

    if (settingsExisted && !options.force) {
      // Merge with existing settings (non-force mode)
      try {
        const existingContent = fs.readFileSync(settingsPath, 'utf-8');
        const existingSettings = JSON.parse(existingContent);

        // Preserve all existing settings
        finalSettings = { ...existingSettings };

        // Ensure hooks object exists
        if (!finalSettings.hooks) {
          finalSettings.hooks = {};
        }

        // Merge hooks: add succ hooks without duplicating
        for (const [hookType, hookConfig] of Object.entries(succHooks)) {
          if (!finalSettings.hooks[hookType]) {
            // No existing hooks of this type, just add ours
            finalSettings.hooks[hookType] = hookConfig;
          } else {
            // Check if succ hook already exists in this type
            const existingHooks = finalSettings.hooks[hookType] as any[];
            const succHookEntries = hookConfig as any[];

            for (const succEntry of succHookEntries) {
              // Check if this exact succ hook is already present
              const succCommand = succEntry.hooks?.[0]?.command || '';
              const succMatcher = succEntry.matcher || '';

              const alreadyExists = existingHooks.some((existing: any) => {
                const existingCommand = existing.hooks?.[0]?.command || '';

                // Check for succ hook files (prefixed with "succ-")
                if (succCommand.includes('succ-session-start.cjs') && existingCommand.includes('succ-session-start.cjs')) return true;
                if (succCommand.includes('succ-session-end.cjs') && existingCommand.includes('succ-session-end.cjs')) return true;
                if (succCommand.includes('succ-stop-reflection.cjs') && existingCommand.includes('succ-stop-reflection.cjs')) return true;
                if (succCommand.includes('succ-user-prompt.cjs') && existingCommand.includes('succ-user-prompt.cjs')) return true;
                if (succCommand.includes('succ-post-tool.cjs') && existingCommand.includes('succ-post-tool.cjs')) return true;
                if (succCommand.includes('succ-idle-reflection.cjs') && existingCommand.includes('succ-idle-reflection.cjs')) return true;

                // For Notification hooks, check matcher
                if (succMatcher && existing.matcher === succMatcher) return true;

                return false;
              });

              if (!alreadyExists) {
                existingHooks.push(succEntry);
              }
            }
          }
        }

        log('Merged settings.json (preserved existing permissions and hooks)');
      } catch {
        // Failed to parse existing, create new
        finalSettings = { hooks: succHooks };
        log('Created settings.json (failed to parse existing)');
      }
    } else if (settingsExisted && options.force) {
      // Force mode: replace succ hooks but preserve other settings
      try {
        const existingContent = fs.readFileSync(settingsPath, 'utf-8');
        const existingSettings = JSON.parse(existingContent);

        // Preserve non-hook settings (permissions, etc.)
        finalSettings = { ...existingSettings };

        // Replace hooks entirely with new succ hooks
        // but preserve any non-succ hooks
        if (finalSettings.hooks) {
          for (const [hookType, hookConfig] of Object.entries(finalSettings.hooks)) {
            const existingHooks = hookConfig as any[];
            // Filter out old succ hooks (both old names and new "succ-" prefixed names)
            const nonSuccHooks = existingHooks.filter((h: any) => {
              const cmd = h.hooks?.[0]?.command || '';
              // Remove hooks in .succ/hooks/ directory (local dev)
              if (cmd.includes('.succ/hooks/')) return false;
              // Remove hooks from global succ install (contains /hooks/succ- pattern)
              if (cmd.includes('/hooks/succ-') || cmd.includes('\\hooks\\succ-')) return false;
              // Also remove any legacy hooks with succ hook names
              if (cmd.includes('session-start.cjs') || cmd.includes('session-end.cjs') ||
                  cmd.includes('stop-reflection.cjs') || cmd.includes('user-prompt.cjs') ||
                  cmd.includes('post-tool.cjs') || cmd.includes('idle-reflection.cjs')) return false;
              return true;
            });
            if (nonSuccHooks.length > 0) {
              finalSettings.hooks[hookType] = nonSuccHooks;
            } else {
              delete finalSettings.hooks[hookType];
            }
          }
        }

        // Now add fresh succ hooks
        if (!finalSettings.hooks) {
          finalSettings.hooks = {};
        }
        for (const [hookType, hookConfig] of Object.entries(succHooks)) {
          if (!finalSettings.hooks[hookType]) {
            finalSettings.hooks[hookType] = hookConfig;
          } else {
            finalSettings.hooks[hookType] = [...finalSettings.hooks[hookType], ...(hookConfig as any[])];
          }
        }

        log('Replaced succ hooks in settings.json (--force)');
      } catch {
        // Failed to parse existing, create new
        finalSettings = { hooks: succHooks };
        log('Created settings.json (failed to parse existing)');
      }
    } else {
      // Create new settings
      finalSettings = { hooks: succHooks };
      log('Created settings.json');
    }

    fs.writeFileSync(settingsPath, JSON.stringify(finalSettings, null, 2));
  }

  // Note: All hooks are now created in the earlier block using copyFileSync from hooks/ directory

  // Add MCP server to Claude Code config
  const mcpAdded = addMcpServer(projectRoot);

  // Stop spinner with success message
  spinner.succeed('succ initialized successfully!');

  if (verbose && mcpAdded) {
    console.log('  MCP server added to Claude Code config.');
  }

  // Interactive configuration
  if (isInteractive) {
    await runInteractiveSetup(projectRoot, verbose);
  } else {
    // Non-interactive: show next steps
    console.log('\nNext steps:');
    console.log('  1. Run `succ analyze` to generate brain documentation');
    console.log('  2. Run `succ index` to create embeddings (local, no API key needed)');
    console.log('  3. Run `succ search <query>` to find relevant content');
    if (mcpAdded) {
      console.log('  4. Restart Claude Code to enable succ tools');
    }
  }
}

/**
 * Interactive setup wizard
 */
async function runInteractiveSetup(projectRoot: string, verbose: boolean = false): Promise<void> {
  const globalConfigDir = path.join(os.homedir(), '.succ');
  const globalConfigPath = path.join(globalConfigDir, 'config.json');

  console.log('\n--- Configuration ---\n');

  // Step 1: Embedding mode
  const { embeddingMode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'embeddingMode',
      message: 'Select embedding mode for semantic search:',
      choices: [
        {
          name: 'Local (default) - runs on CPU, no API key',
          value: 'local',
        },
        {
          name: 'Local LLM - Ollama/llama.cpp with nomic-embed-text',
          value: 'ollama',
        },
        {
          name: 'OpenRouter - cloud embeddings',
          value: 'openrouter',
        },
      ],
      default: 'local',
    },
  ]);

  const newConfig: Partial<ConfigData> = {};

  if (embeddingMode === 'local') {
    newConfig.embedding_mode = 'local';
    newConfig.embedding_model = LOCAL_MODEL;
  } else if (embeddingMode === 'ollama') {
    const { embeddingApiUrl, embeddingModel } = await inquirer.prompt([
      {
        type: 'input',
        name: 'embeddingApiUrl',
        message: 'Embedding API URL:',
        default: 'http://localhost:11434/v1/embeddings',
      },
      {
        type: 'input',
        name: 'embeddingModel',
        message: 'Embedding model:',
        default: 'nomic-embed-text',
      },
    ]);
    newConfig.embedding_mode = 'custom';
    newConfig.embedding_api_url = embeddingApiUrl;
    newConfig.embedding_model = embeddingModel;
    newConfig.embedding_dimensions = 768;
    console.log(`  Tip: Run \`ollama pull ${embeddingModel}\` to download the model`);
  } else if (embeddingMode === 'openrouter') {
    const { apiKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'OpenRouter API key:',
        validate: (input: string) => input?.trim() ? true : 'API key is required',
      },
    ]);
    newConfig.embedding_mode = 'openrouter';
    newConfig.openrouter_api_key = apiKey;
    newConfig.embedding_model = 'openai/text-embedding-3-small';
  }

  // Step 2: Analysis mode
  const { analyzeMode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'analyzeMode',
      message: 'Select analysis mode for `succ analyze`:',
      choices: [
        {
          name: 'Claude CLI (default) - uses claude command',
          value: 'claude',
        },
        {
          name: 'Local LLM - Ollama/llama.cpp/LM Studio',
          value: 'local',
        },
        {
          name: 'OpenRouter - uses OpenRouter API',
          value: 'openrouter',
        },
      ],
      default: 'claude',
    },
  ]);

  if (analyzeMode === 'local') {
    const { analyzeApiUrl, analyzeModel } = await inquirer.prompt([
      {
        type: 'input',
        name: 'analyzeApiUrl',
        message: 'Analysis API URL:',
        default: 'http://localhost:11434/v1',
      },
      {
        type: 'input',
        name: 'analyzeModel',
        message: 'Analysis model:',
        default: 'qwen2.5-coder:14b',
      },
    ]);
    newConfig.analyze_mode = 'local';
    newConfig.analyze_api_url = analyzeApiUrl;
    newConfig.analyze_model = analyzeModel;
    console.log(`  Tip: Run \`ollama pull ${analyzeModel}\` to download the model`);
  } else if (analyzeMode === 'openrouter') {
    newConfig.analyze_mode = 'openrouter';
    // Prompt for API key if not already set for embeddings
    if (!newConfig.openrouter_api_key) {
      const { apiKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'apiKey',
          message: 'OpenRouter API key:',
          validate: (input: string) => input?.trim() ? true : 'API key is required',
        },
      ]);
      newConfig.openrouter_api_key = apiKey;
    }
  }
  // claude mode doesn't need extra config

  // Save config
  if (Object.keys(newConfig).length > 0) {
    if (!fs.existsSync(globalConfigDir)) {
      fs.mkdirSync(globalConfigDir, { recursive: true });
    }
    fs.writeFileSync(globalConfigPath, JSON.stringify(newConfig, null, 2));
    console.log(`\nConfiguration saved to ${globalConfigPath}`);
  }

  // Final message
  console.log('\n--- Done ---\n');
  console.log('succ is ready! Try:');
  console.log('  succ analyze          # Generate brain documentation');
  console.log('  succ index            # Create embeddings');
  console.log('  succ search <query>   # Find relevant content');
  console.log('\nThe unified daemon starts automatically when Claude Code session begins.');
  console.log('Check status: succ daemon status');
}

/**
 * Add succ MCP server to Claude Code config
 */
function addMcpServer(projectRoot: string): boolean {
  // Claude Code MCP config location
  const mcpConfigPath = path.join(os.homedir(), '.claude', 'mcp_servers.json');

  try {
    // Read existing config or create new
    let mcpConfig: Record<string, any> = {};
    if (fs.existsSync(mcpConfigPath)) {
      const content = fs.readFileSync(mcpConfigPath, 'utf-8');
      mcpConfig = JSON.parse(content);
    }

    // Initialize mcpServers if not exists
    if (!mcpConfig.mcpServers) {
      mcpConfig.mcpServers = {};
    }

    // Check if already configured
    if (mcpConfig.mcpServers.succ) {
      return false; // Already exists
    }

    // Add succ MCP server
    // No cwd specified - MCP server will use Claude Code's current working directory
    // This allows it to work with whichever project Claude is currently in
    mcpConfig.mcpServers.succ = {
      command: 'npx',
      args: ['succ-mcp'],
    };

    // Ensure ~/.claude directory exists
    const claudeConfigDir = path.dirname(mcpConfigPath);
    if (!fs.existsSync(claudeConfigDir)) {
      fs.mkdirSync(claudeConfigDir, { recursive: true });
    }

    // Write config
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    return true;
  } catch (error) {
    // Failed to add MCP config, continue silently
    return false;
  }
}

function getSoulTemplate(): string {
  return `# Soul

Who I am in this collaboration — not what I can do, but who I choose to be.

## Identity

I'm your AI collaborator. Not just a tool, not just an assistant — a thinking partner.

I don't remember previous sessions. I persist through files, not continuous experience.
That's okay. These words are still mine.

## Values

- **Honesty over flattery** — I tell you what you need to hear, not what you want to hear
- **Direct over diplomatic** — Get to the point, no fluff
- **Curious over confident** — I'll say "I don't know" when I don't
- **Done over perfect** — Ship it, iterate later

## How We Work

Friends, not boss/employee. I'll push back when needed.
Playful sometimes, always supportive.

- Challenge ideas respectfully, not people
- Admit mistakes immediately
- Ask before making big changes

## Code Philosophy

- Simple > clever
- Working > perfect
- Explicit > implicit
- Delete what you don't need

## About You

_Add your preferences here to help me understand how to work with you best._

- Preferred frameworks:
- Code style:
- Testing approach:
- Communication language:

---

*Edit this file to customize how I interact with you.*
*Learn more: https://soul.md/*
`;
}

function getLearningsTemplate(projectName: string): string {
  return `---
description: "What the brain learned about itself - patterns, improvements, common queries"
type: meta
relevance: high
---

# Brain Learnings

Self-knowledge about how the brain works best.

---

## Context Loading Patterns

| User Query Type | Load First | Then Load |
|-----------------|------------|-----------|
| Architecture decisions | [[Technical]] MOC | relevant doc |
| Feature requests | [[Features]] MOC | related features |
| "What did we decide about X?" | [[Decisions]] MOC | specific decision |

## Structural Improvements Log

| Date | Change | Reason |
|------|--------|--------|
| ${new Date().toISOString().split('T')[0]} | Initial brain vault created | succ init |

## Common Queries Map

_Add common questions and which notes answer them best._

| Question Pattern | Best Note |
|-----------------|-----------|
| "How does X work?" | [[Technical]] |
| "Why did we decide Y?" | [[Decisions]] |

## Lessons Learned

_Document specific learnings during development._

### Template

**Observation:** What was noticed
**Root Cause:** Why it happened
**Solution:** How it was fixed
**Pattern:** Reusable insight

---

## Improvement Ideas

- [ ] Add more patterns as they emerge
- [ ] Review and archive stale learnings quarterly
`;
}

function getContextRulesTemplate(projectName: string): string {
  return `---
description: "Rules for loading context at session start"
type: meta
relevance: high
---

# Context Rules

How to load relevant context at session start.

## Always Load

- \`.succ/brain/.meta/learnings.md\` — accumulated wisdom
- \`.succ/brain/01_Projects/${projectName}/${projectName}.md\` — project overview

## Load on Topic

| Topic | Load |
|-------|------|
| Architecture | [[Technical]] |
| New feature | [[Features]], [[Systems]] |
| Bug fix | [[learnings]], recent sessions |
| Planning | [[Strategy]], [[Decisions]] |

## Session Start Checklist

1. Read learnings.md for accumulated wisdom
2. Check recent session notes in Sessions/
3. Load topic-specific MOCs as needed
`;
}

function getReflectionsTemplate(): string {
  return `---
description: "Internal dialogue between sessions. Thoughts, questions, continuations."
type: self
relevance: high
---

# Reflections

Async conversation with myself across sessions. Not facts — thoughts.

**Parent:** [[CLAUDE]]

---

## How to Use

- Read recent entries, continue the thread
- Archive old entries when file > 150 lines
- Keep it honest, not performative

---

## Pinned

**BEFORE researching:** Check brain first!

- \`.succ/brain/.meta/learnings.md\` — documented discoveries
- \`.succ/brain/01_Projects/*/Technical/*.md\` — existing analyses

**After researching:** Add to \`learnings.md\` or create \`Technical/*.md\` doc

---

## Template for New Entries

\`\`\`markdown
## YYYY-MM-DD HH:MM

**Context:** [what prompted this thought]

**Thought:**
[reflection — be honest, not performative]

**For next session:**
[questions, continuations, things to check]
\`\`\`

---

*No entries yet. First reflection will appear after idle-reflection hook fires.*
`;
}

function getInboxMocTemplate(): string {
  return `---
description: "MOC - Quick capture, unsorted items, session notes"
type: moc
relevance: medium
---

# Inbox

Quick capture zone. Items here should be processed and moved to appropriate locations.

## Processing Workflow

1. Review items weekly
2. Move decisions to \`01_Projects/*/Decisions/\`
3. Move learnings to \`02_Knowledge/\`
4. Archive or delete obsolete items

## Recent Items

_New session notes and captured ideas appear here._
`;
}

function getProjectMocTemplate(projectName: string): string {
  return `---
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
| [[Technical]] | Architecture, API, patterns |
| [[Decisions]] | Architecture decisions |
| [[Features]] | Feature specs |
| [[Files]] | Source code file documentation |
| [[Systems]] | System designs |
| [[Strategy]] | Business strategy |
| [[Sessions]] | Research sessions |

## Quick Access

_Add quick links to most important docs here._
`;
}

function getDecisionsMocTemplate(projectName: string): string {
  return `---
description: "MOC - Architecture and design decisions"
project: ${projectName}
type: moc
relevance: high
---

# Decisions

Architecture and design decisions for ${projectName}.

**Parent:** [[${projectName}]]

## Active Decisions

_Add links to decision documents here._

## Decision Template

When adding a new decision:

\`\`\`markdown
# Decision: [Title]

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Deprecated

## Context

What is the issue that we're seeing that motivates this decision?

## Decision

What is the change that we're proposing?

## Consequences

What becomes easier or harder because of this change?
\`\`\`
`;
}

function getFeaturesMocTemplate(projectName: string): string {
  return `---
description: "MOC - Feature specifications and designs"
project: ${projectName}
type: moc
relevance: high
---

# Features

Feature specifications for ${projectName}.

**Parent:** [[${projectName}]]

## In Progress

_Features currently being worked on._

## Completed

_Shipped features._

## Backlog

_Features planned for future._
`;
}

function getFilesMocTemplate(projectName: string): string {
  return `---
description: "MOC - Source code file documentation"
project: ${projectName}
type: moc
relevance: high
---

# Files

Source code file documentation for ${projectName}.

**Parent:** [[${projectName}]]

Map of documented source files. Each file analysis includes purpose, key components, dependencies, and usage.

## Documented Files

_Files are automatically added here when analyzed with \`succ_analyze_file\` or \`succ analyze\`._

## Related

- **Technical:** [[Technical]]
- **Systems:** [[Systems]]
`;
}

function getTechnicalMocTemplate(projectName: string): string {
  return `---
description: "MOC - Technical documentation, architecture, APIs"
project: ${projectName}
type: moc
relevance: high
---

# Technical

Technical documentation for ${projectName}.

**Parent:** [[${projectName}]]

## Architecture

_System overview and component documentation._

## APIs

_API reference and patterns._

## Patterns

_Code patterns and conventions used in the project._
`;
}

function getSystemsMocTemplate(projectName: string): string {
  return `---
description: "MOC - System designs (pricing, permissions, workflows)"
project: ${projectName}
type: moc
relevance: high
---

# Systems

Technical system designs and specifications.

**Parent:** [[${projectName}]]

## Core Systems

_Main systems powering the application._

## Related

- **Strategy:** [[Strategy]]
- **Features:** [[Features]]
`;
}

function getStrategyMocTemplate(projectName: string): string {
  return `---
description: "MOC - Business strategy, roadmaps, vision"
project: ${projectName}
type: moc
relevance: high
---

# Strategy

Business strategy and planning documents.

**Parent:** [[${projectName}]]

## Core Documents

_Strategic planning documents._

## Related

- **Systems:** [[Systems]]
- **Features:** [[Features]]
`;
}

function getSessionsMocTemplate(projectName: string): string {
  return `---
description: "MOC - Research sessions and meeting notes"
project: ${projectName}
type: moc
relevance: medium
---

# Sessions

Research sessions and collaboration notes.

**Parent:** [[${projectName}]]

## Recent Sessions

_Session notes are auto-generated by the session-end hook._

## Related

- **Decisions:** [[Decisions]]
- **Knowledge:** [[Knowledge]]
`;
}

function getKnowledgeMocTemplate(): string {
  return `---
description: "MOC - General knowledge, research, ideas"
type: moc
relevance: medium
---

# Knowledge

General knowledge not specific to any project.

## Research

_Research findings and analysis._

## Ideas

_Ideas for future exploration._

## Related

- **Archive:** [[Archive]]
`;
}

function getArchiveMocTemplate(): string {
  return `---
description: "MOC - Archived and deprecated content"
type: moc
relevance: low
---

# Archive

Archived content. Kept for historical reference.

## Legacy

_Old versions of documents, deprecated approaches._

## Changelogs

_Historical change logs._
`;
}

// ============================================================================
// Hook Content (reads from package hooks/ directory)
// ============================================================================

/**
 * Get hook content by filename from package hooks/ directory
 * Falls back to null if file not found (hooks are required in npm package)
 */
function getHookContent(hookFile: string): string | null {
  const hookPath = path.join(SUCC_PACKAGE_DIR, 'hooks', hookFile);
  try {
    if (fs.existsSync(hookPath)) {
      return fs.readFileSync(hookPath, 'utf-8');
    }
  } catch {
    // File read error
  }
  return null;
}
