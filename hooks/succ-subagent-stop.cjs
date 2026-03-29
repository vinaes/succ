#!/usr/bin/env node
/**
 * SubagentStop Hook — Proxy to daemon for saving subagent results
 *
 * Forwards the full hook input to the daemon's /api/hooks/subagent-stop endpoint.
 * Fail-open: if daemon is down, exits 0 silently.
 */

const adapter = require('./core/adapter.cjs');
const { ensureDaemonLazy } = require('./core/daemon-boot.cjs');

adapter.runHook('subagent-stop', async ({ hookInput, projectDir, succDir }) => {
  const daemonPort = ensureDaemonLazy(projectDir, succDir);

  if (!daemonPort) {
    process.exit(0);
  }

  try {
    await fetch(`http://127.0.0.1:${daemonPort}/api/hooks/subagent-stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hookInput),
      signal: AbortSignal.timeout(2000),
    });
  } catch (err) {
    console.error(`[succ:subagent-stop] Daemon proxy failed: ${err.message || err}`);
  }

  process.exit(0);
});

// Safety timeout
setTimeout(() => {
  process.exit(0);
}, 3000);
