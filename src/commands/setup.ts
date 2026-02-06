import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

interface EditorConfig {
  name: string;
  /** Config file paths per platform */
  configPaths: Record<string, string>;
  /** Config format: 'object' = { mcpServers: { name: config } }, 'array' = { mcpServers: [{ name, ...config }] } */
  format: 'object' | 'array';
  /** Detection: directory that indicates the editor is installed */
  detectPaths: Record<string, string[]>;
}

const EDITOR_CONFIGS: Record<string, EditorConfig> = {
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

function getSuccMcpCommand(): { command: string; args: string[] } {
  // Check if succ-mcp is available globally
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmd, ['succ-mcp'], { stdio: 'pipe' });
    return { command: 'succ-mcp', args: [] };
  } catch {
    // Fall back to npx
    return { command: 'npx', args: ['--yes', 'succ-mcp'] };
  }
}

function isEditorDetected(editor: EditorConfig): boolean {
  const platform = process.platform;
  const paths = editor.detectPaths[platform] || editor.detectPaths.linux;
  return paths.some(p => fs.existsSync(p));
}

function hasExistingSuccConfig(configPath: string, format: 'object' | 'array'): boolean {
  if (!fs.existsSync(configPath)) return false;
  try {
    const content = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (format === 'object') {
      return !!content?.mcpServers?.succ;
    }
    // array format
    const servers = content?.mcpServers;
    if (!Array.isArray(servers)) return false;
    return servers.some((s: any) => s.name === 'succ');
  } catch {
    return false;
  }
}

function configureEditor(editorKey: string, editor: EditorConfig): boolean {
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
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      // Corrupted file — start fresh
    }
  }

  if (editor.format === 'object') {
    // Object format: { mcpServers: { succ: { command, args } } }
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers.succ = {
      command: mcpConfig.command,
      args: mcpConfig.args,
    };
  } else {
    // Array format: { mcpServers: [{ name: "succ", command, args }] }
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
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
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
        configureEditor(key, editor);
        console.log(`  ${editor.name}: configured (${configPath})`);
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
    configureEditor(editorKey, editor);
    console.log('Configuration updated.');
  } else {
    configureEditor(editorKey, editor);
    console.log(`${editor.name} configured successfully!`);
    console.log(`Config: ${configPath}`);
  }
  console.log('\nRestart your editor to activate succ MCP tools.');
}
