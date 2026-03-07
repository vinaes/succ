import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { generatePluginManifest } from './plugin-manifest.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('plugin-manifest', () => {
  it('should generate manifest with name "succ"', () => {
    const manifest = generatePluginManifest(ROOT);
    expect(manifest.name).toBe('succ');
  });

  it('should use version from package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    const manifest = generatePluginManifest(ROOT);
    expect(manifest.version).toBe(pkg.version);
  });

  it('should include description, author, homepage, license', () => {
    const manifest = generatePluginManifest(ROOT);
    expect(manifest.description).toBeTruthy();
    expect(manifest.author.name).toBe('vinaes');
    expect(manifest.homepage).toBe('https://succ.ai');
    expect(manifest.license).toBeTruthy();
  });

  it('should include keywords', () => {
    const manifest = generatePluginManifest(ROOT);
    expect(manifest.keywords).toContain('memory');
    expect(manifest.keywords).toContain('mcp');
  });
});

describe('hooks/hooks.json', () => {
  const hooksJsonPath = path.join(ROOT, 'hooks', 'hooks.json');

  it('should be valid JSON', () => {
    const content = fs.readFileSync(hooksJsonPath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('should reference all 6 hook scripts that exist', () => {
    const config = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
    const events = Object.keys(config.hooks);
    expect(events).toHaveLength(6);
    expect(events).toEqual(
      expect.arrayContaining([
        'SessionStart',
        'Stop',
        'SessionEnd',
        'UserPromptSubmit',
        'PostToolUse',
        'PreToolUse',
      ])
    );

    for (const event of events) {
      const command: string = config.hooks[event][0].hooks[0].command;
      // Extract script filename from command
      const match = command.match(/hooks\/(succ-[\w-]+\.cjs)/);
      expect(match).not.toBeNull();
      const scriptPath = path.join(ROOT, 'hooks', match![1]);
      expect(fs.existsSync(scriptPath)).toBe(true);
    }
  });

  it('should use ${CLAUDE_PLUGIN_ROOT} in all command paths', () => {
    const config = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
    for (const event of Object.keys(config.hooks)) {
      const command: string = config.hooks[event][0].hooks[0].command;
      expect(command).toContain('${CLAUDE_PLUGIN_ROOT}');
    }
  });

  it('should have valid timeout values', () => {
    const config = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
    for (const event of Object.keys(config.hooks)) {
      const timeout: number = config.hooks[event][0].hooks[0].timeout;
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(120);
    }
  });
});

describe('.mcp.json', () => {
  const mcpPath = path.join(ROOT, '.mcp.json');

  it('should be valid JSON', () => {
    const content = fs.readFileSync(mcpPath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('should define succ server with node command', () => {
    const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers.succ).toBeDefined();
    expect(config.mcpServers.succ.command).toBe('node');
  });

  it('should reference dist/mcp-server.js via CLAUDE_PLUGIN_ROOT', () => {
    const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    const args: string[] = config.mcpServers.succ.args;
    const serverArg = args.find((a: string) => a.includes('mcp-server'));
    expect(serverArg).toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(serverArg).toContain('dist/mcp-server.js');
  });

  it('should set SUCC_PROJECT_ROOT env', () => {
    const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers.succ.env).toBeDefined();
    expect(config.mcpServers.succ.env.SUCC_PROJECT_ROOT).toBeDefined();
  });
});

describe('.claude-plugin/marketplace.json', () => {
  const marketplacePath = path.join(ROOT, '.claude-plugin', 'marketplace.json');

  it('should be valid JSON', () => {
    const content = fs.readFileSync(marketplacePath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('should have required fields', () => {
    const mp = JSON.parse(fs.readFileSync(marketplacePath, 'utf-8'));
    expect(mp.name).toBe('succ');
    expect(mp.owner).toBeDefined();
    expect(mp.owner.name).toBe('vinaes');
    expect(mp.plugins).toHaveLength(1);
    expect(mp.plugins[0].name).toBe('succ');
    expect(mp.plugins[0].source.source).toBe('npm');
    expect(mp.plugins[0].source.package).toBe('@vinaes/succ');
  });
});

describe('package.json files field', () => {
  it('should include plugin-related entries', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    const files: string[] = pkg.files;
    expect(files).toContain('.claude-plugin');
    expect(files).toContain('.mcp.json');
    expect(files).toContain('skills');
    expect(files).toContain('hooks');
    expect(files).toContain('agents');
  });
});

describe('skills/succ-memory/SKILL.md', () => {
  it('should exist and contain frontmatter', () => {
    const skillPath = path.join(ROOT, 'skills', 'succ-memory', 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, 'utf-8');
    expect(content).toMatch(/^---\r?\n/);
    expect(content).toContain('name: succ-memory');
    expect(content).toContain('description:');
  });
});
