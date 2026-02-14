/**
 * Process Registry — tracks all spawned child processes.
 *
 * Safety net: on process exit, kills everything we spawned.
 * Works cross-platform (Node's process.kill handles OS differences).
 *
 * Usage:
 *   processRegistry.register(proc.pid, 'claude-cli');
 *   proc.on('close', () => processRegistry.unregister(proc.pid));
 */

import { logInfo, logWarn } from './fault-logger.js';

interface TrackedProcess {
  label: string;
  spawnedAt: number;
}

class ProcessRegistry {
  private pids = new Map<number, TrackedProcess>();
  private cleanupRegistered = false;

  register(pid: number, label: string): void {
    this.pids.set(pid, { label, spawnedAt: Date.now() });
    this.ensureCleanup();
    logInfo('process-registry', `Registered pid=${pid} (${label})`);
  }

  unregister(pid: number): void {
    if (this.pids.delete(pid)) {
      logInfo('process-registry', `Unregistered pid=${pid}`);
    }
  }

  /** Kill all tracked processes. Called on exit. */
  killAll(): void {
    if (this.pids.size === 0) return;

    logInfo('process-registry', `Killing ${this.pids.size} tracked process(es)`);
    for (const [pid, info] of this.pids) {
      try {
        process.kill(pid, 'SIGTERM');
        logInfo('process-registry', `Sent SIGTERM to pid=${pid} (${info.label})`);
      } catch {
        // ESRCH = process already dead — that's fine
      }
    }

    // Force-kill stragglers after 2s
    const remaining = new Map(this.pids);
    this.pids.clear();

    setTimeout(() => {
      for (const [pid, info] of remaining) {
        try {
          process.kill(pid, 0); // Test if alive
          process.kill(pid, 'SIGKILL');
          logWarn('process-registry', `Force-killed pid=${pid} (${info.label})`);
        } catch {
          // Already dead
        }
      }
    }, 2000).unref();
  }

  /** Get count of tracked processes */
  get size(): number {
    return this.pids.size;
  }

  /** Get snapshot for logging/debugging */
  getActive(): Array<{ pid: number; label: string; ageMs: number }> {
    const now = Date.now();
    return Array.from(this.pids.entries()).map(([pid, info]) => ({
      pid,
      label: info.label,
      ageMs: now - info.spawnedAt,
    }));
  }

  private ensureCleanup(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;

    const cleanup = () => this.killAll();

    // 'exit' is sync-only, last resort
    process.on('exit', () => {
      // Can't do async here, just try SIGTERM
      for (const [pid] of this.pids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* noop */
        }
      }
    });

    // These allow async cleanup
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
    process.on('beforeExit', cleanup);
  }
}

export const processRegistry = new ProcessRegistry();
