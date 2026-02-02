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

// Default BPE config
const DEFAULT_BPE_CONFIG = {
  enabled: false,
  vocab_size: 5000,
  min_frequency: 2,
  retrain_interval: 'hourly',
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
        const bpeConfig = config.bpe || {};
        return {
          enabled: watcherConfig.enabled ?? DEFAULT_CONFIG.enabled,
          idle_minutes: watcherConfig.idle_minutes ?? DEFAULT_CONFIG.idle_minutes,
          check_interval: watcherConfig.check_interval ?? DEFAULT_CONFIG.check_interval,
          min_conversation_length: watcherConfig.min_conversation_length ?? DEFAULT_CONFIG.min_conversation_length,
          bpe: {
            enabled: bpeConfig.enabled ?? DEFAULT_BPE_CONFIG.enabled,
            vocab_size: bpeConfig.vocab_size ?? DEFAULT_BPE_CONFIG.vocab_size,
            min_frequency: bpeConfig.min_frequency ?? DEFAULT_BPE_CONFIG.min_frequency,
            retrain_interval: bpeConfig.retrain_interval ?? DEFAULT_BPE_CONFIG.retrain_interval,
          },
        };
      } catch {
        // Config parse error, use defaults
      }
    }
  }

  return { ...DEFAULT_CONFIG, bpe: DEFAULT_BPE_CONFIG };
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
 * Trigger reflection via idle-reflection hook (async, detached)
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
 * Trigger reflection synchronously (for session end)
 * Waits for the hook to complete before returning
 */
function triggerReflectionSync(transcriptPath) {
  const { spawnSync } = require('child_process');
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

  // Run synchronously with timeout
  spawnSync('node', [idleHookPath], {
    cwd: projectDir,
    input: JSON.stringify(hookInput),
    timeout: 60000, // 60 second timeout
    stdio: ['pipe', 'ignore', 'ignore'],
  });
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

// BPE training state
const lastBPETrainFile = path.join(tmpDir, 'last-bpe-train.txt');
const lastCodeIndexFile = path.join(tmpDir, 'last-code-index.txt');

/**
 * Read last BPE train timestamp
 */
function readLastBPETrain() {
  return readTimestamp(lastBPETrainFile);
}

/**
 * Read last code index timestamp (set by index-code command)
 */
function readLastCodeIndex() {
  return readTimestamp(lastCodeIndexFile);
}

/**
 * Check if BPE needs retraining based on config
 */
function needsBPERetrain(config) {
  if (!config.bpe || !config.bpe.enabled) {
    return false;
  }

  const lastTrained = readLastBPETrain();
  const lastIndexed = readLastCodeIndex();
  const now = Date.now();

  // Never trained
  if (lastTrained === 0) {
    return true;
  }

  const hoursSinceTraining = (now - lastTrained) / (1000 * 60 * 60);

  if (config.bpe.retrain_interval === 'hourly') {
    // Retrain if > 1 hour AND new code was indexed since last training
    if (hoursSinceTraining >= 1 && lastIndexed > lastTrained) {
      return true;
    }
    // Always retrain if > 24 hours (daily maintenance)
    return hoursSinceTraining >= 24;
  } else {
    // Daily: retrain if > 24 hours
    return hoursSinceTraining >= 24;
  }
}

/**
 * Trigger BPE training via succ CLI
 */
function triggerBPETraining(config) {
  // Update timestamp first to prevent multiple triggers
  fs.writeFileSync(lastBPETrainFile, Date.now().toString());

  // Use npx succ to run BPE training
  const proc = spawn('npx', ['succ', 'train-bpe',
    '--vocab-size', config.bpe.vocab_size.toString(),
    '--min-frequency', config.bpe.min_frequency.toString()
  ], {
    cwd: projectDir,
    stdio: 'ignore',
    detached: true,
    shell: process.platform === 'win32',
  });

  proc.unref();
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

    // Check if BPE needs retraining (during idle time)
    if (idleLongEnough && needsBPERetrain(config)) {
      triggerBPETraining(config);
    }

    // Wait before next check
    await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
  }

  // Before exiting, check if we should run reflection
  // This ensures reflection runs even if user never went idle during session
  const lastReflection = readTimestamp(lastReflectionFile);
  const sessionStartTime = readTimestamp(activeFile + '.start'); // We'll create this
  const now = Date.now();
  const thirtyMinutesMs = 30 * 60 * 1000;

  // Run reflection if:
  // 1. Never ran during this session, OR
  // 2. Last reflection was more than 30 minutes ago
  const shouldRunFinalReflection =
    lastReflection === 0 ||
    (now - lastReflection) > thirtyMinutesMs;

  if (shouldRunFinalReflection) {
    const transcriptPath = findTranscriptPath();
    const transcriptLength = getTranscriptLength(transcriptPath);

    if (transcriptLength >= config.min_conversation_length) {
      // Run reflection synchronously before exit
      triggerReflectionSync(transcriptPath);
    }
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
