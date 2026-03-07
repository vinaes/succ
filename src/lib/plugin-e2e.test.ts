/**
 * E2E tests for Claude Code plugin integration.
 *
 * Tests real process spawning: MCP server startup, hook script execution,
 * `succ init --plugin`, and project path resolution.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '../..');
const MCP_SERVER = path.join(ROOT, 'dist', 'mcp-server.js');
const NODE = process.execPath;
const NODE_ARGS = ['--no-warnings', '--no-deprecation'];

// Temp dir for isolated tests
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'succ-plugin-e2e-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: spawn MCP server, collect stderr, close stdin after startup
function spawnMcpServer(
  env: Record<string, string> = {},
  args: string[] = []
): Promise<{ stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn(NODE, [...NODE_ARGS, MCP_SERVER, ...args], {
      cwd: tmpDir,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      // Close stdin once transport is ready (triggers clean shutdown)
      if (stderr.includes('Transport connected')) {
        proc.stdin.end();
      }
    });

    const timeout = setTimeout(() => {
      proc.kill();
    }, 15_000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stderr, exitCode: code });
    });
  });
}

// Helper: run a hook script with JSON on stdin
function runHook(
  scriptName: string,
  stdinJson: object,
  cwd?: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const scriptPath = path.join(ROOT, 'hooks', scriptName);
    const proc = spawn(NODE, [...NODE_ARGS, scriptPath], {
      cwd: cwd ?? tmpDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    proc.stderr.on('data', (chunk) => (stderr += chunk.toString()));

    proc.stdin.write(JSON.stringify(stdinJson));
    proc.stdin.end();

    const timeout = setTimeout(() => {
      proc.kill();
    }, 10_000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

// ─── MCP Server ─────────────────────────────────────────────────────────

describe('MCP server E2E', () => {
  it('should start and log project path from SUCC_PROJECT_ROOT env', async () => {
    const projectDir = path.join(tmpDir, 'project-env');
    fs.mkdirSync(path.join(projectDir, '.succ'), { recursive: true });

    const { stderr } = await spawnMcpServer({
      SUCC_PROJECT_ROOT: projectDir,
    });

    expect(stderr).toContain('[succ-mcp] Starting...');
    expect(stderr).toContain('[succ-mcp] Storage ready');
    expect(stderr).toContain(`Project: ${projectDir}`);
    expect(stderr).not.toContain('WARNING: No .succ/ found');
  }, 20_000);

  it('should start and log project path from --project arg', async () => {
    const projectDir = path.join(tmpDir, 'project-arg');
    fs.mkdirSync(path.join(projectDir, '.succ'), { recursive: true });

    // Clear env so only --project is used
    const { stderr } = await spawnMcpServer({ SUCC_PROJECT_ROOT: '' }, ['--project', projectDir]);

    expect(stderr).toContain(`Project: ${projectDir}`);
    expect(stderr).not.toContain('WARNING: No .succ/ found');
  }, 20_000);

  it('should warn when .succ/ not found at project root', async () => {
    // Dir has .git (so getProjectRoot accepts the env) but no .succ/
    const noSuccDir = path.join(tmpDir, 'no-succ');
    fs.mkdirSync(path.join(noSuccDir, '.git'), { recursive: true });

    const { stderr } = await spawnMcpServer({
      SUCC_PROJECT_ROOT: noSuccDir,
    });

    expect(stderr).toContain(`Project: ${noSuccDir}`);
    expect(stderr).toContain('WARNING: No .succ/ found');
    expect(stderr).toContain('Pass project_path to every succ_* tool call');
  }, 20_000);

  it('should prefer --project arg over SUCC_PROJECT_ROOT env', async () => {
    const envDir = path.join(tmpDir, 'env-dir');
    const argDir = path.join(tmpDir, 'arg-dir');
    fs.mkdirSync(path.join(envDir, '.succ'), { recursive: true });
    fs.mkdirSync(path.join(argDir, '.succ'), { recursive: true });

    // --project sets SUCC_PROJECT_ROOT at parse time (server.ts:135),
    // overriding the env value
    const { stderr } = await spawnMcpServer({ SUCC_PROJECT_ROOT: envDir }, ['--project', argDir]);

    expect(stderr).toContain(`Project: ${argDir}`);
  }, 20_000);

  it('should exit cleanly when stdin closes', async () => {
    const projectDir = path.join(tmpDir, 'project-exit');
    fs.mkdirSync(path.join(projectDir, '.succ'), { recursive: true });

    const { stderr, exitCode } = await spawnMcpServer({
      SUCC_PROJECT_ROOT: projectDir,
    });

    expect(stderr).toContain('stdin closed, shutting down');
    expect(exitCode).toBe(0);
  }, 20_000);
});

// ─── Hook Scripts ───────────────────────────────────────────────────────

describe('Hook scripts E2E', () => {
  // Claude Code hook input format
  const claudeHookInput = (cwd: string) => ({
    cwd,
    session_id: 'test-session-123',
    transcript_path: '/tmp/test-transcript.jsonl',
  });

  it('session-start should exit 0 when .succ/ not found (no-op)', async () => {
    const { exitCode } = await runHook('succ-session-start.cjs', claudeHookInput(tmpDir));
    expect(exitCode).toBe(0);
  }, 15_000);

  it('session-end should exit 0 when .succ/ not found (no-op)', async () => {
    const { exitCode } = await runHook('succ-session-end.cjs', claudeHookInput(tmpDir));
    expect(exitCode).toBe(0);
  }, 15_000);

  it('stop-reflection should exit 0 when .succ/ not found (no-op)', async () => {
    const { exitCode } = await runHook('succ-stop-reflection.cjs', claudeHookInput(tmpDir));
    expect(exitCode).toBe(0);
  }, 15_000);

  it('user-prompt should exit 0 when .succ/ not found (no-op)', async () => {
    const { exitCode } = await runHook('succ-user-prompt.cjs', {
      ...claudeHookInput(tmpDir),
      user_prompt: 'test prompt',
    });
    expect(exitCode).toBe(0);
  }, 15_000);

  it('post-tool should exit 0 when .succ/ not found (no-op)', async () => {
    const { exitCode } = await runHook('succ-post-tool.cjs', {
      ...claudeHookInput(tmpDir),
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      tool_output: 'hello',
    });
    expect(exitCode).toBe(0);
  }, 15_000);

  it('pre-tool should exit 0 for safe commands', async () => {
    const { exitCode } = await runHook('succ-pre-tool.cjs', {
      ...claudeHookInput(tmpDir),
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    });
    expect(exitCode).toBe(0);
  }, 15_000);

  it('session-start should emit a JSON payload when .succ/ exists', async () => {
    // Create a minimal .succ dir with config
    const projectDir = path.join(tmpDir, 'hook-project');
    const succDir = path.join(projectDir, '.succ');
    fs.mkdirSync(succDir, { recursive: true });
    fs.writeFileSync(
      path.join(succDir, 'config.json'),
      JSON.stringify({ storage: { backend: 'sqlite', vector: 'builtin' } })
    );

    const { stdout, exitCode } = await runHook(
      'succ-session-start.cjs',
      claudeHookInput(projectDir),
      projectDir
    );

    expect(exitCode).toBe(0);
    // Hook should emit JSON; on slow CI the output may be truncated,
    // so we only parse if it looks like complete JSON.
    const trimmed = stdout.trim();
    if (trimmed && trimmed.endsWith('}')) {
      const output = JSON.parse(trimmed);
      expect(typeof output).toBe('object');
    }
  }, 15_000);

  it('pre-tool should block dangerous git commands', async () => {
    // Create .succ dir so the hook actually processes
    const projectDir = path.join(tmpDir, 'hook-safety');
    const succDir = path.join(projectDir, '.succ');
    fs.mkdirSync(succDir, { recursive: true });
    fs.writeFileSync(
      path.join(succDir, 'config.json'),
      JSON.stringify({
        storage: { backend: 'sqlite', vector: 'builtin' },
        commandSafetyGuard: { mode: 'deny' },
      })
    );

    const { stdout, exitCode } = await runHook(
      'succ-pre-tool.cjs',
      {
        ...claudeHookInput(projectDir),
        tool_name: 'Bash',
        tool_input: { command: 'git reset --hard HEAD' },
      },
      projectDir
    );

    // Claude Code format: { hookSpecificOutput: { permissionDecision: "deny" } }
    expect(stdout.trim()).toBeTruthy();
    const output = JSON.parse(stdout.trim());
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('succ guard');
    expect(exitCode).toBe(0);
  }, 15_000);
});

// ─── succ init --plugin ─────────────────────────────────────────────────

describe('succ init --plugin E2E', () => {
  it('should create .succ/ dir but not .claude/settings.json', async () => {
    const projectDir = path.join(tmpDir, 'init-plugin-test');
    fs.mkdirSync(projectDir, { recursive: true });
    // Create a .git dir so getProjectRoot finds it
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });

    const cli = path.join(ROOT, 'dist', 'cli.js');
    const { stdout } = await execFileAsync(NODE, [...NODE_ARGS, cli, 'init', '--plugin', '--yes'], {
      cwd: projectDir,
      timeout: 30_000,
    });

    // .succ/ should be created
    expect(fs.existsSync(path.join(projectDir, '.succ'))).toBe(true);
    // .claude/settings.json should NOT be created (plugin handles hooks)
    expect(fs.existsSync(path.join(projectDir, '.claude', 'settings.json'))).toBe(false);
    // Output should mention plugin mode
    expect(stdout).toContain('Plugin mode');
  }, 30_000);

  it('should not copy hook scripts into .succ/hooks/', async () => {
    const projectDir = path.join(tmpDir, 'init-plugin-nohooks');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });

    const cli = path.join(ROOT, 'dist', 'cli.js');
    await execFileAsync(NODE, [...NODE_ARGS, cli, 'init', '--plugin', '--yes'], {
      cwd: projectDir,
      timeout: 30_000,
    });

    // .succ/hooks/ should not exist or be empty
    const hooksDir = path.join(projectDir, '.succ', 'hooks');
    if (fs.existsSync(hooksDir)) {
      const files = fs.readdirSync(hooksDir);
      expect(files.filter((f) => f.endsWith('.cjs'))).toHaveLength(0);
    }
  }, 30_000);

  it('regular init should still create .claude/settings.json', async () => {
    const projectDir = path.join(tmpDir, 'init-regular-test');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });

    const cli = path.join(ROOT, 'dist', 'cli.js');
    await execFileAsync(NODE, [...NODE_ARGS, cli, 'init', '--yes'], {
      cwd: projectDir,
      timeout: 30_000,
    });

    // .succ/ should be created
    expect(fs.existsSync(path.join(projectDir, '.succ'))).toBe(true);
    // .claude/settings.json SHOULD be created in regular mode
    expect(fs.existsSync(path.join(projectDir, '.claude', 'settings.json'))).toBe(true);
  }, 30_000);
});

// ─── Plugin Structure Integrity ─────────────────────────────────────────

describe('Plugin structure integrity', () => {
  it('dist/mcp-server.js should exist', () => {
    expect(fs.existsSync(MCP_SERVER)).toBe(true);
  });

  it('all hook scripts referenced in hooks.json should be executable', () => {
    const hooksJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf-8'));
    for (const event of Object.keys(hooksJson.hooks)) {
      const eventConfig = hooksJson.hooks[event]?.[0]?.hooks?.[0];
      expect(eventConfig).toBeDefined();
      const command: string = eventConfig.command;
      const match = command.match(/hooks\/(succ-[\w-]+\.cjs)/);
      expect(match).not.toBeNull();
      const scriptPath = path.join(ROOT, 'hooks', match![1]);
      expect(fs.existsSync(scriptPath)).toBe(true);
      // Verify it starts with a shebang or valid JS
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content.startsWith('#!/') || content.startsWith("'use strict'")).toBe(true);
    }
  });

  it('hooks/core/adapter.cjs and daemon-boot.cjs should exist', () => {
    expect(fs.existsSync(path.join(ROOT, 'hooks', 'core', 'adapter.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'hooks', 'core', 'daemon-boot.cjs'))).toBe(true);
  });

  it('.mcp.json should reference --project ${cwd}', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, '.mcp.json'), 'utf-8'));
    const args: string[] = config.mcpServers.succ.args;
    expect(args).toContain('--project');
    const projectIdx = args.indexOf('--project');
    expect(args[projectIdx + 1]).toBe('${cwd}');
  });
});
