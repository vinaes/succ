import fs from 'fs';
import path from 'path';
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

  console.log('\nsucc initialized successfully!');
  console.log('\nNext steps:');
  console.log('  1. Set OPENROUTER_API_KEY environment variable');
  console.log('  2. Add content to .claude/brain/');
  console.log('  3. Run `succ index` to create embeddings');
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
