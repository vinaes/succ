import fs from 'fs';
import path from 'path';
import os from 'os';
import { getProjectRoot, getClaudeDir } from '../lib/config.js';

interface InitOptions {
  force?: boolean;
}

export async function init(options: InitOptions = {}): Promise<void> {
  const projectRoot = getProjectRoot();
  const claudeDir = getClaudeDir();

  console.log(`Initializing succ in ${projectRoot}`);

  // Check if already initialized
  if (fs.existsSync(path.join(claudeDir, 'succ.db')) && !options.force) {
    console.log('succ is already initialized. Use --force to reinitialize.');
    return;
  }

  // Create directories
  const dirs = [
    claudeDir,
    path.join(claudeDir, 'brain'),
    path.join(claudeDir, 'brain', '.meta'),
    path.join(claudeDir, 'hooks'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created ${path.relative(projectRoot, dir)}/`);
    }
  }

  // Create brain index
  const brainIndexPath = path.join(claudeDir, 'brain', 'index.md');
  if (!fs.existsSync(brainIndexPath)) {
    fs.writeFileSync(
      brainIndexPath,
      `---
description: "Project knowledge base index"
type: index
---

# Brain Index

This is the knowledge base for this project. Add documentation, decisions, and learnings here.

## Structure

- \`decisions/\` — Architecture decisions
- \`learnings/\` — Bug fixes, discoveries
- \`index.md\` — This file

## Usage

Run \`succ index\` to index this brain for semantic search.
`
    );
    console.log('Created brain/index.md');
  }

  // Create learnings file
  const learningsPath = path.join(claudeDir, 'brain', '.meta', 'learnings.md');
  if (!fs.existsSync(learningsPath)) {
    fs.writeFileSync(
      learningsPath,
      `# Learnings

Lessons learned during development.

## Format

- **Date**: What was learned
`
    );
    console.log('Created brain/.meta/learnings.md');
  }

  // Create session-start hook
  const sessionStartPath = path.join(claudeDir, 'hooks', 'session-start.cjs');
  if (!fs.existsSync(sessionStartPath)) {
    fs.writeFileSync(sessionStartPath, getSessionStartHook());
    console.log('Created hooks/session-start.cjs');
  }

  // Create settings.json
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.cjs"',
                    timeout: 10,
                  },
                ],
              },
            ],
          },
        },
        null,
        2
      )
    );
    console.log('Created settings.json');
  }

  // Add MCP server to Claude Code config
  const mcpAdded = addMcpServer(projectRoot);

  console.log('\nsucc initialized successfully!');
  if (mcpAdded) {
    console.log('MCP server added to Claude Code config.');
  }
  console.log('\nNext steps:');
  console.log('  1. Run `succ analyze` to generate brain documentation');
  console.log('  2. Run `succ index` to create embeddings (local, no API key needed)');
  console.log('  3. Run `succ search <query>` to find relevant content');
  if (mcpAdded) {
    console.log('  4. Restart Claude Code to enable succ tools');
  }
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
    // Use npx to run from anywhere, or direct path if installed globally
    mcpConfig.mcpServers.succ = {
      command: 'npx',
      args: ['succ-mcp'],
      cwd: projectRoot,
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

function getSessionStartHook(): string {
  return `#!/usr/bin/env node
/**
 * SessionStart Hook - Brain Context Injection via succ
 * Uses execFileSync for security (no shell injection)
 */

const { execFileSync } = require('child_process');
const path = require('path');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('readable', () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    input += chunk;
  }
});

process.stdin.on('end', () => {
  try {
    const hookInput = JSON.parse(input);
    const projectDir = hookInput.cwd || process.cwd();

    // Try to get context from succ
    try {
      const result = execFileSync('npx', ['succ', 'search', 'session context'], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 5000,
      });

      if (result.trim()) {
        const output = {
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: \`<brain-context>\\n\${result}\\n</brain-context>\`
          }
        };
        console.log(JSON.stringify(output));
      }
    } catch {
      // succ not available or no results, continue silently
    }

    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
});
`;
}
