#!/usr/bin/env node
/**
 * PermissionRequest Hook — Proxy to daemon for auto-approve/deny via hook-rules
 *
 * Forwards the full hook input to the daemon's /api/hooks/permission endpoint.
 * Fail-open: if daemon is down, exits 0 (passes through to user dialog).
 */

const adapter = require('./core/adapter.cjs');
const { ensureDaemonLazy } = require('./core/daemon-boot.cjs');

adapter.runHook('permission', async ({ agent, hookInput, projectDir, succDir }) => {
  const daemonPort = ensureDaemonLazy(projectDir, succDir);

  if (!daemonPort) {
    process.exit(0);
  }

  try {
    const response = await fetch(`http://127.0.0.1:${daemonPort}/api/hooks/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hookInput),
      signal: AbortSignal.timeout(2000),
    });

    if (response.ok) {
      const result = await response.json();
      if (result && result.hookSpecificOutput) {
        const output = adapter.formatOutput(agent, 'PermissionRequest', {});
        // Pass through daemon's hookSpecificOutput directly
        output.json = result;
        console.log(JSON.stringify(output.json));
        process.exit(output.exitCode);
      }
    }
  } catch (err) {
    console.error(`[succ:permission] Daemon proxy failed: ${err.message || err}`);
  }

  process.exit(0);
});

// Safety timeout
setTimeout(() => {
  process.exit(0);
}, 3000);
