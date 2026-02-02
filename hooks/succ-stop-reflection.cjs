#!/usr/bin/env node
/**
 * Stop Hook - Signal that Claude finished responding
 *
 * Writes timestamp to last-stop.txt for the idle watcher to monitor.
 * The watcher handles the actual idle detection and reflection trigger.
 */

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
    if (process.platform === 'win32' && /^\/[a-z]\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    // Write stop timestamp for idle watcher
    const tmpDir = path.join(projectDir, '.succ', '.tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    fs.writeFileSync(path.join(tmpDir, 'last-stop.txt'), Date.now().toString());

    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
});

// Safety timeout
setTimeout(() => {
  process.exit(0);
}, 2000);
