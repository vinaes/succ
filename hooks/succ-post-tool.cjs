#!/usr/bin/env node
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

const spawn = require('cross-spawn');
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
    if (process.platform === 'win32' && /^\/[a-z]\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    const toolName = hookInput.tool_name || '';
    const toolInput = hookInput.tool_input || {};
    const toolOutput = hookInput.tool_output || '';
    const wasSuccess = !hookInput.tool_error;

    if (!wasSuccess) {
      process.exit(0);
    }

    // Helper to call succ CLI (cross-spawn for cross-platform without shell)
    const succRemember = (content, tags) => {
      try {
        spawn.sync('npx', [
          'succ', 'remember',
          content,
          '--tags', tags,
          '--source', 'auto-capture',
        ], {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {}
    };

    // Pattern 1: Git Commits
    if (toolName === 'Bash' && toolInput.command) {
      const cmd = toolInput.command;

      if (/git\s+commit/i.test(cmd) && wasSuccess) {
        const msgMatch = cmd.match(/-m\s+["']([^"']+)["']/);
        if (msgMatch) {
          succRemember('Committed: ' + msgMatch[1], 'git,commit,milestone');
        }
      }

      // npm/yarn install detection
      if (/(?:npm|yarn|pnpm)\s+(?:install|add)\s+(\S+)/i.test(cmd) && wasSuccess) {
        const pkgMatch = cmd.match(/(?:npm|yarn|pnpm)\s+(?:install|add)\s+(\S+)/i);
        if (pkgMatch && pkgMatch[1] && !pkgMatch[1].startsWith('-')) {
          succRemember('Added dependency: ' + pkgMatch[1], 'dependency,package');
        }
      }

      // Test run detection
      if (/(?:npm\s+test|yarn\s+test|pytest|jest|vitest)/i.test(cmd)) {
        const passed = /pass|success|ok|✓/i.test(toolOutput);
        const failed = /fail|error|✗|✘/i.test(toolOutput);

        if (passed && !failed) {
          succRemember('Tests passed after changes', 'test,success');
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
        /\.(ts|tsx|js|jsx|py|go|rs|md)$/.test(relativePath)
      ) {
        const content = toolInput.content || '';
        if (content.length < 5000) {
          succRemember('Created file: ' + relativePath, 'file,created');
        }
      }
    }

    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
});
