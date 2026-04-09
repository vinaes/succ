#!/usr/bin/env node
/**
 * TaskCompleted Hook — Proxy to daemon for memory curator trigger
 *
 * Forwards the full hook input to the daemon's /api/hooks/task-completed endpoint.
 * The daemon triggers memory curator fire-and-forget and responds immediately.
 * Fail-open: if daemon is down, exits 0 silently.
 */

const adapter = require('./core/adapter.cjs');
const { ensureDaemonLazy, daemonFetch } = require('./core/daemon-boot.cjs');

adapter.runHook('task-completed', async ({ hookInput, projectDir, succDir }) => {
  const daemonPort = ensureDaemonLazy(projectDir, succDir);

  if (!daemonPort) {
    process.exit(0);
  }

  try {
    await daemonFetch(
      `http://127.0.0.1:${daemonPort}/api/hooks/task-completed`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookInput),
        signal: AbortSignal.timeout(2000),
      },
      succDir
    );
  } catch (err) {
    console.error(`[succ:task-completed] Daemon proxy failed: ${err.message || err}`);
  }

  process.exit(0);
});

// Safety timeout
setTimeout(() => {
  process.exit(0);
}, 3000);
