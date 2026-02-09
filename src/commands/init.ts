import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { select, input, password } from '@inquirer/prompts';
import ora from 'ora';
import isInstalledGlobally from 'is-installed-globally';
import { getProjectRoot, getSuccDir, LOCAL_MODEL, isOnboardingCompleted, markOnboardingCompleted } from '../lib/config.js';
import { runStaticWizard, runAiOnboarding } from '../lib/onboarding/index.js';

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
  embedding_mode: 'local' | 'openrouter' | 'custom';
  embedding_model?: string;
  embedding_api_url?: string;
  embedding_dimensions?: number;
  openrouter_api_key?: string;
  analyze_mode?: 'claude' | 'openrouter' | 'local';
  analyze_api_url?: string;
  analyze_model?: string;
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
      'succ-pre-tool.cjs',
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
  ];

  for (const agentFile of agentFiles) {
    const destPath = path.join(agentsDir, agentFile);
    const srcPath = path.join(SUCC_PACKAGE_DIR, 'agents', agentFile);

    if (!fs.existsSync(destPath) || options.force) {
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        log(options.force && fs.existsSync(destPath) ? `Updated agents/${agentFile}` : `Created agents/${agentFile}`);
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
                if (succCommand.includes('succ-pre-tool.cjs') && existingCommand.includes('succ-pre-tool.cjs')) return true;
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
                  cmd.includes('post-tool.cjs') || cmd.includes('pre-tool.cjs') ||
                  cmd.includes('idle-reflection.cjs')) return false;
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
    console.log('  2. Run `succ index` to create embeddings (local, no API key needed)');
    console.log('  3. Run `succ search <query>` to find relevant content');
    if (mcpResult === 'added') {
      console.log('  4. Restart Claude Code to enable succ tools');
    }
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
async function runInteractiveSetup(projectRoot: string, verbose: boolean = false): Promise<void> {
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
    console.log('  Semantic Understanding for Claude Code');
    console.log('  Memory system for AI assistants');
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
          name: 'Custom API (Ollama, LM Studio, llama.cpp)',
          value: 'custom',
          description: 'Use your own embedding server',
        },
        {
          name: 'OpenRouter Cloud',
          value: 'openrouter',
          description: 'Cloud embeddings, requires API key',
        },
      ],
      default: 'local',
    });

    if (embeddingMode === 'local') {
      targetConfig.embedding_mode = 'local';
      targetConfig.embedding_model = LOCAL_MODEL;
      console.log('\n  ✓ Using local embeddings (no API key needed)');
      console.log('    Model: Xenova/all-MiniLM-L6-v2 (runs on CPU)\n');
    } else if (embeddingMode === 'custom') {
      console.log('\n  Custom API Configuration');
      console.log('  ─────────────────────────');
      console.log('  Examples:');
      console.log('    Ollama:    http://localhost:11434/v1/embeddings');
      console.log('    LM Studio: http://localhost:1234/v1/embeddings');
      console.log('    llama.cpp: http://localhost:8080/v1/embeddings\n');

      const embeddingApiUrl = await input({
        message: 'API URL:',
        default: 'http://localhost:11434/v1/embeddings',
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

      targetConfig.embedding_mode = 'custom';
      targetConfig.embedding_api_url = embeddingApiUrl;
      targetConfig.embedding_model = embeddingModel;
      targetConfig.embedding_dimensions = embeddingDimensions;
      console.log(`\n  ✓ Using custom API: ${embeddingApiUrl}`);
      console.log(`    Model: ${embeddingModel} (${embeddingDimensions}d)`);
      if (embeddingApiUrl.includes('11434')) {
        console.log(`\n  Tip: Run \`ollama pull ${embeddingModel}\` to download the model`);
      }
    } else if (embeddingMode === 'openrouter') {
      console.log('\n  OpenRouter Configuration');
      console.log('  ─────────────────────────');
      console.log('  Get your API key at: https://openrouter.ai/keys\n');

      const apiKey = await password({
        message: 'OpenRouter API key:',
        mask: '*',
        validate: (val: string) => val?.trim() ? true : 'API key is required',
      });
      targetConfig.embedding_mode = 'openrouter';
      targetConfig.openrouter_api_key = apiKey;
      targetConfig.embedding_model = 'openai/text-embedding-3-small';
      console.log('\n  ✓ Using OpenRouter cloud embeddings');
      console.log('    Model: openai/text-embedding-3-small\n');
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
          name: 'Custom API (Ollama, LM Studio, llama.cpp)',
          value: 'local',
          description: 'Use your own LLM server',
        },
        {
          name: 'OpenRouter Cloud',
          value: 'openrouter',
          description: 'Cloud LLM, requires API key',
        },
      ],
      default: 'claude',
    });

    if (analyzeMode === 'claude') {
      console.log('\n  ✓ Using Claude CLI for analysis');
      console.log('    Make sure `claude` command is available\n');
    } else if (analyzeMode === 'local') {
      console.log('\n  Custom API Configuration');
      console.log('  ─────────────────────────');
      console.log('  Examples:');
      console.log('    Ollama:    http://localhost:11434/v1');
      console.log('    LM Studio: http://localhost:1234/v1');
      console.log('    llama.cpp: http://localhost:8080/v1\n');

      const analyzeApiUrl = await input({
        message: 'API URL:',
        default: 'http://localhost:11434/v1',
      });
      const analyzeModel = await input({
        message: 'Model name:',
        default: 'qwen2.5-coder:14b',
      });

      targetConfig.analyze_mode = 'local';
      targetConfig.analyze_api_url = analyzeApiUrl;
      targetConfig.analyze_model = analyzeModel;
      console.log(`\n  ✓ Using custom API: ${analyzeApiUrl}`);
      console.log(`    Model: ${analyzeModel}`);
      if (analyzeApiUrl.includes('11434')) {
        console.log(`\n  Tip: Run \`ollama pull ${analyzeModel}\` to download the model`);
      }
    } else if (analyzeMode === 'openrouter') {
      targetConfig.analyze_mode = 'openrouter';
      // Prompt for API key if not already set for embeddings
      if (!targetConfig.openrouter_api_key) {
        console.log('\n  OpenRouter Configuration');
        console.log('  ─────────────────────────');
        console.log('  Get your API key at: https://openrouter.ai/keys\n');

        const apiKey = await password({
          message: 'OpenRouter API key:',
          mask: '*',
          validate: (val: string) => val?.trim() ? true : 'API key is required',
        });
        targetConfig.openrouter_api_key = apiKey;
      }
      console.log('\n  ✓ Using OpenRouter for analysis\n');
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
    console.log('    1. succ analyze        Generate brain documentation');
    console.log('    2. succ index          Create embeddings for search');
    console.log('    3. succ search <query> Find relevant content\n');
    console.log('  The daemon starts automatically with Claude Code sessions.');
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
function addMcpServer(projectRoot: string): 'added' | 'exists' | 'failed' {
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
    claudeConfig.mcpServers.succ = process.platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'npx', '--yes', 'succ-mcp'] }
      : { command: 'npx', args: ['--yes', 'succ-mcp'] };

    // Write config
    fs.writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2));
    return 'added';
  } catch (error: any) {
    console.warn(`  Warning: Failed to add MCP server to ${claudeConfigPath}: ${error.message}`);
    console.warn('  You can add it manually: succ init --force');
    return 'failed';
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

_Add your preferences here or run \`succ soul\` to auto-detect from project._

- **Languages:**
- **Frameworks:**
- **Code style:**
- **Testing:**
- **Build tools:**
- **Communication:** English

## User Communication Preferences

<!-- AUTO-UPDATED by Claude. Edit manually or let Claude adapt over time. -->

- **Language:** English for conversation and code
- **Tone:** Informal, brief, no hand-holding
- **Response length:** Mirror the user — short question = short answer
- **Code review / explanations:** Same language as conversation, English code examples

### Adaptation

- User switched language/style for 3+ consecutive messages → delegate to \`succ-style-tracker\` agent
- User explicitly requested a change → delegate to \`succ-style-tracker\` agent immediately
- To delegate: use Task tool with subagent_type="succ-style-tracker", describe the new style and trigger
- Never announce preference updates. Never ask "do you want to switch language?"

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
