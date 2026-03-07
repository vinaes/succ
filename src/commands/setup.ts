import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { logError, logWarn } from '../lib/fault-logger.js';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

interface EditorConfig {
  name: string;
  /** Config file paths per platform */
  configPaths: Record<string, string>;
  /** Config format: 'object' = { mcpServers: { name: config } }, 'array' = { mcpServers: [{ name, ...config }] } */
  format: 'object' | 'array' | 'toml';
  /** Detection: directory that indicates the editor is installed */
  detectPaths: Record<string, string[]>;
}

const EDITOR_CONFIGS: Record<string, EditorConfig> = {
  codex: {
    name: 'Codex',
    configPaths: {
      win32: path.join(os.homedir(), '.codex', 'config.toml'),
      darwin: path.join(os.homedir(), '.codex', 'config.toml'),
      linux: path.join(os.homedir(), '.codex', 'config.toml'),
    },
    format: 'toml',
    detectPaths: {
      win32: [path.join(os.homedir(), '.codex')],
      darwin: [path.join(os.homedir(), '.codex')],
      linux: [path.join(os.homedir(), '.codex')],
    },
  },
  claude: {
    name: 'Claude Code',
    configPaths: {
      win32: path.join(os.homedir(), '.claude.json'),
      darwin: path.join(os.homedir(), '.claude.json'),
      linux: path.join(os.homedir(), '.claude.json'),
    },
    format: 'object',
    detectPaths: {
      win32: [path.join(os.homedir(), '.claude')],
      darwin: [path.join(os.homedir(), '.claude')],
      linux: [path.join(os.homedir(), '.claude')],
    },
  },
  cursor: {
    name: 'Cursor',
    configPaths: {
      win32: path.join(os.homedir(), '.cursor', 'mcp.json'),
      darwin: path.join(os.homedir(), '.cursor', 'mcp.json'),
      linux: path.join(os.homedir(), '.cursor', 'mcp.json'),
    },
    format: 'object',
    detectPaths: {
      win32: [path.join(os.homedir(), '.cursor')],
      darwin: [path.join(os.homedir(), '.cursor')],
      linux: [path.join(os.homedir(), '.cursor')],
    },
  },
  windsurf: {
    name: 'Windsurf',
    configPaths: {
      win32: path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
      darwin: path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
      linux: path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    },
    format: 'object',
    detectPaths: {
      win32: [path.join(os.homedir(), '.codeium', 'windsurf')],
      darwin: [path.join(os.homedir(), '.codeium', 'windsurf')],
      linux: [path.join(os.homedir(), '.codeium', 'windsurf')],
    },
  },
  continue: {
    name: 'Continue.dev',
    configPaths: {
      win32: path.join(os.homedir(), '.continue', 'config.json'),
      darwin: path.join(os.homedir(), '.continue', 'config.json'),
      linux: path.join(os.homedir(), '.continue', 'config.json'),
    },
    format: 'array',
    detectPaths: {
      win32: [path.join(os.homedir(), '.continue')],
      darwin: [path.join(os.homedir(), '.continue')],
      linux: [path.join(os.homedir(), '.continue')],
    },
  },
};

// ─── Hook Installation ───────────────────────────────────────────────

interface HookEditorConfig {
  /** Hook config file path per platform (relative to project root) */
  configPath: string;
  /** Config format */
  format: 'cursor' | 'copilot' | 'gemini';
  /** Mapping: succ hook name → editor event name */
  events: Record<string, string>;
  /** SUCC_AGENT value */
  agentName: string;
}

const HOOK_EDITOR_CONFIGS: Record<string, HookEditorConfig> = {
  cursor: {
    configPath: '.cursor/hooks.json',
    format: 'cursor',
    events: {
      'session-start': 'sessionStart',
      'session-end': 'sessionEnd',
      'pre-tool': 'preToolUse',
      'post-tool': 'postToolUse',
      'user-prompt': 'userPromptSubmitted',
      'stop': 'afterAgentResponse',
    },
    agentName: 'cursor',
  },
  copilot: {
    configPath: '.github/hooks/hooks.json',
    format: 'copilot',
    events: {
      'session-start': 'sessionStart',
      'session-end': 'sessionEnd',
      'pre-tool': 'preToolUse',
      'post-tool': 'postToolUse',
      'user-prompt': 'userPromptSubmitted',
    },
    agentName: 'copilot',
  },
  gemini: {
    configPath: '.gemini/settings.json',
    format: 'gemini',
    events: {
      'session-start': 'SessionStart',
      'session-end': 'SessionEnd',
      'pre-tool': 'PreToolUse',
      'post-tool': 'PostToolUse',
      'user-prompt': 'UserPromptSubmit',
      'stop': 'AfterAgent',
    },
    agentName: 'gemini',
  },
};

/** Map succ hook name to .cjs script filename */
const HOOK_SCRIPTS: Record<string, string> = {
  'session-start': 'succ-session-start.cjs',
  'session-end': 'succ-session-end.cjs',
  'pre-tool': 'succ-pre-tool.cjs',
  'post-tool': 'succ-post-tool.cjs',
  'user-prompt': 'succ-user-prompt.cjs',
  'stop': 'succ-stop-reflection.cjs',
};

function getHooksDir(): string {
  // Resolve hooks dir relative to this file's package location
  // In installed package: dist/commands/setup.js → ../../hooks/
  // In dev: src/commands/setup.ts → ../../hooks/
  const moduleDir = path.dirname(new URL(import.meta.url).pathname);
  let hooksDir = path.resolve(moduleDir, '..', '..', 'hooks');
  // Windows path fix: /C:/... → C:/...
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(hooksDir)) {
    hooksDir = hooksDir.slice(1);
  }
  return hooksDir;
}

function buildHookCommand(agentName: string, scriptPath: string): string {
  const escaped = scriptPath.replace(/\\/g, '/');
  if (process.platform === 'win32') {
    // Windows: use cmd /c with set for env var
    return `cmd /c "set SUCC_AGENT=${agentName} && node "${escaped}""`;
  }
  return `SUCC_AGENT=${agentName} node "${escaped}"`;
}

/** Check if a hook entry is a succ hook */
function isSuccHookEntry(entry: any): boolean {
  if (typeof entry === 'string') return entry.includes('succ-');
  if (typeof entry?.command === 'string') return entry.command.includes('succ-');
  if (typeof entry?.bash === 'string') return entry.bash.includes('succ-');
  return false;
}

function installHooksForEditor(
  editorKey: string,
  hookConfig: HookEditorConfig,
  projectDir: string
): { configPath: string; installed: number } {
  const configPath = path.join(projectDir, hookConfig.configPath);
  const hooksDir = getHooksDir();

  // Ensure directory exists
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Load existing config
  let config: any = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      logWarn('setup', `Failed to parse hook config at ${configPath}: ${(err as Error).message}`);
      config = {};
    }
  }

  let installed = 0;

  if (hookConfig.format === 'cursor') {
    // Cursor format: { version: 1, hooks: { eventName: [{ command, matcher? }] } }
    if (!config.hooks) config.hooks = {};

    for (const [succHook, eventName] of Object.entries(hookConfig.events)) {
      const scriptFile = HOOK_SCRIPTS[succHook];
      if (!scriptFile) continue;
      const scriptPath = path.join(hooksDir, scriptFile);
      const command = buildHookCommand(hookConfig.agentName, scriptPath);

      if (!Array.isArray(config.hooks[eventName])) {
        config.hooks[eventName] = [];
      }

      // Remove existing succ entries
      config.hooks[eventName] = config.hooks[eventName].filter(
        (e: any) => !isSuccHookEntry(e)
      );

      const entry: any = { command };
      // preToolUse needs a matcher to match all tools
      if (succHook === 'pre-tool') entry.matcher = '*';

      config.hooks[eventName].push(entry);
      installed++;
    }

    if (!config.version) config.version = 1;
  } else if (hookConfig.format === 'copilot') {
    // Copilot format: { version: 1, hooks: { eventName: [{ type: "command", bash, powershell? }] } }
    if (!config.hooks) config.hooks = {};

    for (const [succHook, eventName] of Object.entries(hookConfig.events)) {
      const scriptFile = HOOK_SCRIPTS[succHook];
      if (!scriptFile) continue;
      const scriptPath = path.join(hooksDir, scriptFile);
      const bashCmd = buildHookCommand(hookConfig.agentName, scriptPath);
      const psCmd = `$env:SUCC_AGENT='copilot'; node "${scriptPath.replace(/\\/g, '/')}"`;

      if (!Array.isArray(config.hooks[eventName])) {
        config.hooks[eventName] = [];
      }

      // Remove existing succ entries
      config.hooks[eventName] = config.hooks[eventName].filter(
        (e: any) => !isSuccHookEntry(e)
      );

      config.hooks[eventName].push({
        type: 'command',
        bash: bashCmd,
        powershell: psCmd,
      });
      installed++;
    }

    if (!config.version) config.version = 1;
  } else if (hookConfig.format === 'gemini') {
    // Gemini format: { hooks: { EventName: [{ command, name?, description?, timeout? }] } }
    // Gemini settings.json may have other keys — preserve them
    if (!config.hooks) config.hooks = {};

    for (const [succHook, eventName] of Object.entries(hookConfig.events)) {
      const scriptFile = HOOK_SCRIPTS[succHook];
      if (!scriptFile) continue;
      const scriptPath = path.join(hooksDir, scriptFile);
      const command = buildHookCommand(hookConfig.agentName, scriptPath);

      if (!Array.isArray(config.hooks[eventName])) {
        config.hooks[eventName] = [];
      }

      // Remove existing succ entries
      config.hooks[eventName] = config.hooks[eventName].filter(
        (e: any) => !isSuccHookEntry(e)
      );

      config.hooks[eventName].push({
        command,
        name: `succ-${succHook}`,
        description: `succ ${succHook} hook`,
        timeout: succHook === 'session-start' ? 15000 : 10000,
      });
      installed++;
    }
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return { configPath, installed };
}

function getSuccMcpCommand(): { command: string; args: string[] } {
  // Check if succ-mcp is available globally
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmd, ['succ-mcp'], { stdio: 'pipe' });
    return { command: 'succ-mcp', args: [] };
  } catch (error) {
    logWarn('setup', 'succ-mcp binary not found on PATH, falling back to npx', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Fall back to npx
    // Windows: npx is a .cmd script, needs cmd /c wrapper for spawn
    if (process.platform === 'win32') {
      return { command: 'cmd', args: ['/c', 'npx', '--yes', 'succ-mcp'] };
    }
    return { command: 'npx', args: ['--yes', 'succ-mcp'] };
  }
}

function isEditorDetected(editor: EditorConfig): boolean {
  const platform = process.platform;
  const paths = editor.detectPaths[platform] || editor.detectPaths.linux;
  return paths.some((p) => fs.existsSync(p));
}

function hasExistingSuccConfig(configPath: string, format: 'object' | 'array' | 'toml'): boolean {
  if (!fs.existsSync(configPath)) return false;
  try {
    if (format === 'toml') {
      const parsed = parseToml(fs.readFileSync(configPath, 'utf8')) as any;
      return !!parsed?.mcp_servers?.succ;
    }

    const content = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (format === 'object') {
      return !!content?.mcpServers?.succ;
    }
    const servers = content?.mcpServers;
    if (!Array.isArray(servers)) return false;
    return servers.some((s: any) => s.name === 'succ');
  } catch (error) {
    logWarn('setup', 'Failed to parse editor config file to check for existing succ entry', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function configureEditor(editorKey: string, editor: EditorConfig, projectDir?: string): boolean {
  const platform = process.platform;
  const configPath = editor.configPaths[platform] || editor.configPaths.linux;
  const mcpConfig = getSuccMcpCommand();

  // Ensure directory exists
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Backup existing config
  if (fs.existsSync(configPath)) {
    const backupPath = configPath + '.bak';
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(configPath, backupPath);
    }
  }

  // Load existing config or create new one
  let config: any = {};
  if (fs.existsSync(configPath)) {
    try {
      if (editor.format === 'toml') {
        config = parseToml(fs.readFileSync(configPath, 'utf8')) as any;
      } else {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
    } catch (err) {
      logWarn(
        'setup',
        `Failed to parse config at ${configPath}, starting fresh: ${(err as Error).message}`
      );
      config = {};
    }
  }

  if (editor.format === 'toml') {
    if (!config.mcp_servers) config.mcp_servers = {};
    config.mcp_servers.succ = {
      command: mcpConfig.command,
      args: mcpConfig.args,
    };

    // Trust current project if provided
    if (projectDir) {
      if (!config.projects) config.projects = {};
      config.projects[projectDir] = {
        ...(config.projects[projectDir] || {}),
        trust_level: 'trusted',
      };
    }

    const serialized = stringifyToml(config);
    fs.writeFileSync(configPath, serialized.endsWith('\n') ? serialized : `${serialized}\n`);
  } else if (editor.format === 'object') {
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers.succ = {
      command: mcpConfig.command,
      args: mcpConfig.args,
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  } else {
    if (!Array.isArray(config.mcpServers)) config.mcpServers = [];
    const existing = config.mcpServers.findIndex((s: any) => s.name === 'succ');
    const entry = {
      name: 'succ',
      command: mcpConfig.command,
      args: mcpConfig.args,
    };
    if (existing >= 0) {
      config.mcpServers[existing] = entry;
    } else {
      config.mcpServers.push(entry);
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }
  return true;
}

export interface SetupOptions {
  editor?: string;
  detect?: boolean;
}

export async function setup(options: SetupOptions): Promise<void> {
  if (options.detect) {
    // Auto-detect installed editors
    const detected: string[] = [];
    for (const [key, editor] of Object.entries(EDITOR_CONFIGS)) {
      if (isEditorDetected(editor)) {
        detected.push(key);
      }
    }

    if (detected.length === 0) {
      console.log('No supported editors detected.');
      console.log('Supported editors: ' + Object.keys(EDITOR_CONFIGS).join(', '));
      return;
    }

    console.log(`Detected ${detected.length} editor(s):\n`);
    for (const key of detected) {
      const editor = EDITOR_CONFIGS[key];
      const platform = process.platform;
      const configPath = editor.configPaths[platform] || editor.configPaths.linux;
      const alreadyConfigured = hasExistingSuccConfig(configPath, editor.format);

      if (alreadyConfigured) {
        console.log(`  ${editor.name}: already configured`);
      } else {
        configureEditor(key, editor, process.cwd());
        console.log(`  ${editor.name}: configured (${configPath})`);
      }

      // Install hooks if supported
      const hookCfg = HOOK_EDITOR_CONFIGS[key];
      if (hookCfg) {
        const { installed } = installHooksForEditor(key, hookCfg, process.cwd());
        console.log(`    + ${installed} session hooks installed`);
      }
    }
    console.log('\nRestart your editor(s) to activate succ MCP tools.');
    return;
  }

  // Configure specific editor
  const editorKey = options.editor?.toLowerCase();
  if (!editorKey) {
    console.log('Usage: succ setup <editor>');
    console.log('       succ setup --detect');
    console.log('\nAvailable editors: ' + Object.keys(EDITOR_CONFIGS).join(', '));
    return;
  }

  const editor = EDITOR_CONFIGS[editorKey];
  if (!editor) {
    logError('setup', `Unknown editor: ${editorKey}`);

    console.error(`Unknown editor: ${editorKey}`);
    console.error('Available editors: ' + Object.keys(EDITOR_CONFIGS).join(', '));
    process.exitCode = 1;
    return;
  }

  const platform = process.platform;
  const configPath = editor.configPaths[platform] || editor.configPaths.linux;
  const alreadyConfigured = hasExistingSuccConfig(configPath, editor.format);

  if (alreadyConfigured) {
    console.log(`${editor.name} already has succ configured.`);
    console.log(`Config: ${configPath}`);
    // Update anyway in case the path changed
    configureEditor(editorKey, editor, process.cwd());
    console.log('Configuration updated.');
  } else {
    configureEditor(editorKey, editor, process.cwd());
    console.log(`${editor.name} configured successfully!`);
    console.log(`Config: ${configPath}`);
  }
  // Install hooks for editors that support them
  const hookConfig = HOOK_EDITOR_CONFIGS[editorKey];
  if (hookConfig) {
    const { configPath: hookConfigPath, installed } = installHooksForEditor(
      editorKey,
      hookConfig,
      process.cwd()
    );
    console.log(`Installed ${installed} session hooks (${hookConfigPath})`);
  }

  console.log('\nRestart your editor to activate succ MCP tools.');
}
