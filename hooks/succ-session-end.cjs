#!/usr/bin/env node
/**
 * SessionEnd Hook - Notify daemon to process session
 *
 * Minimal hook that just tells daemon to:
 * 1. Unregister the session
 * 2. Process transcript asynchronously (summarize, extract learnings, save to memory)
 *
 * All heavy lifting is done by daemon after hook exits.
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

    // Read daemon port
    const portFile = path.join(projectDir, '.succ', '.tmp', 'daemon.port');
    let daemonPort = null;
    try {
      if (fs.existsSync(portFile)) {
        daemonPort = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
      }
    } catch {}

    if (!daemonPort) {
      process.exit(0);
    }

    // Get session info
    const transcriptPath = hookInput.transcript_path || '';
    const sessionId = transcriptPath ? path.basename(transcriptPath, '.jsonl') : null;

    if (!sessionId) {
      process.exit(0);
    }

    // Skip reflection for service sessions (internal Claude calls from succ)
    // This prevents infinite loop: session-end -> processSessionEnd -> runClaudeCLI -> session-end -> ...
    const isServiceSession = process.env.SUCC_SERVICE_SESSION === '1';

    // Tell daemon to unregister and process session
    // Daemon will handle transcript parsing, summarization, and memory saving asynchronously
    try {
      await fetch(`http://127.0.0.1:${daemonPort}/api/session/unregister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          transcript_path: transcriptPath,
          run_reflection: !isServiceSession,  // Don't run reflection for service sessions
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Daemon communication failed, exit anyway
    }

    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
});
