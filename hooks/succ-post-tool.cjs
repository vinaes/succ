#!/usr/bin/env node
/**
 * PostToolUse Hook - Auto-capture important actions
 *
 * Automatically saves memories for significant events:
 * 1. Git commits - save commit message as milestone
 * 2. New dependencies - track package additions
 * 3. Test runs - save test results
 * 4. File creation - note new files
 * 5. MEMORY.md sync - auto-save bullets to long-term memory
 *
 * Uses daemon API for memory operations
 */

const fs = require('fs');
const path = require('path');

/**
 * Parse MEMORY.md bullets, classify by section header.
 * Returns [{ text, tags }] for each bullet worth saving.
 */
function parseMemoryMdBullets(content) {
  const results = [];
  let currentSection = '';

  for (const line of content.split('\n')) {
    const headerMatch = line.match(/^##\s+(.+)/);
    if (headerMatch) {
      currentSection = headerMatch[1].trim().toLowerCase();
      continue;
    }

    const bulletMatch = line.match(/^-\s+(.+)/);
    if (!bulletMatch) continue;

    const text = bulletMatch[1].trim();
    if (text.length < 10) continue;

    const tags = ['memory-md'];
    if (/gotcha/i.test(currentSection)) tags.push('gotcha');
    else if (/learning|lesson/i.test(currentSection)) tags.push('learning');
    else if (/decision|chose/i.test(currentSection)) tags.push('decision');
    else if (/pattern/i.test(currentSection)) tags.push('pattern');
    else if (/change|phase/i.test(currentSection)) tags.push('changelog');
    else tags.push('observation');

    results.push({ text, tags });
  }

  return results;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('readable', () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    input += chunk;
  }
});

process.stdin.on('end', async () => {
  try {
    const hookInput = JSON.parse(input);
    let projectDir = hookInput.cwd || process.cwd();

    // Windows path fix
    if (process.platform === 'win32' && /^\/[a-z]\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    // Skip if succ is not initialized in this project
    if (!fs.existsSync(path.join(projectDir, '.succ'))) {
      process.exit(0);
    }

    const toolName = hookInput.tool_name || '';
    const toolInput = hookInput.tool_input || {};
    const toolOutput = hookInput.tool_output || '';
    const wasSuccess = !hookInput.tool_error;

    if (!wasSuccess) {
      process.exit(0);
    }

    // Read daemon port
    let daemonPort = null;
    try {
      const portFile = path.join(projectDir, '.succ', '.tmp', 'daemon.port');
      if (fs.existsSync(portFile)) {
        daemonPort = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
      }
    } catch {}

    if (!daemonPort) {
      process.exit(0);
    }

    // Helper to save memory via daemon API
    const succRemember = async (content, tagsStr) => {
      try {
        await fetch(`http://127.0.0.1:${daemonPort}/api/remember`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: content,
            tags: tagsStr.split(','),
            source: 'auto-capture',
          }),
          signal: AbortSignal.timeout(3000),
        });
      } catch {}
    };

    // Pattern 1: Git Commits
    if (toolName === 'Bash' && toolInput.command) {
      const cmd = toolInput.command;

      if (/git\s+commit/i.test(cmd) && wasSuccess) {
        const msgMatch = cmd.match(/-m\s+["']([^"']+)["']/);
        if (msgMatch) {
          await succRemember('Committed: ' + msgMatch[1], 'git,commit,milestone');
        }
      }

      // npm/yarn install detection
      if (/(?:npm|yarn|pnpm)\s+(?:install|add)\s+(\S+)/i.test(cmd) && wasSuccess) {
        const pkgMatch = cmd.match(/(?:npm|yarn|pnpm)\s+(?:install|add)\s+(\S+)/i);
        if (pkgMatch && pkgMatch[1] && !pkgMatch[1].startsWith('-')) {
          await succRemember('Added dependency: ' + pkgMatch[1], 'dependency,package');
        }
      }

      // Test run detection
      if (/(?:npm\s+test|yarn\s+test|pytest|jest|vitest)/i.test(cmd)) {
        const passed = /pass|success|ok|✓/i.test(toolOutput);
        const failed = /fail|error|✗|✘/i.test(toolOutput);

        if (passed && !failed) {
          await succRemember('Tests passed after changes', 'test,success');
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
          await succRemember('Created file: ' + relativePath, 'file,created');
        }
      }
    }

    // Pattern 3: MEMORY.md sync → save bullets to long-term memory (parallel)
    if ((toolName === 'Edit' || toolName === 'Write') && toolInput.file_path && wasSuccess) {
      if (path.basename(toolInput.file_path) === 'MEMORY.md') {
        try {
          const memContent = fs.readFileSync(toolInput.file_path, 'utf8');
          const bullets = parseMemoryMdBullets(memContent);
          if (bullets.length > 0) {
            await Promise.allSettled(bullets.map(bullet =>
              fetch(`http://127.0.0.1:${daemonPort}/api/remember`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  content: bullet.text,
                  tags: bullet.tags,
                  source: 'memory-md-sync',
                }),
                signal: AbortSignal.timeout(5000),
              }).catch(() => {})
            ));
          }
        } catch {}
      }
    }

    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
});
