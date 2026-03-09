#!/usr/bin/env node
/**
 * Stop Hook - Signal that Claude finished responding
 *
 * Notifies the daemon that Claude has finished responding.
 * The daemon handles idle detection and reflection trigger.
 */

const fs = require('fs');
const path = require('path');
const adapter = require('./core/adapter.cjs');
const { getDaemonPort } = require('./core/daemon-boot.cjs');

adapter.runHook('stop-reflection', async ({ hookInput, succDir }) => {
  const tmpDir = path.join(succDir, '.tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  // Get session_id — fall back to hookInput.session_id when transcript_path is absent
  // (session-start registers a synthetic session_id in that case)
  const transcriptPath = hookInput.transcript_path || '';
  const sessionId = transcriptPath
    ? path.basename(transcriptPath, '.jsonl')
    : hookInput.session_id || null;

  const daemonPort = getDaemonPort(succDir);

  // Check if this is a service session (e.g., reflection subagent)
  const isServiceSession = process.env.SUCC_SERVICE_SESSION === '1';

  // Notify daemon of stop activity (awaited)
  const notifyDaemon = async () => {
    if (!daemonPort || !sessionId) return;

    try {
      await fetch(`http://127.0.0.1:${daemonPort}/api/session/activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          type: 'stop',
          transcript_path: transcriptPath,
          is_service: isServiceSession,
        }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // intentionally empty
    }
  };

  // Wait for daemon notification before exit
  await notifyDaemon();
  process.exit(0);
});

// Safety timeout
setTimeout(() => {
  process.exit(0);
}, 3000);
