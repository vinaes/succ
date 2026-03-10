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

const path = require('path');
const adapter = require('./core/adapter.cjs');
const { getDaemonPort } = require('./core/daemon-boot.cjs');
const { log: _log } = require('./core/log.cjs');

adapter.runHook('session-end', async ({ hookInput, succDir }) => {
  const log = (msg) => _log(succDir, 'session-end', msg);
  const daemonPort = getDaemonPort(succDir);
  if (!daemonPort) {
    log('Daemon port unavailable — skipping session unregister/reflection');
    process.exit(0);
  }

  // Get session info — fall back to hookInput.session_id when transcript_path is absent
  // (session-start registers a synthetic session_id in that case)
  const transcriptPath = hookInput.transcript_path || '';
  const sessionId = transcriptPath
    ? path.basename(transcriptPath, '.jsonl')
    : hookInput.session_id || null;

  if (!sessionId) {
    process.exit(0);
  }

  // Skip reflection for service sessions (internal Claude calls from succ)
  // This prevents infinite loop: session-end -> processSessionEnd -> runClaudeCLI -> session-end -> ...
  const isServiceSession = process.env.SUCC_SERVICE_SESSION === '1';

  // Tell daemon to unregister and process session
  // Daemon will handle transcript parsing, summarization, and memory saving asynchronously
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/api/session/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        transcript_path: transcriptPath,
        run_reflection: !isServiceSession, // Don't run reflection for service sessions
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log(`Unregister failed: ${res.status} ${res.statusText} for session ${sessionId}`);
    }
  } catch (err) {
    log(`Daemon communication failed: ${err.message || err}`);
  }

  process.exit(0);
});
