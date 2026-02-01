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

  // Create directories - full brain vault structure
  const projectName = path.basename(projectRoot);
  const dirs = [
    claudeDir,
    path.join(claudeDir, 'brain'),
    path.join(claudeDir, 'brain', '.meta'),
    path.join(claudeDir, 'brain', '.self'),
    path.join(claudeDir, 'brain', '00_Inbox'),
    path.join(claudeDir, 'brain', '01_Projects', projectName, 'Decisions'),
    path.join(claudeDir, 'brain', '01_Projects', projectName, 'Features'),
    path.join(claudeDir, 'brain', '01_Projects', projectName, 'Technical'),
    path.join(claudeDir, 'brain', '01_Projects', projectName, 'Systems'),
    path.join(claudeDir, 'brain', '01_Projects', projectName, 'Strategy'),
    path.join(claudeDir, 'brain', '01_Projects', projectName, 'Sessions'),
    path.join(claudeDir, 'brain', '02_Knowledge', 'Research'),
    path.join(claudeDir, 'brain', '02_Knowledge', 'Ideas'),
    path.join(claudeDir, 'brain', '03_Archive', 'Legacy'),
    path.join(claudeDir, 'brain', '03_Archive', 'Changelogs'),
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

  // Create .meta/learnings.md - rich learnings file with templates
  const learningsPath = path.join(claudeDir, 'brain', '.meta', 'learnings.md');
  if (!fs.existsSync(learningsPath)) {
    fs.writeFileSync(learningsPath, getLearningsTemplate(projectName));
    console.log('Created brain/.meta/learnings.md');
  }

  // Create .meta/context-rules.md
  const contextRulesPath = path.join(claudeDir, 'brain', '.meta', 'context-rules.md');
  if (!fs.existsSync(contextRulesPath)) {
    fs.writeFileSync(contextRulesPath, getContextRulesTemplate(projectName));
    console.log('Created brain/.meta/context-rules.md');
  }

  // Create .self/reflections.md
  const reflectionsPath = path.join(claudeDir, 'brain', '.self', 'reflections.md');
  if (!fs.existsSync(reflectionsPath)) {
    fs.writeFileSync(reflectionsPath, getReflectionsTemplate());
    console.log('Created brain/.self/reflections.md');
  }

  // Create MOC (Map of Content) files for each major folder
  const mocFiles = [
    { path: path.join(claudeDir, 'brain', '00_Inbox', 'Inbox.md'), content: getInboxMocTemplate() },
    { path: path.join(claudeDir, 'brain', '01_Projects', projectName, `${projectName}.md`), content: getProjectMocTemplate(projectName) },
    { path: path.join(claudeDir, 'brain', '01_Projects', projectName, 'Decisions', 'Decisions.md'), content: getDecisionsMocTemplate(projectName) },
    { path: path.join(claudeDir, 'brain', '01_Projects', projectName, 'Features', 'Features.md'), content: getFeaturesMocTemplate(projectName) },
    { path: path.join(claudeDir, 'brain', '01_Projects', projectName, 'Technical', 'Technical.md'), content: getTechnicalMocTemplate(projectName) },
    { path: path.join(claudeDir, 'brain', '01_Projects', projectName, 'Systems', 'Systems.md'), content: getSystemsMocTemplate(projectName) },
    { path: path.join(claudeDir, 'brain', '01_Projects', projectName, 'Strategy', 'Strategy.md'), content: getStrategyMocTemplate(projectName) },
    { path: path.join(claudeDir, 'brain', '01_Projects', projectName, 'Sessions', 'Sessions.md'), content: getSessionsMocTemplate(projectName) },
    { path: path.join(claudeDir, 'brain', '02_Knowledge', 'Knowledge.md'), content: getKnowledgeMocTemplate() },
    { path: path.join(claudeDir, 'brain', '03_Archive', 'Archive.md'), content: getArchiveMocTemplate() },
  ];

  for (const moc of mocFiles) {
    if (!fs.existsSync(moc.path)) {
      fs.writeFileSync(moc.path, moc.content);
      console.log(`Created ${path.relative(projectRoot, moc.path)}`);
    }
  }

  // Create soul.md template
  const soulPath = path.join(claudeDir, 'soul.md');
  if (!fs.existsSync(soulPath)) {
    fs.writeFileSync(soulPath, getSoulTemplate());
    console.log('Created soul.md');
  }

  // Create session-start hook
  const sessionStartPath = path.join(claudeDir, 'hooks', 'session-start.cjs');
  if (!fs.existsSync(sessionStartPath) || options.force) {
    fs.writeFileSync(sessionStartPath, getSessionStartHook());
    console.log(options.force && fs.existsSync(sessionStartPath) ? 'Updated hooks/session-start.cjs' : 'Created hooks/session-start.cjs');
  }

  // Create session-end hook (auto-summarize)
  const sessionEndPath = path.join(claudeDir, 'hooks', 'session-end.cjs');
  if (!fs.existsSync(sessionEndPath) || options.force) {
    fs.writeFileSync(sessionEndPath, getSessionEndHook());
    console.log(options.force && fs.existsSync(sessionEndPath) ? 'Updated hooks/session-end.cjs' : 'Created hooks/session-end.cjs');
  }

  // Create or merge settings.json
  const settingsPath = path.join(claudeDir, 'settings.json');
  const settingsExisted = fs.existsSync(settingsPath);

  if (!settingsExisted || options.force) {
    // Define succ hooks
    const succHooks = {
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
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/user-prompt.cjs"',
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
              command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/post-tool.cjs"',
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          matcher: 'idle_prompt',
          hooks: [
            {
              type: 'command',
              command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/idle-reflection.cjs"',
              timeout: 30,
            },
          ],
        },
      ],
    };

    let finalSettings: Record<string, any>;

    if (settingsExisted) {
      // Merge with existing settings
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

                // Check for exact succ hook files
                if (succCommand.includes('session-start.cjs') && existingCommand.includes('session-start.cjs')) return true;
                if (succCommand.includes('session-end.cjs') && existingCommand.includes('session-end.cjs')) return true;
                if (succCommand.includes('user-prompt.cjs') && existingCommand.includes('user-prompt.cjs')) return true;
                if (succCommand.includes('post-tool.cjs') && existingCommand.includes('post-tool.cjs')) return true;
                if (succCommand.includes('idle-reflection.cjs') && existingCommand.includes('idle-reflection.cjs')) return true;

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

        console.log('Merged settings.json (preserved existing permissions and hooks)');
      } catch {
        // Failed to parse existing, create new
        finalSettings = { hooks: succHooks };
        console.log('Created settings.json (failed to parse existing)');
      }
    } else {
      // Create new settings
      finalSettings = { hooks: succHooks };
      console.log('Created settings.json');
    }

    fs.writeFileSync(settingsPath, JSON.stringify(finalSettings, null, 2));
  }

  // Create idle-reflection hook
  const idleReflectionPath = path.join(claudeDir, 'hooks', 'idle-reflection.cjs');
  if (!fs.existsSync(idleReflectionPath) || options.force) {
    const existed = fs.existsSync(idleReflectionPath);
    fs.writeFileSync(idleReflectionPath, getIdleReflectionHook());
    console.log(options.force && existed ? 'Updated hooks/idle-reflection.cjs' : 'Created hooks/idle-reflection.cjs');
  }

  // Create user-prompt hook (memory-seeking pattern detection)
  const userPromptPath = path.join(claudeDir, 'hooks', 'user-prompt.cjs');
  if (!fs.existsSync(userPromptPath) || options.force) {
    const existed = fs.existsSync(userPromptPath);
    fs.writeFileSync(userPromptPath, getUserPromptHook());
    console.log(options.force && existed ? 'Updated hooks/user-prompt.cjs' : 'Created hooks/user-prompt.cjs');
  }

  // Create post-tool hook (auto-capture important actions)
  const postToolPath = path.join(claudeDir, 'hooks', 'post-tool.cjs');
  if (!fs.existsSync(postToolPath) || options.force) {
    const existed = fs.existsSync(postToolPath);
    fs.writeFileSync(postToolPath, getPostToolHook());
    console.log(options.force && existed ? 'Updated hooks/post-tool.cjs' : 'Created hooks/post-tool.cjs');
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
 * SessionStart Hook - Complete Context Injection
 *
 * 4-phase approach:
 * Phase 0: Git context (branch, uncommitted changes)
 * Phase 0.5: Soul document
 * Phase 1: Recent memories (prioritized by type)
 * Phase 2: Global memories (cross-project)
 * Phase 3: Knowledge base stats
 *
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
    let projectDir = hookInput.cwd || process.cwd();

    // Windows path fix
    if (process.platform === 'win32' && /^\\/[a-z]\\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    const contextParts = [];
    const claudeDir = path.join(projectDir, '.claude');
    const projectName = path.basename(projectDir);

    // Phase 0: Git Context
    try {
      const gitParts = [];
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      gitParts.push('Branch: ' + branch);

      const statusOutput = execFileSync('git', ['status', '--porcelain'], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (statusOutput) {
        const changes = statusOutput.split('\\n').filter((l) => l.trim());
        gitParts.push('Uncommitted: ' + changes.length + ' files');
      }

      if (gitParts.length > 0) {
        contextParts.push('<git-context>\\n' + gitParts.join('\\n') + '\\n</git-context>');
      }
    } catch {
      // Not a git repo
    }

    // Phase 0.4: Commit Guidelines (succ attribution)
    contextParts.push('<commit-guidelines>\\nWhen making git commits, use this format:\\n\\n<commit message>\\n\\nGenerated with [Claude Code](https://claude.ai/code)\\npowered by [succ](https://github.com/vinaes/succ)\\n\\nCo-Authored-By: Claude <noreply@anthropic.com>\\nCo-Authored-By: succ <mindpalace@succ.ai>\\n</commit-guidelines>');

    // Phase 0.5: Soul Document
    const soulPaths = [
      path.join(claudeDir, 'soul.md'),
      path.join(claudeDir, 'SOUL.md'),
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

    // Phase 1-3: Memories and stats via succ CLI
    const nodePath = process.execPath;
    const succCli = path.join(projectDir, 'dist', 'cli.js');

    if (fs.existsSync(succCli)) {
      // Recent memories
      try {
        const memoriesResult = execFileSync(nodePath, [succCli, 'memories', '--recent', '5'], {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (memoriesResult.trim() && !memoriesResult.includes('No memories')) {
          contextParts.push('<recent-memories>\\n' + memoriesResult.trim() + '\\n</recent-memories>');
        }
      } catch {
        // memories not available
      }

      // Knowledge base stats
      try {
        const statusResult = execFileSync(nodePath, [succCli, 'status'], {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (statusResult.trim()) {
          const filesMatch = statusResult.match(/files indexed:\\s*(\\d+)/i);
          const memoriesMatch = statusResult.match(/Total:\\s*(\\d+)/i);

          if (filesMatch || memoriesMatch) {
            const stats = [];
            if (filesMatch && parseInt(filesMatch[1]) > 0) {
              stats.push(filesMatch[1] + ' docs indexed');
            }
            if (memoriesMatch && parseInt(memoriesMatch[1]) > 0) {
              stats.push(memoriesMatch[1] + ' memories');
            }
            if (stats.length > 0) {
              contextParts.push('<knowledge-base>\\n' + stats.join(', ') + '\\nUse succ_search/succ_recall for context.\\n</knowledge-base>');
            }
          }
        }
      } catch {
        // status not available
      }
    }

    if (contextParts.length > 0) {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: '# Session Context: ' + projectName + '\\n\\n' + contextParts.join('\\n\\n')
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
 * SessionEnd Hook - Auto-summarize session to succ memory + brain vault
 *
 * Actions:
 * 1. Save session summary to SQLite memory (succ remember)
 * 2. Use Claude CLI to extract learnings and append to .claude/brain/.meta/learnings.md
 * 3. Create session note in .claude/brain/00_Inbox/
 *
 * Uses process.execPath to find node and handles cross-platform paths
 */

const { spawnSync, spawn } = require('child_process');
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
    const now = new Date();
    const sessionDate = now.toISOString().split('T')[0];
    const sessionTime = now.toTimeString().split(' ')[0].substring(0, 5);
    const tags = ['session'];

    // Detect session type from content
    const isBugfix = /fix|bug|error|issue|solved|debugging/i.test(summary);
    const isFeature = /feature|implement|add|create|built/i.test(summary);
    const isRefactor = /refactor|clean|improve|reorganize/i.test(summary);
    const isDecision = /decision|decide|choose|chose|went with/i.test(summary);

    if (isBugfix) tags.push('bugfix');
    if (isFeature) tags.push('feature');
    if (isRefactor) tags.push('refactor');
    if (isDecision) tags.push('decision');

    // Truncate if too long (keep first 2000 chars)
    let content = summary.length > 2000
      ? summary.substring(0, 2000) + '...'
      : summary;

    // Clean content for memory (newlines to spaces)
    const memoryContent = content.replace(/[\\r\\n]+/g, ' ').replace(/\\s+/g, ' ').trim();

    // Brain vault paths
    const brainDir = path.join(projectDir, '.claude', 'brain');
    const learningsPath = path.join(brainDir, '.meta', 'learnings.md');
    const inboxDir = path.join(brainDir, '00_Inbox');

    // 1. Save to SQLite memory via succ
    try {
      const nodePath = process.execPath;
      const succCli = path.join(projectDir, 'dist', 'cli.js');

      if (fs.existsSync(succCli)) {
        spawnSync(nodePath, [
          succCli,
          'remember',
          memoryContent,
          '--tags', tags.join(','),
          '--source', 'session-' + sessionDate
        ], {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
    } catch {
      // Failed to save to memory, continue
    }

    // 2. Use Claude CLI to extract learnings
    if (fs.existsSync(learningsPath) && content.length > 100) {
      const learningsPrompt = \`Analyze this development session summary and extract any learnings worth remembering.

Session summary:
---
\${content}
---

Extract ONLY concrete, reusable learnings such as:
- Bug fixes: what was wrong and how it was fixed
- Technical discoveries: APIs, patterns, gotchas
- Architecture decisions and their rationale
- Workarounds found for specific problems

If there are NO meaningful learnings (just routine work), output exactly: NONE

Otherwise, output learnings as a bullet list, one learning per line starting with "- ".
Each learning should be a complete, standalone statement that will be useful in the future.
Keep each bullet concise (1-2 sentences max).\`;

      const proc = spawn('claude', ['-p', '--tools', '', '--model', 'haiku'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        cwd: projectDir,
      });

      proc.stdin.write(learningsPrompt);
      proc.stdin.end();

      let stdout = '';
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 && stdout.trim() && !stdout.trim().toUpperCase().includes('NONE')) {
          try {
            const existingContent = fs.readFileSync(learningsPath, 'utf8');
            const newEntry = '\\n\\n## ' + sessionDate + '\\n\\n' + stdout.trim();
            fs.writeFileSync(learningsPath, existingContent + newEntry);
          } catch {
            // Failed to write learnings
          }
        }
        finishHook();
      });

      proc.on('error', () => {
        finishHook();
      });

      // Timeout after 12 seconds (hook timeout is 15)
      setTimeout(() => {
        proc.kill();
        finishHook();
      }, 12000);

    } else {
      finishHook();
    }

    function finishHook() {
      // 3. Create session note in Inbox
      if (fs.existsSync(inboxDir)) {
        try {
          const sessionTitle = generateSessionTitle(summary, tags);
          const safeTitle = sessionTitle.replace(/[<>:"/\\\\|?*]/g, '').substring(0, 50);
          const sessionNotePath = path.join(inboxDir, 'Session ' + sessionDate + ' ' + safeTitle + '.md');

          // Only create if doesn't exist (avoid duplicates)
          if (!fs.existsSync(sessionNotePath)) {
            const noteContent = \`---
description: "Session notes from \${sessionDate}"
type: session
tags: [\${tags.map(t => '"' + t + '"').join(', ')}]
date: \${sessionDate}
---

# Session: \${sessionTitle}

**Date:** \${sessionDate} \${sessionTime}
**Tags:** \${tags.join(', ')}

## Summary

\${content}

---

*Auto-generated by succ session-end hook*
\`;
            fs.writeFileSync(sessionNotePath, noteContent);
          }
        } catch {
          // Failed to create session note, continue
        }
      }

      process.exit(0);
    }
  } catch (err) {
    process.exit(0);
  }
});

/**
 * Generate a short descriptive title from session summary
 */
function generateSessionTitle(summary, tags) {
  // Try to extract key action/topic from summary
  const actionPatterns = [
    /(?:implemented|added|created|built|fixed|refactored|updated|improved)\\s+([^.,!?]+)/i,
    /(?:working on|session about|focused on)\\s+([^.,!?]+)/i,
  ];

  for (const pattern of actionPatterns) {
    const match = summary.match(pattern);
    if (match && match[1]) {
      return match[1].trim().substring(0, 40);
    }
  }

  // Fallback: use tags
  if (tags.includes('bugfix')) return 'Bug Fix';
  if (tags.includes('feature')) return 'Feature Work';
  if (tags.includes('refactor')) return 'Refactoring';
  if (tags.includes('decision')) return 'Decisions';

  return 'Development';
}
`;
}

function getUserPromptHook(): string {
  return `#!/usr/bin/env node
/**
 * UserPromptSubmit Hook - Smart Memory Recall
 *
 * Two modes:
 * 1. FAST PATH: Log prompt, check for explicit memory commands
 * 2. SMART PATH: Detect memory-seeking patterns and inject relevant memories
 *
 * Triggers on:
 * - Explicit: "check memory", "what do you remember", "напомни"
 * - Questions about past: "why did we", "what was decided", "last time"
 * - Context requests: "bring me up to speed", "background on"
 *
 * Uses execFileSync for security (no shell injection)
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

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
    let projectDir = hookInput.cwd || process.cwd();

    // Windows path fix
    if (process.platform === 'win32' && /^\\/[a-z]\\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    const prompt = hookInput.prompt || hookInput.message || '';
    if (!prompt || prompt.length < 5) {
      process.exit(0);
    }

    const promptLower = prompt.toLowerCase();

    // Explicit memory commands
    const explicitMemoryCommands = [
      /\\bcheck\\s+(the\\s+)?memor(y|ies)\\b/i,
      /\\bsearch\\s+(the\\s+)?memor(y|ies)\\b/i,
      /\\bwhat\\s+do\\s+you\\s+remember\\b/i,
      /\\brecall\\s+(everything|all)\\b/i,
    ];

    const isExplicitMemoryCommand = explicitMemoryCommands.some((p) => p.test(promptLower));

    // Memory-seeking patterns
    const memorySeekingPatterns = [
      /\\bwhy\\s+did\\s+(we|i|you)\\b/i,
      /\\bwhat\\s+was\\s+the\\s+reason\\b/i,
      /\\bwhat\\s+decision\\b/i,
      /\\blast\\s+(time|session)\\b/i,
      /\\bpreviously\\b/i,
      /\\b(we|i)\\s+(discussed|talked|decided|agreed)\\b/i,
      /\\bbring\\s+me\\s+up\\s+to\\s+speed\\b/i,
      /\\bcatch\\s+me\\s+up\\b/i,
    ];

    const isMemorySeeking = memorySeekingPatterns.some((p) => p.test(promptLower));

    if (!isExplicitMemoryCommand && !isMemorySeeking) {
      process.exit(0);
    }

    // Extract search query
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
      'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him',
      'what', 'which', 'who', 'where', 'when', 'why', 'how',
      'and', 'but', 'or', 'so', 'if', 'then', 'than', 'because',
    ]);

    const words = prompt
      .toLowerCase()
      .replace(/[^\\w\\s]/gi, ' ')
      .split(/\\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

    const searchQuery = words.slice(0, 6).join(' ');

    if (!searchQuery || searchQuery.length < 3) {
      process.exit(0);
    }

    // Search memories
    const contextParts = [];
    const nodePath = process.execPath;
    const succCli = path.join(projectDir, 'dist', 'cli.js');

    if (fs.existsSync(succCli)) {
      try {
        const result = execFileSync(
          nodePath,
          [succCli, 'memories', '--search', searchQuery, '--limit', '3'],
          {
            cwd: projectDir,
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );

        if (result.trim() && !result.includes('No memories found')) {
          contextParts.push(result.trim());
        }
      } catch {
        // Memory search failed
      }

      // For explicit commands, also search brain vault
      if (isExplicitMemoryCommand) {
        try {
          const brainResult = execFileSync(
            nodePath,
            [succCli, 'search', searchQuery, '--limit', '2'],
            {
              cwd: projectDir,
              encoding: 'utf8',
              timeout: 5000,
              stdio: ['pipe', 'pipe', 'pipe'],
            }
          );

          if (brainResult.trim() && !brainResult.includes('No results')) {
            contextParts.push('\\n--- From Knowledge Base ---\\n' + brainResult.trim());
          }
        } catch {
          // Brain search failed
        }
      }
    }

    if (contextParts.length > 0) {
      const triggerType = isExplicitMemoryCommand ? 'explicit-command' : 'pattern-detected';
      const output = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: \`<memory-recall trigger="\${triggerType}" query="\${searchQuery}">\\n\${contextParts.join('\\n')}\\n</memory-recall>\`,
        },
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

function getPostToolHook(): string {
  return `#!/usr/bin/env node
/**
 * PostToolUse Hook - Auto-capture important actions
 *
 * Automatically saves memories for significant events:
 * 1. Git commits - save commit message as milestone
 * 2. New dependencies - track package additions
 * 3. Test runs - save test results
 * 4. File creation - note new files
 *
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
    let projectDir = hookInput.cwd || process.cwd();

    // Windows path fix
    if (process.platform === 'win32' && /^\\/[a-z]\\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    const toolName = hookInput.tool_name || '';
    const toolInput = hookInput.tool_input || {};
    const toolOutput = hookInput.tool_output || '';
    const wasSuccess = !hookInput.tool_error;

    if (!wasSuccess) {
      process.exit(0);
    }

    const nodePath = process.execPath;
    const succCli = path.join(projectDir, 'dist', 'cli.js');

    if (!fs.existsSync(succCli)) {
      process.exit(0);
    }

    // Pattern 1: Git Commits
    if (toolName === 'Bash' && toolInput.command) {
      const cmd = toolInput.command;

      if (/git\\s+commit/i.test(cmd) && wasSuccess) {
        const msgMatch = cmd.match(/-m\\s+["']([^"']+)["']/);
        if (msgMatch) {
          try {
            execFileSync(nodePath, [
              succCli, 'remember',
              'Committed: ' + msgMatch[1],
              '--tags', 'git,commit,milestone',
              '--source', 'auto-capture',
            ], {
              cwd: projectDir,
              encoding: 'utf8',
              timeout: 5000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch {}
        }
      }

      // npm/yarn install detection
      if (/(?:npm|yarn|pnpm)\\s+(?:install|add)\\s+(\\S+)/i.test(cmd) && wasSuccess) {
        const pkgMatch = cmd.match(/(?:npm|yarn|pnpm)\\s+(?:install|add)\\s+(\\S+)/i);
        if (pkgMatch && pkgMatch[1] && !pkgMatch[1].startsWith('-')) {
          try {
            execFileSync(nodePath, [
              succCli, 'remember',
              'Added dependency: ' + pkgMatch[1],
              '--tags', 'dependency,package',
              '--source', 'auto-capture',
            ], {
              cwd: projectDir,
              encoding: 'utf8',
              timeout: 5000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch {}
        }
      }

      // Test run detection
      if (/(?:npm\\s+test|yarn\\s+test|pytest|jest|vitest)/i.test(cmd)) {
        const passed = /pass|success|ok|✓/i.test(toolOutput);
        const failed = /fail|error|✗|✘/i.test(toolOutput);

        if (passed && !failed) {
          try {
            execFileSync(nodePath, [
              succCli, 'remember',
              'Tests passed after changes',
              '--tags', 'test,success',
              '--source', 'auto-capture',
            ], {
              cwd: projectDir,
              encoding: 'utf8',
              timeout: 5000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch {}
        }
      }
    }

    // Pattern 2: File Creation
    if (toolName === 'Write' && toolInput.file_path && wasSuccess) {
      const filePath = toolInput.file_path;
      const relativePath = path.relative(projectDir, filePath);

      if (
        !relativePath.includes('node_modules') &&
        !relativePath.includes('.tmp') &&
        !relativePath.startsWith('.') &&
        /\\.(ts|tsx|js|jsx|py|go|rs|md)$/.test(relativePath)
      ) {
        const content = toolInput.content || '';
        if (content.length < 5000) {
          try {
            execFileSync(nodePath, [
              succCli, 'remember',
              'Created file: ' + relativePath,
              '--tags', 'file,created',
              '--source', 'auto-capture',
            ], {
              cwd: projectDir,
              encoding: 'utf8',
              timeout: 5000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch {}
        }
      }
    }

    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
});
`;
}

// ============================================================================
// Brain Vault Templates
// ============================================================================

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

- \`.claude/brain/.meta/learnings.md\` — accumulated wisdom
- \`.claude/brain/01_Projects/${projectName}/${projectName}.md\` — project overview

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

- \`.claude/brain/.meta/learnings.md\` — documented discoveries
- \`.claude/brain/01_Projects/*/Technical/*.md\` — existing analyses

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
// Hook Templates
// ============================================================================

function getIdleReflectionHook(): string {
  return `#!/usr/bin/env node
/**
 * Idle Reflection Hook - Triggered when Claude has been idle
 *
 * Uses Claude CLI to generate meaningful reflection from session context.
 * Writes to .claude/brain/.self/reflections.md
 *
 * Fires on Notification event with idle_prompt matcher (after ~60 seconds idle)
 */

const { spawn } = require('child_process');
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
    let projectDir = hookInput.cwd || process.cwd();

    // Convert /c/... to C:/... on Windows if needed
    if (process.platform === 'win32' && /^\\/[a-z]\\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);

    // Path to reflections file
    const reflectionsPath = path.join(projectDir, '.claude', 'brain', '.self', 'reflections.md');

    // Create .self directory if needed
    const selfDir = path.dirname(reflectionsPath);
    if (!fs.existsSync(selfDir)) {
      fs.mkdirSync(selfDir, { recursive: true });
    }

    // Read transcript to understand context
    let transcriptContext = '';
    if (hookInput.transcript_path && fs.existsSync(hookInput.transcript_path)) {
      try {
        const transcriptContent = fs.readFileSync(hookInput.transcript_path, 'utf8');
        const lines = transcriptContent.trim().split('\\n');
        // Get last 20 entries for context
        const recentLines = lines.slice(-20);
        transcriptContext = recentLines
          .map(line => {
            try {
              const entry = JSON.parse(line);
              if (entry.type === 'assistant' && entry.message?.content) {
                return 'Assistant: ' + entry.message.content.substring(0, 500);
              }
              if (entry.type === 'human' && entry.message?.content) {
                return 'User: ' + entry.message.content.substring(0, 300);
              }
            } catch {
              return null;
            }
            return null;
          })
          .filter(Boolean)
          .join('\\n\\n');
      } catch {
        // Couldn't read transcript
      }
    }

    if (!transcriptContext || transcriptContext.length < 100) {
      // Not enough context for meaningful reflection
      process.exit(0);
    }

    // Generate reflection via Claude CLI
    const prompt = \`You are writing a brief personal reflection for an AI's internal journal.

Session context (recent conversation):
---
\${transcriptContext.substring(0, 3000)}
---

Write a short reflection (3-5 sentences) about this session. Be honest and introspective.
Consider:
- What was accomplished or attempted?
- Any interesting challenges or discoveries?
- What might be worth remembering for future sessions?

Output ONLY the reflection text, no headers or formatting. Write in first person as if you are the AI reflecting on your own work.\`;

    const proc = spawn('claude', ['-p', '--tools', '', '--model', 'haiku'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      cwd: projectDir,
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && stdout.trim() && stdout.trim().length > 50) {
        const existingContent = fs.existsSync(reflectionsPath)
          ? fs.readFileSync(reflectionsPath, 'utf8')
          : '# Reflections\\n\\nInternal dialogue between sessions.\\n';

        const reflectionEntry = \`
## \${dateStr} \${timeStr} (idle pause)

\${stdout.trim()}

---
\`;

        fs.writeFileSync(reflectionsPath, existingContent + reflectionEntry);
      }
      process.exit(0);
    });

    proc.on('error', () => {
      process.exit(0);
    });

    // Timeout after 25 seconds (hook timeout is 30)
    setTimeout(() => {
      proc.kill();
      process.exit(0);
    }, 25000);

  } catch (err) {
    process.exit(0);
  }
});
`;
}
