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

  // Create soul.md template
  const soulPath = path.join(claudeDir, 'soul.md');
  if (!fs.existsSync(soulPath)) {
    fs.writeFileSync(soulPath, getSoulTemplate());
    console.log('Created soul.md');
  }

  // Create session-start hook
  const sessionStartPath = path.join(claudeDir, 'hooks', 'session-start.cjs');
  if (!fs.existsSync(sessionStartPath)) {
    fs.writeFileSync(sessionStartPath, getSessionStartHook());
    console.log('Created hooks/session-start.cjs');
  }

  // Create session-end hook (auto-summarize)
  const sessionEndPath = path.join(claudeDir, 'hooks', 'session-end.cjs');
  if (!fs.existsSync(sessionEndPath)) {
    fs.writeFileSync(sessionEndPath, getSessionEndHook());
    console.log('Created hooks/session-end.cjs');
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
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-end.cjs"',
                    timeout: 15,
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

function getSessionStartHook(): string {
  return `#!/usr/bin/env node
/**
 * SessionStart Hook - Soul + Brain Context + Recent Memories Injection via succ
 * Uses execFileSync for security (no shell injection)
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
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
    const contextParts = [];

    // Try to read soul document (personality/values)
    const soulPaths = [
      path.join(projectDir, '.claude', 'soul.md'),
      path.join(projectDir, '.claude', 'SOUL.md'),
      path.join(projectDir, 'soul.md'),
      path.join(projectDir, 'SOUL.md'),
    ];

    for (const soulPath of soulPaths) {
      if (fs.existsSync(soulPath)) {
        const soulContent = fs.readFileSync(soulPath, 'utf8').trim();
        if (soulContent) {
          contextParts.push('<soul>\\n' + soulContent + '\\n</soul>');
        }
        break;
      }
    }

    // Try to get brain context from succ search
    try {
      const brainResult = execFileSync('npx', ['succ', 'search', 'project overview architecture'], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (brainResult.trim() && !brainResult.includes('No results')) {
        contextParts.push('<brain-context>\\n' + brainResult.trim() + '\\n</brain-context>');
      }
    } catch {
      // succ search not available, continue
    }

    // Try to get recent memories
    try {
      const memoriesResult = execFileSync('npx', ['succ', 'memories', '--recent', '5'], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (memoriesResult.trim() && !memoriesResult.includes('No memories')) {
        contextParts.push('<recent-memories>\\n' + memoriesResult.trim() + '\\n</recent-memories>');
      }
    } catch {
      // memories command not available, continue
    }

    if (contextParts.length > 0) {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: contextParts.join('\\n\\n')
        }
      };
      console.log(JSON.stringify(output));
    }

    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
});
`;
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

function getSessionEndHook(): string {
  return `#!/usr/bin/env node
/**
 * SessionEnd Hook - Auto-summarize session to succ memory
 * Receives session transcript summary and saves key learnings/decisions
 *
 * Uses process.execPath to find node and handles cross-platform paths
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
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
    // Normalize the path for the current platform
    let projectDir = hookInput.cwd || process.cwd();
    // Convert /c/... to C:/... on Windows if needed
    if (process.platform === 'win32' && /^\\/[a-z]\\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    // Stop hook receives: { transcript_summary, ... }
    const summary = hookInput.transcript_summary || hookInput.session_summary;

    if (!summary || summary.length < 50) {
      // Session too short or no summary, skip
      process.exit(0);
    }

    // Extract key info from session
    const sessionDate = new Date().toISOString().split('T')[0];
    const tags = ['session'];

    // Detect session type from content
    if (/fix|bug|error|issue/i.test(summary)) {
      tags.push('bugfix');
    }
    if (/feature|implement|add|create/i.test(summary)) {
      tags.push('feature');
    }
    if (/refactor|clean|improve/i.test(summary)) {
      tags.push('refactor');
    }
    if (/decision|decide|choose|chose/i.test(summary)) {
      tags.push('decision');
    }

    // Truncate if too long (keep first 2000 chars)
    let content = summary.length > 2000
      ? summary.substring(0, 2000) + '...'
      : summary;

    // Clean content (newlines to spaces)
    content = content.replace(/[\\r\\n]+/g, ' ').replace(/\\s+/g, ' ').trim();

    try {
      // Use the same node that's running this script
      const nodePath = process.execPath;
      const succCli = path.join(projectDir, 'dist', 'cli.js');

      if (fs.existsSync(succCli)) {
        // Local development: run dist/cli.js directly
        spawnSync(nodePath, [
          succCli,
          'remember',
          content,
          '--tags', tags.join(','),
          '--source', 'session-' + sessionDate
        ], {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
      // If dist/cli.js doesn't exist, skip (succ not built or not installed)
    } catch {
      // Failed to save, continue silently
    }

    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
});
`;
}
