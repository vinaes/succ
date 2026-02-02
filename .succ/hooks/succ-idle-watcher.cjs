#!/usr/bin/env node
/**
 * Idle Watcher Daemon - Monitors user activity and triggers reflections during idle
 *
 * Launched by SessionStart, runs in background for entire session.
 * Monitors:
 *   - last-user-prompt.txt (updated by UserPromptSubmit)
 *   - last-stop.txt (updated by Stop)
 *   - watcher-active.txt (deleted by SessionEnd to signal shutdown)
 *
 * Logic:
 *   - If Stop happened and no UserPrompt for N minutes → trigger reflection
 *   - Check every 30 seconds
 *   - Exit when watcher-active.txt is deleted
 *
 * Config (in .succ/config.json):
 *   idle_watcher: {
 *     enabled: true,
 *     idle_minutes: 2,        // Minutes of inactivity before reflection
 *     check_interval: 30,     // Seconds between checks
 *     min_conversation_length: 5  // Minimum transcript entries before reflecting
 *   }
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Default config
const DEFAULT_CONFIG = {
  enabled: true,
  idle_minutes: 2,
  check_interval: 30,
  min_conversation_length: 5,
};

// Get project dir from command line or environment
const projectDir = process.argv[2] || process.env.SUCC_PROJECT_DIR || process.cwd();

// Paths
const tmpDir = path.join(projectDir, '.succ', '.tmp');
const activeFile = path.join(tmpDir, 'watcher-active.txt');
const lastUserPromptFile = path.join(tmpDir, 'last-user-prompt.txt');
const lastStopFile = path.join(tmpDir, 'last-stop.txt');
const lastReflectionFile = path.join(tmpDir, 'last-idle-reflection.txt');

/**
 * Load config from project
 */
function loadConfig() {
  const configPaths = [
    path.join(projectDir, '.succ', 'config.json'),
    path.join(projectDir, '.claude', 'succ.json'),
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const watcherConfig = config.idle_watcher || {};
        return {
          enabled: watcherConfig.enabled ?? DEFAULT_CONFIG.enabled,
          idle_minutes: watcherConfig.idle_minutes ?? DEFAULT_CONFIG.idle_minutes,
          check_interval: watcherConfig.check_interval ?? DEFAULT_CONFIG.check_interval,
          min_conversation_length: watcherConfig.min_conversation_length ?? DEFAULT_CONFIG.min_conversation_length,
        };
      } catch {
        // Config parse error, use defaults
      }
    }
  }

  return DEFAULT_CONFIG;
}

/**
 * Read timestamp from file
 */
function readTimestamp(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10);
    }
  } catch {
    // Ignore
  }
  return 0;
}

/**
 * Check if watcher should still be running
 */
function isActive() {
  return fs.existsSync(activeFile);
}

/**
 * Trigger reflection via idle-reflection hook
 */
function triggerReflection(transcriptPath) {
  // Find idle-reflection hook (same directory as this script)
  const idleHookPath = path.join(__dirname, 'succ-idle-reflection.cjs');

  if (!fs.existsSync(idleHookPath)) {
    return;
  }

  // Update last reflection timestamp
  fs.writeFileSync(lastReflectionFile, Date.now().toString());

  // Prepare hook input
  const hookInput = {
    cwd: projectDir,
    transcript_path: transcriptPath,
  };

  // Spawn idle-reflection hook
  const proc = spawn('node', [idleHookPath], {
    cwd: projectDir,
    stdio: ['pipe', 'ignore', 'ignore'],
    detached: true,
  });

  proc.stdin.write(JSON.stringify(hookInput));
  proc.stdin.end();
  proc.unref();
}

/**
 * Find current transcript path
 */
function findTranscriptPath() {
  // Try to read from a signal file that session-start might have written
  const transcriptSignalFile = path.join(tmpDir, 'current-transcript.txt');
  if (fs.existsSync(transcriptSignalFile)) {
    try {
      const tp = fs.readFileSync(transcriptSignalFile, 'utf8').trim();
      if (fs.existsSync(tp)) {
        return tp;
      }
    } catch {
      // Ignore
    }
  }

  // Fallback: look for recent transcript in Claude's projects directory
  const claudeProjectsDir = path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.claude',
    'projects'
  );

  if (!fs.existsSync(claudeProjectsDir)) {
    return null;
  }

  // Find most recent .jsonl file
  try {
    let newestFile = null;
    let newestTime = 0;

    const searchDir = (dir, depth = 0) => {
      if (depth > 2) return; // Don't go too deep

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          searchDir(fullPath, depth + 1);
        } else if (entry.name.endsWith('.jsonl')) {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > newestTime) {
            newestTime = stat.mtimeMs;
            newestFile = fullPath;
          }
        }
      }
    };

    searchDir(claudeProjectsDir);
    return newestFile;
  } catch {
    return null;
  }
}

/**
 * Check transcript length
 */
function getTranscriptLength(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return 0;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    return content.trim().split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * Main watcher loop
 */
async function main() {
  const config = loadConfig();

  if (!config.enabled) {
    process.exit(0);
  }

  // Ensure tmp dir exists
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  // Create active file to signal we're running
  fs.writeFileSync(activeFile, Date.now().toString());

  const checkIntervalMs = config.check_interval * 1000;
  const idleThresholdMs = config.idle_minutes * 60 * 1000;

  // Main loop
  while (isActive()) {
    const now = Date.now();
    const lastUserPrompt = readTimestamp(lastUserPromptFile);
    const lastStop = readTimestamp(lastStopFile);
    const lastReflection = readTimestamp(lastReflectionFile);

    // Check if we should trigger reflection:
    // 1. There was a Stop after the last UserPrompt (Claude responded)
    // 2. It's been idle_minutes since the last Stop
    // 3. We haven't reflected since that Stop
    const claudeResponded = lastStop > lastUserPrompt;
    const idleLongEnough = (now - lastStop) >= idleThresholdMs;
    const notReflectedYet = lastReflection < lastStop;

    if (claudeResponded && idleLongEnough && notReflectedYet && lastStop > 0) {
      // Check transcript length
      const transcriptPath = findTranscriptPath();
      const transcriptLength = getTranscriptLength(transcriptPath);

      if (transcriptLength >= config.min_conversation_length) {
        triggerReflection(transcriptPath);
      }
    }

    // Wait before next check
    await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
  }

  // Cleanup
  try {
    fs.unlinkSync(lastUserPromptFile);
  } catch { /* ignore */ }
  try {
    fs.unlinkSync(lastStopFile);
  } catch { /* ignore */ }

  process.exit(0);
}

// Run
main().catch(() => process.exit(1));
