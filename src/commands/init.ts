import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { select, input, password } from '@inquirer/prompts';
import ora from 'ora';
import isInstalledGlobally from 'is-installed-globally';
import {
  getProjectRoot,
  getSuccDir,
  getConfig,
  isOnboardingCompleted,
  markOnboardingCompleted,
} from '../lib/config.js';
import { runStaticWizard, runAiOnboarding } from '../lib/onboarding/index.js';
import { logWarn } from '../lib/fault-logger.js';
import { syncClaudeSettings } from '../lib/undercover.js';
import {
  getSoulTemplate,
  getLearningsTemplate,
  getContextRulesTemplate,
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
} from './init-templates.js';
import { getStablePort } from '../lib/daemon-port.js';

// Get the directory where succ is installed
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SUCC_PACKAGE_DIR = path.resolve(__dirname, '..', '..');

/** Check if a URL points to a known cloud LLM provider */
function isCloudProvider(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname === 'openrouter.ai' ||
      hostname.endsWith('.openrouter.ai') ||
      hostname === 'openai.com' ||
      hostname.endsWith('.openai.com')
    );
  } catch (e) {
    logWarn('init', 'Invalid URL provided during cloud provider check', {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/** Detect Claude Code CLI version. Returns null if not installed. */
function getClaudeCodeVersion(): string | null {
  try {
    const stdout = execFileSync('claude', ['--version'], {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch (e) {
    logWarn('init', 'Claude Code CLI not found or version detection failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Check if version supports HTTP hooks (v2.1.63+) */
function supportsHttpHooks(version: string | null): boolean {
  if (!version) return false;
  const parts = version.split('.').map(Number);
  if (parts.length < 3) return false;
  const [major, minor, patch] = parts;
  if (major > 2) return true;
  if (major === 2 && minor > 1) return true;
  if (major === 2 && minor === 1 && patch >= 63) return true;
  return false;
}

/** Check if a hook entry belongs to succ (command or HTTP) */
function isSuccHook(h: Record<string, unknown>): boolean {
  const hooks = h.hooks as Array<Record<string, unknown>> | undefined;
  if (!hooks || hooks.length === 0) return false;
  const hook = hooks[0];
  const cmd = (hook.command as string) || '';
  const url = (hook.url as string) || '';
  // Command hooks (current)
  if (
    cmd.includes('.succ/hooks/') ||
    cmd.includes('/hooks/succ-') ||
    cmd.includes('\\hooks\\succ-')
  )
    return true;
  if (/succ-(session|stop|user|post|pre)-/.test(cmd)) return true;
  // Legacy hooks (.claude/hooks/session-start.cjs, idle-reflection.cjs, etc.)
  // Use explicit whitelist to avoid misclassifying user hooks starting with session- or idle-
  const legacyHookNames = new Set(['session-start.cjs', 'idle-reflection.cjs', 'idle-watcher.cjs']);
  if (cmd.includes('.claude') && cmd.includes('hooks')) {
    const basename = path.basename(cmd);
    if (legacyHookNames.has(basename)) return true;
  }
  // HTTP hooks
  if (url.includes('/api/hooks/')) return true;
  return false;
}

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

  // Create directories - flat brain vault structure (no numbered prefixes)
  const projectName = path.basename(projectRoot);
  const dirs = [
    succDir,
    path.join(succDir, 'brain'),
    path.join(succDir, 'brain', '.meta'),
    path.join(succDir, 'brain', 'inbox'),
    path.join(succDir, 'brain', 'project', 'decisions'),
    path.join(succDir, 'brain', 'project', 'features'),
    path.join(succDir, 'brain', 'project', 'files'),
    path.join(succDir, 'brain', 'project', 'technical'),
    path.join(succDir, 'brain', 'project', 'systems'),
    path.join(succDir, 'brain', 'project', 'strategy'),
    path.join(succDir, 'brain', 'project', 'sessions'),
    path.join(succDir, 'brain', 'knowledge'),
    path.join(succDir, 'brain', 'archive'),
    path.join(succDir, 'brain', 'prd'),
    path.join(succDir, 'brain', 'communication'),
    path.join(succDir, 'brain', 'reflections'),
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

  // Create MOC (Map of Content) files for each major folder
  const mocFiles = [
    { path: path.join(succDir, 'brain', 'inbox', 'Inbox.md'), content: getInboxMocTemplate() },
    {
      path: path.join(succDir, 'brain', 'project', `${projectName}.md`),
      content: getProjectMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', 'project', 'decisions', 'Decisions.md'),
      content: getDecisionsMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', 'project', 'features', 'Features.md'),
      content: getFeaturesMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', 'project', 'files', 'Files.md'),
      content: getFilesMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', 'project', 'technical', 'Technical.md'),
      content: getTechnicalMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', 'project', 'systems', 'Systems.md'),
      content: getSystemsMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', 'project', 'strategy', 'Strategy.md'),
      content: getStrategyMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', 'project', 'sessions', 'Sessions.md'),
      content: getSessionsMocTemplate(projectName),
    },
    {
      path: path.join(succDir, 'brain', 'knowledge', 'Knowledge.md'),
      content: getKnowledgeMocTemplate(),
    },
    {
      path: path.join(succDir, 'brain', 'archive', 'Archive.md'),
      content: getArchiveMocTemplate(),
    },
    {
      path: path.join(succDir, 'brain', 'prd', 'PRD.md'),
      content: getPrdMocTemplate(),
    },
    {
      path: path.join(succDir, 'brain', 'communication', 'Communication.md'),
      content: getCommunicationMocTemplate(),
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
      'succ-pre-compact.cjs',
      'succ-permission.cjs',
      'succ-subagent-stop.cjs',
      'succ-task-completed.cjs',
      'succ-worktree-remove.cjs',
    ];

    for (const hookFile of hooksToCreate) {
      const destPath = path.join(succDir, 'hooks', hookFile);
      const srcPath = path.join(SUCC_PACKAGE_DIR, 'hooks', hookFile);
      const existed = fs.existsSync(destPath);

      // Always overwrite hook scripts so re-running `succ init` keeps them
      // at the version shipped with the current package. This is intentional:
      // hooks are generated files, not user-editable.
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        log(existed ? `Updated hooks/${hookFile}` : `Created hooks/${hookFile}`);
      } else {
        // Fallback to inline templates for backwards compatibility
        if (!existed || options.force) {
          const hookContent = getHookContent(hookFile);
          if (hookContent) {
            fs.writeFileSync(destPath, hookContent);
            log(existed ? `Updated hooks/${hookFile}` : `Created hooks/${hookFile}`);
          }
        }
      }
    }

    // Copy hooks/core/ shared modules (adapter, daemon-boot)
    // Always overwrite so re-runs stay in sync with the installed package.
    const coreSrcDir = path.join(SUCC_PACKAGE_DIR, 'hooks', 'core');
    const coreDestDir = path.join(succDir, 'hooks', 'core');
    if (fs.existsSync(coreSrcDir)) {
      if (!fs.existsSync(coreDestDir)) {
        fs.mkdirSync(coreDestDir, { recursive: true });
      }
      const coreFiles = fs.readdirSync(coreSrcDir).filter((f) => f.endsWith('.cjs'));
      for (const coreFile of coreFiles) {
        const dest = path.join(coreDestDir, coreFile);
        const existed = fs.existsSync(dest);
        fs.copyFileSync(path.join(coreSrcDir, coreFile), dest);
        log(existed ? `Updated hooks/core/${coreFile}` : `Created hooks/core/${coreFile}`);
      }
    }
  }

  // Write package root so hooks/daemon can find dist/ even when copied to .succ/
  const pkgRootFile = path.join(succDir, '.package-root');
  const pkgRootValue = SUCC_PACKAGE_DIR;

  // Safely read existing .package-root with proper error handling
  let existingPkgRoot: string | null = null;
  if (fs.existsSync(pkgRootFile)) {
    try {
      const stats = fs.statSync(pkgRootFile);
      if (stats.isFile()) {
        existingPkgRoot = fs.readFileSync(pkgRootFile, 'utf8').trim();
      }
    } catch (error) {
      // Log error but continue gracefully - we'll just recreate the file
      if (verbose) {
        log(
          `Warning: Failed to read .package-root: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  if (existingPkgRoot !== pkgRootValue) {
    fs.mkdirSync(path.dirname(pkgRootFile), { recursive: true });
    fs.writeFileSync(pkgRootFile, pkgRootValue);
    log(existingPkgRoot ? 'Updated .package-root' : 'Created .package-root');
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

  {
    // Always install/update hooks and settings so re-running `succ init` on an existing
    // project updates hooks to the latest version. The merge logic inside preserves
    // existing permissions and any non-succ hooks.
    // Determine hooks path based on installation mode
    // Use $CLAUDE_PROJECT_DIR for portability (works regardless of cwd)
    const hooksPath = useGlobalHooks
      ? path.join(SUCC_PACKAGE_DIR, 'hooks').replace(/\\/g, '/')
      : '$CLAUDE_PROJECT_DIR/.succ/hooks';

    // Detect Claude Code version for HTTP hooks support
    const claudeVersion = getClaudeCodeVersion();
    const useHttp = supportsHttpHooks(claudeVersion);

    // Compute stable port for HTTP hook URLs (getConfig merges global + project config)
    const mergedConfig = getConfig();
    const hookPort = mergedConfig.daemon?.port ?? getStablePort(projectRoot);
    const baseUrl = `http://127.0.0.1:${hookPort}/api/hooks`;

    if (verbose) {
      console.log(`  Installation mode: ${useGlobalHooks ? 'global' : 'local development'}`);
      console.log(`  Hooks path: ${hooksPath}`);
      console.log(`  Claude Code version: ${claudeVersion || 'not detected'}`);
      console.log(`  HTTP hooks: ${useHttp ? 'yes' : 'no (command fallback)'}`);
      console.log(`  Hook port: ${hookPort}`);
    }

    // Helper to build a command hook entry
    const cmdHook = (script: string, timeout: number, statusMsg: string) => ({
      type: 'command' as const,
      command: `node --no-warnings --no-deprecation "${hooksPath}/${script}"`,
      timeout,
      statusMessage: statusMsg,
    });

    // Helper to build an HTTP hook entry
    const httpHook = (route: string, timeout: number, statusMsg: string) => ({
      type: 'http' as const,
      url: `${baseUrl}/${route}`,
      timeout,
      statusMessage: statusMsg,
    });

    // Define succ hooks — HTTP when supported, command fallback
    const succHooks: Record<string, Array<Record<string, unknown>>> = {
      // Command-only events (Claude Code limitation)
      SessionStart: [
        {
          hooks: [cmdHook('succ-session-start.cjs', 10, 'succ: loading context...')],
        },
      ],
      SessionEnd: [
        {
          hooks: [cmdHook('succ-session-end.cjs', 60, 'succ: saving session...')],
        },
      ],

      // HTTP when supported, command fallback
      Stop: [
        {
          hooks: [
            useHttp
              ? httpHook('stop', 10, 'succ: recording activity...')
              : cmdHook('succ-stop-reflection.cjs', 10, 'succ: recording activity...'),
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            useHttp
              ? httpHook('user-prompt', 10, 'succ: checking context...')
              : cmdHook('succ-user-prompt.cjs', 10, 'succ: checking context...'),
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            useHttp
              ? httpHook('post-tool', 5, 'succ: capturing...')
              : cmdHook('succ-post-tool.cjs', 5, 'succ: capturing...'),
          ],
        },
      ],
      PreToolUse: [
        {
          hooks: [
            useHttp
              ? httpHook('pre-tool', 10, 'succ: checking rules...')
              : cmdHook('succ-pre-tool.cjs', 10, 'succ: checking rules...'),
          ],
        },
      ],

      // PreCompact — command-only (Claude Code limitation)
      PreCompact: [
        {
          hooks: [cmdHook('succ-pre-compact.cjs', 5, 'succ: analyzing session...')],
        },
      ],

      // New hooks (HTTP when supported, command fallback)
      PermissionRequest: [
        {
          hooks: [
            useHttp
              ? httpHook('permission', 5, 'succ: checking permission rules...')
              : cmdHook('succ-permission.cjs', 5, 'succ: checking permission rules...'),
          ],
        },
      ],
      SubagentStop: [
        {
          hooks: [
            useHttp
              ? httpHook('subagent-stop', 5, 'succ: saving agent results...')
              : cmdHook('succ-subagent-stop.cjs', 5, 'succ: saving agent results...'),
          ],
        },
      ],
      TaskCompleted: [
        {
          hooks: [
            useHttp
              ? httpHook('task-completed', 5, 'succ: consolidating...')
              : cmdHook('succ-task-completed.cjs', 5, 'succ: consolidating...'),
          ],
        },
      ],

      // WorktreeRemove — unlink junctions before Claude Code cleans up worktrees
      WorktreeRemove: [
        { hooks: [cmdHook('succ-worktree-remove.cjs', 5, 'succ: cleaning up junctions...')] },
      ],
    };

    let finalSettings: Record<string, any>;

    // Unified merge logic: strip old succ hooks (command + HTTP), add fresh ones.
    // Works for both merge and force modes — always upgrades hook transport.
    const stripAndAddSuccHooks = (existingSettings: Record<string, any>): Record<string, any> => {
      const settings = { ...existingSettings };
      if (!settings.hooks) settings.hooks = {};

      // Strip all existing succ hooks from every event type
      for (const [hookType, hookConfig] of Object.entries(settings.hooks)) {
        if (!Array.isArray(hookConfig)) continue;
        const nonSucc = hookConfig.filter((h: Record<string, unknown>) => !isSuccHook(h));
        if (nonSucc.length > 0) {
          settings.hooks[hookType] = nonSucc;
        } else {
          delete settings.hooks[hookType];
        }
      }

      // Add fresh succ hooks
      for (const [hookType, hookConfig] of Object.entries(succHooks)) {
        const entries = hookConfig as Array<Record<string, unknown>>;
        if (entries.length === 0) continue;
        if (!settings.hooks[hookType]) {
          settings.hooks[hookType] = entries;
        } else {
          settings.hooks[hookType] = [...settings.hooks[hookType], ...entries];
        }
      }

      return settings;
    };

    if (settingsExisted) {
      try {
        const existingContent = fs.readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(existingContent);
        // Guard against valid JSON that isn't a plain object (null, array, primitive).
        // Spreading a non-object would silently discard the value or throw at runtime.
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error(
            `settings.json contains ${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`} — expected a plain object`
          );
        }
        const existingSettings = parsed as Record<string, unknown>;
        finalSettings = stripAndAddSuccHooks(existingSettings);
        log(
          options.force
            ? 'Replaced succ hooks in settings.json (--force)'
            : 'Merged settings.json (preserved existing permissions and hooks)'
        );
      } catch (error) {
        logWarn('init', 'Failed to parse existing Claude settings.json for hook merge', {
          error: error instanceof Error ? error.message : String(error),
        });
        finalSettings = { hooks: succHooks };
        log('Created settings.json (failed to parse existing)');
      }
    } else {
      finalSettings = { hooks: succHooks };
      log('Created settings.json');
    }

    fs.writeFileSync(settingsPath, JSON.stringify(finalSettings, null, 2));
  }

  // Sync Claude settings for undercover mode (after settings.json write)
  // Enable: writes suppression values to settings.local.json
  // Disable: restores original values from snapshot
  try {
    const mergedConfig = getConfig();
    syncClaudeSettings(projectRoot, mergedConfig.undercover === true);
  } catch (err) {
    logWarn(
      'init',
      `Undercover settings sync failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Check if already initialized (after hooks/settings so re-runs always refresh them)
  if (fs.existsSync(path.join(succDir, 'succ.db')) && !options.force) {
    // Always reconcile MCP server config even if DB exists — ensures older installs
    // or previous failures get the Claude entry added.
    addMcpServer(projectRoot);
    spinner.succeed('succ hooks/settings refreshed (already initialized).');
    return;
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
  let onboardingStyle: 'quick' | 'interactive';

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

    // When user chose global scope, warn if project config already contains LLM overrides.
    // Project-level llm keys take precedence over global, so stale entries can shadow the
    // new global settings the wizard is about to write.
    if (configScope === 'global' && fs.existsSync(projectConfigPath)) {
      try {
        const existingProjectCfg = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
        if (existingProjectCfg?.llm && Object.keys(existingProjectCfg.llm).length > 0) {
          console.log(
            '\n  \x1b[33mNote:\x1b[0m Your project config (.succ/config.json) has existing LLM'
          );
          console.log('  settings that will override the global config for this project.');
          console.log('  Remove the `llm` key from .succ/config.json to use global settings.\n');
        }
      } catch (e) {
        logWarn('init', 'Failed to parse project config while checking LLM overrides', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

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
      if (isCloudProvider(embeddingApiUrl)) {
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
      if (!targetConfig.llm.api_key && isCloudProvider(analyzeApiUrl)) {
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

    // Daemon settings are always written to the project config, never global.
    // Background-service toggles are per-project: writing them to the global
    // config would bleed across unrelated projects.
    // When daemonMode is 'none', explicitly write a disabled block so that
    // mergeAndWriteConfig's additive deep merge does not leave behind any
    // pre-existing daemon.enabled / auto_start values set to true.
    newProjectConfig.daemon =
      daemonMode === 'none'
        ? { enabled: false, watch: { auto_start: false }, analyze: { auto_start: false } }
        : daemonConfig;
    console.log('');

    // Save config to chosen scope — merge with existing to avoid overwriting
    // user-configured fields (storage backend, Qdrant, custom settings, etc.)
    const mergeAndWriteConfig = (
      configPath: string,
      configDir: string,
      newConfig: Partial<ConfigData>
    ) => {
      if (Object.keys(newConfig).length === 0) return;
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      let existing: Record<string, any> = {};
      if (fs.existsSync(configPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
            existing = raw;
          } else {
            logWarn('init', `${configPath} is not a plain object — treating as empty`, {});
          }
        } catch (e) {
          logWarn('init', `Failed to parse existing ${configPath}, will overwrite`, {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      // Deep merge: wizard keys override, but preserve keys not covered by wizard
      const merged = { ...existing };
      for (const [key, value] of Object.entries(newConfig)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          merged[key] = { ...(existing[key] ?? {}), ...value };
          // One level deeper for nested objects (llm.embeddings, llm.analyze, daemon.watch, etc.)
          for (const [subKey, subValue] of Object.entries(value as Record<string, any>)) {
            if (typeof subValue === 'object' && subValue !== null && !Array.isArray(subValue)) {
              merged[key][subKey] = { ...(existing[key]?.[subKey] ?? {}), ...subValue };
            }
          }
        } else {
          merged[key] = value;
        }
      }
      fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
      const isNew = Object.keys(existing).length === 0;
      console.log(`  ${isNew ? 'Created' : 'Merged into'}: ${configPath}`);
    };

    if (configScope === 'global') {
      mergeAndWriteConfig(globalConfigPath, globalConfigDir, newGlobalConfig);
    }
    // Always write project config — daemon settings are project-scoped even when
    // embedding/analyze settings are global. mergeAndWriteConfig is a no-op when
    // newProjectConfig is empty so this is safe for pure global setups.
    mergeAndWriteConfig(projectConfigPath, projectConfigDir, newProjectConfig);

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
  } catch (error) {
    // Handle Ctrl+C gracefully
    if (
      error instanceof Error &&
      (error.name === 'ExitPromptError' || error.message?.includes('closed'))
    ) {
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
  } catch (error) {
    logWarn('init', `Failed to add MCP server to ${claudeConfigPath}`, { error: String(error) });
    console.warn(
      `  Warning: Failed to add MCP server to ${claudeConfigPath}: ${error instanceof Error ? error.message : String(error)}`
    );
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
  } catch (error) {
    logWarn('init', 'Failed to read hook file from package directory', {
      error: error instanceof Error ? error.message : String(error),
    });
    // File read error
  }
  return null;
}
