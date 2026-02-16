import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { select, input, password } from '@inquirer/prompts';
import ora from 'ora';
import isInstalledGlobally from 'is-installed-globally';
import {
  getProjectRoot,
  getSuccDir,
  isOnboardingCompleted,
  markOnboardingCompleted,
} from '../lib/config.js';
import { runStaticWizard, runAiOnboarding } from '../lib/onboarding/index.js';
import { logWarn } from '../lib/fault-logger.js';
import {
  getSoulTemplate,
  getLearningsTemplate,
  getContextRulesTemplate,
  getReflectionsTemplate,
  getInboxMocTemplate,
  getProjectMocTemplate,
  getDecisionsMocTemplate,
  getFeaturesMocTemplate,
  getFilesMocTemplate,
  getTechnicalMocTemplate,
  getSystemsMocTemplate,
  getStrategyMocTemplate,
  getSessionsMocTemplate,
  getKnowledgeMocTemplate,
  getArchiveMocTemplate,
  getPrdMocTemplate,
  getCommunicationMocTemplate,
  getDecisionsMocRootTemplate,
} from './init-templates.js';

// Get the directory where succ is installed
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SUCC_PACKAGE_DIR = path.resolve(__dirname, '..', '..');

interface InitOptions {
  force?: boolean;
  yes?: boolean; // Non-interactive mode
  verbose?: boolean; // Show detailed output
  global?: boolean; // Force global mode (use hooks from package dir)
  ai?: boolean; // Use AI-powered onboarding instead of static wizard
}

interface ConfigData {
  llm?: {
    api_key?: string;
    api_url?: string;
    embeddings?: {
      mode?: 'local' | 'api';
      model?: string;
      api_url?: string;
      dimensions?: number;
    };
    analyze?: {
      mode?: 'claude' | 'api';
      model?: string;
      api_url?: string;
    };
  };
  daemon?: {
    enabled?: boolean;
    watch?: { auto_start?: boolean };
    analyze?: { auto_start?: boolean };
  };
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
    path.join(succDir, 'brain', '04_PRD'),
    path.join(succDir, 'brain', '05_Communication'),
    // lowercase without numeric prefix — cross-project decisions (vs per-project 01_Projects/<name>/Decisions/)
    path.join(succDir, 'brain', 'decisions'),
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
    {
      path: path.join(succDir, 'brain', '01_Projects', projectName, `${projectName}.md`),
      content: getProjectMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', '01_Projects', projectName, 'Decisions', 'Decisions.md'),
      content: getDecisionsMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', '01_Projects', projectName, 'Features', 'Features.md'),
      content: getFeaturesMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', '01_Projects', projectName, 'Files', 'Files.md'),
      content: getFilesMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', '01_Projects', projectName, 'Technical', 'Technical.md'),
      content: getTechnicalMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', '01_Projects', projectName, 'Systems', 'Systems.md'),
      content: getSystemsMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', '01_Projects', projectName, 'Strategy', 'Strategy.md'),
      content: getStrategyMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', '01_Projects', projectName, 'Sessions', 'Sessions.md'),
      content: getSessionsMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', '02_Knowledge', 'Knowledge.md'),
      content: getKnowledgeMocTemplate(),
    },
    {
      path: path.join(succDir, 'brain', '03_Archive', 'Archive.md'),
      content: getArchiveMocTemplate(),
    },
    {
      path: path.join(succDir, 'brain', '04_PRD', 'PRD.md'),
      content: getPrdMocTemplate(),
    },
    {
      path: path.join(succDir, 'brain', '05_Communication', 'Communication.md'),
      content: getCommunicationMocTemplate(),
    },
    {
      path: path.join(succDir, 'brain', 'decisions', 'Decisions.md'),
      content: getDecisionsMocRootTemplate(),
    },
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
      'succ-pre-tool.cjs',
    ];

    for (const hookFile of hooksToCreate) {
      const destPath = path.join(succDir, 'hooks', hookFile);
      const srcPath = path.join(SUCC_PACKAGE_DIR, 'hooks', hookFile);

      if (!fs.existsSync(destPath) || options.force) {
        // Try to copy from package hooks/ directory (source of truth)
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
          log(
            options.force && fs.existsSync(destPath)
              ? `Updated hooks/${hookFile}`
              : `Created hooks/${hookFile}`
          );
        } else {
          // Fallback to inline templates for backwards compatibility
          const hookContent = getHookContent(hookFile);
          if (hookContent) {
            fs.writeFileSync(destPath, hookContent);
            log(
              options.force && fs.existsSync(destPath)
                ? `Updated hooks/${hookFile}`
                : `Created hooks/${hookFile}`
            );
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

  // Copy succ agents to .claude/agents/ for Claude Code subagent support
  const agentsDir = path.join(claudeDir, 'agents');
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }

  // Agent files to install
  const agentFiles = [
    // Original agents
    'succ-memory-curator.md',
    'succ-knowledge-indexer.md',
    'succ-deep-search.md',
    'succ-checkpoint-manager.md',
    'succ-session-reviewer.md',
    // New agents
    'succ-session-handoff-orchestrator.md',
    'succ-memory-health-monitor.md',
    'succ-pattern-detective.md',
    'succ-readiness-improver.md',
    'succ-knowledge-mapper.md',
    'succ-quality-improvement-coach.md',
    'succ-decision-auditor.md',
    'succ-context-optimizer.md',
    'succ-explore.md',
    'succ-plan.md',
    'succ-code-reviewer.md',
    'succ-diff-reviewer.md',
    'succ-debug.md',
    'succ-style-tracker.md',
    'succ-general.md',
  ];

  for (const agentFile of agentFiles) {
    const destPath = path.join(agentsDir, agentFile);
    const srcPath = path.join(SUCC_PACKAGE_DIR, 'agents', agentFile);

    if (!fs.existsSync(destPath) || options.force) {
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        log(
          options.force && fs.existsSync(destPath)
            ? `Updated agents/${agentFile}`
            : `Created agents/${agentFile}`
        );
      }
    }
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
              command: `node --no-warnings --no-deprecation "${hooksPath}/succ-session-start.cjs"`,
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
              command: `node --no-warnings --no-deprecation "${hooksPath}/succ-stop-reflection.cjs"`,
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
              command: `node --no-warnings --no-deprecation "${hooksPath}/succ-session-end.cjs"`,
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
              command: `node --no-warnings --no-deprecation "${hooksPath}/succ-user-prompt.cjs"`,
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
              command: `node --no-warnings --no-deprecation "${hooksPath}/succ-post-tool.cjs"`,
              timeout: 5,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: `node --no-warnings --no-deprecation "${hooksPath}/succ-pre-tool.cjs"`,
              timeout: 10,
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
            type HookEntry = { hooks?: Array<{ command?: string }>; matcher?: string };
            const existingHooks = finalSettings.hooks[hookType] as HookEntry[];
            const succHookEntries = hookConfig as HookEntry[];

            for (const succEntry of succHookEntries) {
              // Check if this exact succ hook is already present
              const succCommand = succEntry.hooks?.[0]?.command || '';
              const succMatcher = succEntry.matcher || '';

              const alreadyExists = existingHooks.some((existing: any) => {
                const existingCommand = existing.hooks?.[0]?.command || '';

                // Check for succ hook files (prefixed with "succ-")
                if (
                  succCommand.includes('succ-session-start.cjs') &&
                  existingCommand.includes('succ-session-start.cjs')
                )
                  return true;
                if (
                  succCommand.includes('succ-session-end.cjs') &&
                  existingCommand.includes('succ-session-end.cjs')
                )
                  return true;
                if (
                  succCommand.includes('succ-stop-reflection.cjs') &&
                  existingCommand.includes('succ-stop-reflection.cjs')
                )
                  return true;
                if (
                  succCommand.includes('succ-user-prompt.cjs') &&
                  existingCommand.includes('succ-user-prompt.cjs')
                )
                  return true;
                if (
                  succCommand.includes('succ-post-tool.cjs') &&
                  existingCommand.includes('succ-post-tool.cjs')
                )
                  return true;
                if (
                  succCommand.includes('succ-pre-tool.cjs') &&
                  existingCommand.includes('succ-pre-tool.cjs')
                )
                  return true;
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
            type HookEntry = { hooks?: Array<{ command?: string }>; matcher?: string };
            const existingHooks = hookConfig as HookEntry[];
            // Filter out old succ hooks (both old names and new "succ-" prefixed names)
            const nonSuccHooks = existingHooks.filter((h: any) => {
              const cmd = h.hooks?.[0]?.command || '';
              // Remove hooks in .succ/hooks/ directory (local dev)
              if (cmd.includes('.succ/hooks/')) return false;
              // Remove hooks from global succ install (contains /hooks/succ- pattern)
              if (cmd.includes('/hooks/succ-') || cmd.includes('\\hooks\\succ-')) return false;
              // Also remove any legacy hooks with succ hook names
              if (
                cmd.includes('session-start.cjs') ||
                cmd.includes('session-end.cjs') ||
                cmd.includes('stop-reflection.cjs') ||
                cmd.includes('user-prompt.cjs') ||
                cmd.includes('post-tool.cjs') ||
                cmd.includes('pre-tool.cjs') ||
                cmd.includes('idle-reflection.cjs')
              )
                return false;
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
            type HookEntry = { hooks?: Array<{ command?: string }>; matcher?: string };
            finalSettings.hooks[hookType] = [
              ...finalSettings.hooks[hookType],
              ...(hookConfig as HookEntry[]),
            ];
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
  const mcpResult = addMcpServer(projectRoot);

  // Stop spinner with success message
  spinner.succeed('succ initialized successfully!');

  if (verbose && mcpResult === 'added') {
    console.log('  MCP server added to Claude Code config.');
  }

  // Interactive configuration
  if (isInteractive) {
    // Run onboarding for first-time users (before setup wizard)
    await runOnboarding(options.ai || false);
    await runInteractiveSetup(projectRoot, verbose);
  } else {
    // Non-interactive: show next steps
    console.log('\nNext steps:');
    console.log('  1. Run `succ analyze` to generate brain documentation');
    console.log('  2. Run `succ index` to create doc embeddings (local, no API key needed)');
    console.log('  3. Run `succ index-code` to index source code for semantic search');
    console.log('  4. Run `succ search <query>` to find relevant content');
    if (mcpResult === 'added') {
      console.log('  5. Restart Claude Code to enable succ tools');
    }
    console.log(
      '\n  Other editors: `succ setup cursor`, `succ setup windsurf`, `succ setup continue`'
    );
  }
}

/**
 * Run onboarding for first-time users
 * Checks if onboarding was already completed globally
 */
async function runOnboarding(useAi: boolean): Promise<void> {
  // Skip if already completed
  if (isOnboardingCompleted()) {
    return;
  }

  console.log('');
  console.log('  Welcome to succ!');
  console.log('');

  // Ask if user wants a tour
  const wantsTour = await select({
    message: 'Would you like a quick tour of succ?',
    choices: [
      {
        name: 'Yes, show me around (recommended)',
        value: 'yes',
        description: 'Learn what succ can do',
      },
      {
        name: 'Skip, just set up',
        value: 'skip',
        description: 'Go straight to configuration',
      },
    ],
    default: 'yes',
  });

  if (wantsTour === 'skip') {
    markOnboardingCompleted('skipped');
    console.log('\n  Skipped onboarding. You can learn more at https://succ.ai\n');
    return;
  }

  // Ask for onboarding style (unless --ai flag was used)
  let onboardingStyle: 'quick' | 'interactive' = 'quick';

  if (useAi) {
    onboardingStyle = 'interactive';
  } else {
    const styleChoice = await select({
      message: 'How would you like to learn?',
      choices: [
        {
          name: 'Quick walkthrough (~2 min)',
          value: 'quick',
          description: 'Static screens with key concepts',
        },
        {
          name: 'Interactive chat with AI (~3-5 min)',
          value: 'interactive',
          description: 'Personalized conversation about your project',
        },
      ],
      default: 'quick',
    });
    onboardingStyle = styleChoice as 'quick' | 'interactive';
  }

  // Run chosen onboarding
  if (onboardingStyle === 'interactive') {
    await runAiOnboarding();
  } else {
    await runStaticWizard();
  }
}

/**
 * Interactive setup wizard
 */
async function runInteractiveSetup(projectRoot: string, _verbose: boolean = false): Promise<void> {
  const globalConfigDir = path.join(os.homedir(), '.succ');
  const globalConfigPath = path.join(globalConfigDir, 'config.json');
  const projectConfigDir = path.join(projectRoot, '.succ');
  const projectConfigPath = path.join(projectConfigDir, 'config.json');

  const newGlobalConfig: Partial<ConfigData> = {};
  const newProjectConfig: Partial<ConfigData> = {};

  const projectName = path.basename(projectRoot);

  try {
    // Header
    console.log('');
    console.log('  \x1b[32m●\x1b[0m succ');
    console.log('');
    console.log('  Semantic Understanding for Code Contexts');
    console.log('  Claude Code · Cursor · Windsurf · Continue.dev');
    console.log('');
    console.log('  ─────────────────────────────────────────────────────────');
    console.log('');

    // Step 1: Config scope
    const configScope = await select({
      message: 'Where to save embedding/analyze settings?',
      choices: [
        {
          name: 'Global (~/.succ/config.json)',
          value: 'global',
          description: 'Shared across all projects',
        },
        {
          name: `Project (${projectName}/.succ/config.json)`,
          value: 'project',
          description: 'Only for this project',
        },
      ],
      default: 'global',
    });

    const targetConfig = configScope === 'global' ? newGlobalConfig : newProjectConfig;

    // Step 2: Embedding mode
    console.log('\n┌─────────────────────────────────────────────────────────┐');
    console.log('│  succ converts text to vectors (embeddings) for search. │');
    console.log('└─────────────────────────────────────────────────────────┘\n');
    const embeddingMode = await select({
      message: 'How should succ generate embeddings?',
      choices: [
        {
          name: 'Local CPU (recommended for most users)',
          value: 'local',
          description: 'Runs on your CPU, no API key needed',
        },
        {
          name: 'API (Ollama, LM Studio, OpenRouter, etc.)',
          value: 'api',
          description: 'Use any OpenAI-compatible embedding endpoint',
        },
      ],
      default: 'local',
    });

    if (!targetConfig.llm) targetConfig.llm = {};
    if (!targetConfig.llm.embeddings) targetConfig.llm.embeddings = {};

    if (embeddingMode === 'local') {
      targetConfig.llm.embeddings.mode = 'local';
      console.log('\n  ✓ Using local embeddings (no API key needed)');
      console.log('    Model: Xenova/all-MiniLM-L6-v2 (runs on CPU)\n');
    } else if (embeddingMode === 'api') {
      console.log('\n  API Embedding Configuration');
      console.log('  ─────────────────────────────');
      console.log('  Examples:');
      console.log('    Ollama:      http://localhost:11434/v1');
      console.log('    LM Studio:   http://localhost:1234/v1');
      console.log('    OpenRouter:   https://openrouter.ai/api/v1\n');

      const embeddingApiUrl = await input({
        message: 'API URL:',
        default: 'http://localhost:11434/v1',
      });
      const embeddingModel = await input({
        message: 'Model name:',
        default: 'nomic-embed-text',
      });
      const embeddingDimensionsStr = await input({
        message: 'Embedding dimensions:',
        default: '768',
      });
      const embeddingDimensions = parseInt(embeddingDimensionsStr, 10) || 768;

      targetConfig.llm.embeddings.mode = 'api';
      targetConfig.llm.embeddings.api_url = embeddingApiUrl;
      targetConfig.llm.embeddings.model = embeddingModel;
      targetConfig.llm.embeddings.dimensions = embeddingDimensions;

      // Prompt for API key if the URL looks like a cloud provider
      if (embeddingApiUrl.includes('openrouter.ai') || embeddingApiUrl.includes('openai.com')) {
        const apiKey = await password({
          message: 'API key:',
          mask: '*',
          validate: (val: string) => (val?.trim() ? true : 'API key is required'),
        });
        targetConfig.llm.api_key = apiKey;
      }

      console.log(`\n  ✓ Using API embeddings: ${embeddingApiUrl}`);
      console.log(`    Model: ${embeddingModel} (${embeddingDimensions}d)`);
      if (embeddingApiUrl.includes('11434')) {
        console.log(`\n  Tip: Run \`ollama pull ${embeddingModel}\` to download the model`);
      }
    }

    // Step 3: Analysis mode
    console.log('┌─────────────────────────────────────────────────────────┐');
    console.log('│  succ can analyze your codebase to generate docs.       │');
    console.log('│  Choose which LLM to use for `succ analyze`:            │');
    console.log('└─────────────────────────────────────────────────────────┘\n');

    const analyzeMode = await select({
      message: 'How should succ analyze your code?',
      choices: [
        {
          name: 'Claude CLI (recommended)',
          value: 'claude',
          description: 'Uses the `claude` command',
        },
        {
          name: 'API (Ollama, LM Studio, OpenRouter, etc.)',
          value: 'api',
          description: 'Use any OpenAI-compatible chat endpoint',
        },
      ],
      default: 'claude',
    });

    if (!targetConfig.llm.analyze) targetConfig.llm.analyze = {};

    if (analyzeMode === 'claude') {
      targetConfig.llm.analyze.mode = 'claude';
      console.log('\n  ✓ Using Claude CLI for analysis');
      console.log('    Make sure `claude` command is available\n');
    } else if (analyzeMode === 'api') {
      console.log('\n  API Configuration for Analysis');
      console.log('  ─────────────────────────────────');
      console.log('  Examples:');
      console.log('    Ollama:      http://localhost:11434/v1');
      console.log('    LM Studio:   http://localhost:1234/v1');
      console.log('    OpenRouter:   https://openrouter.ai/api/v1\n');

      const analyzeApiUrl = await input({
        message: 'API URL:',
        default: 'http://localhost:11434/v1',
      });
      const analyzeModel = await input({
        message: 'Model name:',
        default: 'qwen2.5-coder:14b',
      });

      targetConfig.llm.analyze.mode = 'api';
      targetConfig.llm.analyze.api_url = analyzeApiUrl;
      targetConfig.llm.analyze.model = analyzeModel;

      // Prompt for API key if cloud provider and not already set
      if (
        !targetConfig.llm.api_key &&
        (analyzeApiUrl.includes('openrouter.ai') || analyzeApiUrl.includes('openai.com'))
      ) {
        const apiKey = await password({
          message: 'API key:',
          mask: '*',
          validate: (val: string) => (val?.trim() ? true : 'API key is required'),
        });
        targetConfig.llm.api_key = apiKey;
      }

      console.log(`\n  ✓ Using API for analysis: ${analyzeApiUrl}`);
      console.log(`    Model: ${analyzeModel}`);
      if (analyzeApiUrl.includes('11434')) {
        console.log(`\n  Tip: Run \`ollama pull ${analyzeModel}\` to download the model`);
      }
    }

    // Step 4: Background services (always project-specific)
    console.log('┌─────────────────────────────────────────────────────────┐');
    console.log('│  succ can run background services during Claude sessions │');
    console.log('│  Watch: auto-index files when they change               │');
    console.log('│  Analyze: periodically discover new files               │');
    console.log('└─────────────────────────────────────────────────────────┘\n');

    const daemonMode = await select({
      message: 'Enable background services?',
      choices: [
        {
          name: 'None (manual only)',
          value: 'none',
          description: 'Run succ index/analyze manually when needed',
        },
        {
          name: 'Watch only',
          value: 'watch',
          description: 'Auto-index changed files in background',
        },
        {
          name: 'Both watch and analyze (recommended)',
          value: 'both',
          description: 'Full automation: watch + periodic discovery',
        },
      ],
      default: 'none',
    });

    // Initialize daemon config
    const daemonConfig: any = {
      enabled: true,
      watch: { auto_start: false },
      analyze: { auto_start: false },
    };

    if (daemonMode === 'watch' || daemonMode === 'both') {
      daemonConfig.watch.auto_start = true;
      console.log('\n  ✓ Watch service enabled (auto-index on file changes)');
    }

    if (daemonMode === 'both') {
      daemonConfig.analyze.auto_start = true;
      console.log('  ✓ Analyze service enabled (periodic discovery)');
    }

    if (daemonMode === 'none') {
      console.log('\n  ✓ Background services disabled');
      console.log('    Run `succ index` and `succ analyze` manually when needed');
    }

    // Save daemon config to target scope
    if (daemonMode !== 'none') {
      targetConfig.daemon = daemonConfig;
    }
    console.log('');

    // Save config to chosen scope
    if (configScope === 'global') {
      if (Object.keys(newGlobalConfig).length > 0) {
        if (!fs.existsSync(globalConfigDir)) {
          fs.mkdirSync(globalConfigDir, { recursive: true });
        }
        fs.writeFileSync(globalConfigPath, JSON.stringify(newGlobalConfig, null, 2));
        console.log(`  Saved: ${globalConfigPath}`);
      }
    } else {
      if (Object.keys(newProjectConfig).length > 0) {
        if (!fs.existsSync(projectConfigDir)) {
          fs.mkdirSync(projectConfigDir, { recursive: true });
        }
        fs.writeFileSync(projectConfigPath, JSON.stringify(newProjectConfig, null, 2));
        console.log(`  Saved: ${projectConfigPath}`);
      }
    }

    // Final message
    console.log('\n┌─────────────────────────────────────────────────────────┐');
    console.log('│                    Setup Complete!                      │');
    console.log('└─────────────────────────────────────────────────────────┘\n');
    console.log('  Next steps:\n');
    console.log('    1. succ analyze          Generate brain documentation');
    console.log('    2. succ index            Create doc embeddings for search');
    console.log('    3. succ index-code       Index source code for semantic search');
    console.log('    4. succ search <query>   Find relevant content\n');
    console.log('  The daemon starts automatically with Claude Code sessions.');
    console.log('  Other editors: succ setup cursor | windsurf | continue');
    console.log('  Check status anytime: succ daemon status\n');
  } catch (error: any) {
    // Handle Ctrl+C gracefully
    if (error?.name === 'ExitPromptError' || error?.message?.includes('closed')) {
      console.log('\n\n  Setup cancelled.\n');
      process.exit(0);
    }
    throw error;
  }
}

/**
 * Add succ MCP server to Claude Code config
 *
 * Claude Code stores MCP servers in ~/.claude.json under the root "mcpServers" key
 * for global scope (works everywhere including remote sessions via Happy).
 *
 * The old ~/.claude/mcp_servers.json format is deprecated.
 */
function addMcpServer(_projectRoot: string): 'added' | 'exists' | 'failed' {
  // Claude Code main config location
  const claudeConfigPath = path.join(os.homedir(), '.claude.json');

  try {
    // Read existing config or create new
    let claudeConfig: Record<string, any> = {};
    if (fs.existsSync(claudeConfigPath)) {
      const content = fs.readFileSync(claudeConfigPath, 'utf-8');
      claudeConfig = JSON.parse(content);
    }

    // Initialize mcpServers at root level if not exists
    if (!claudeConfig.mcpServers) {
      claudeConfig.mcpServers = {};
    }

    // Check if already configured
    if (claudeConfig.mcpServers.succ) {
      return 'exists';
    }

    // Add succ MCP server to global scope
    // No cwd specified - MCP server will use Claude Code's current working directory
    // This allows it to work with whichever project Claude is currently in
    // Windows: npx is a .cmd script, needs cmd /c wrapper for spawn
    claudeConfig.mcpServers.succ =
      process.platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'npx', '--yes', 'succ-mcp'] }
        : { command: 'npx', args: ['--yes', 'succ-mcp'] };

    // Write config
    fs.writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2));
    return 'added';
  } catch (error: any) {
    logWarn('init', `Failed to add MCP server to ${claudeConfigPath}`, { error: String(error) });
    console.warn(`  Warning: Failed to add MCP server to ${claudeConfigPath}: ${error.message}`);
    logWarn('init', 'You can add it manually: succ init --force');
    console.warn('  You can add it manually: succ init --force');
    return 'failed';
  }
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
