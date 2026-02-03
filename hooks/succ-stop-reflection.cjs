#!/usr/bin/env node
/**
 * Stop Hook - Signal that Claude finished responding
 *
 * Notifies the daemon that Claude has finished responding.
 * The daemon handles idle detection and reflection trigger.
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

    // Convert /c/... to C:/... on Windows if needed
    if (process.platform === 'win32' && /^\/[a-z]\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    const tmpDir = path.join(projectDir, '.succ', '.tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    // Get session_id from transcript_path (unique per session)
    const transcriptPath = hookInput.transcript_path || '';
    const sessionId = transcriptPath ? path.basename(transcriptPath, '.jsonl') : null;

    // Read daemon port
    let daemonPort = null;
    try {
      const portFile = path.join(tmpDir, 'daemon.port');
      if (fs.existsSync(portFile)) {
        daemonPort = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
      }
    } catch {}

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
      } catch {}
    };

    // Wait for daemon notification before exit
    await notifyDaemon();
    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
});

// Safety timeout
setTimeout(() => {
  process.exit(0);
}, 3000);
