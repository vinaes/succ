#!/usr/bin/env node
/**
 * Stop Reflection Hook - Triggered when Claude finishes responding
 *
 * Thin wrapper around succ-idle-reflection.cjs with throttling.
 * Only runs if enough time has passed since last reflection.
 *
 * Config (in .succ/config.json or .claude/succ.json):
 *   stop_reflection: {
 *     enabled: true,
 *     throttle_minutes: 5
 *   }
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Default throttle: minimum minutes between reflections
const DEFAULT_THROTTLE_MINUTES = 5;

/**
 * Load config from project
 */
function loadConfig(projectDir) {
  const configPaths = [
    path.join(projectDir, '.succ', 'config.json'),
    path.join(projectDir, '.claude', 'succ.json'),
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const stopConfig = config.stop_reflection || {};
        return {
          enabled: stopConfig.enabled ?? true,
          throttle_minutes: stopConfig.throttle_minutes ?? DEFAULT_THROTTLE_MINUTES,
        };
      } catch {
        // Config parse error, use defaults
      }
    }
  }

  return {
    enabled: true,
    throttle_minutes: DEFAULT_THROTTLE_MINUTES,
  };
}

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

    // Load config
    const config = loadConfig(projectDir);

    // Check if enabled
    if (!config.enabled) {
      process.exit(0);
    }

    // Throttle file path
    const tmpDir = path.join(projectDir, '.succ', '.tmp');
    const throttlePath = path.join(tmpDir, 'last-stop-reflection.txt');

    // Check throttle
    if (fs.existsSync(throttlePath)) {
      try {
        const lastTime = parseInt(fs.readFileSync(throttlePath, 'utf8').trim(), 10);
        const now = Date.now();
        const elapsedMinutes = (now - lastTime) / (1000 * 60);

        if (elapsedMinutes < config.throttle_minutes) {
          // Too soon, skip
          process.exit(0);
        }
      } catch {
        // Can't read throttle file, continue
      }
    }

    // Ensure tmp dir exists
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    // Update throttle timestamp BEFORE running (to prevent parallel runs)
    fs.writeFileSync(throttlePath, Date.now().toString());

    // Find the idle-reflection hook
    // First try same directory as this script (global install)
    // Then fallback to project hooks directory (local dev)
    let idleHookPath = path.join(__dirname, 'succ-idle-reflection.cjs');

    if (!fs.existsSync(idleHookPath)) {
      idleHookPath = path.join(projectDir, '.succ', 'hooks', 'succ-idle-reflection.cjs');
      if (!fs.existsSync(idleHookPath)) {
        process.exit(0);
      }
    }

    // Spawn idle-reflection hook with the same input
    const proc = spawn('node', [idleHookPath], {
      cwd: projectDir,
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });

    // Pass through the hook input
    proc.stdin.write(input);
    proc.stdin.end();

    // Don't wait for it
    proc.unref();

    process.exit(0);

  } catch (err) {
    process.exit(0);
  }
});

// Safety timeout
setTimeout(() => {
  process.exit(0);
}, 3000);
