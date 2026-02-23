import { logWarn } from './fault-logger.js';
/**
 * Graph Export Scheduler
 *
 * Extracted from db.ts to break circular dependency between db.ts and graph-export.ts
 */

// Lazy import to avoid circular dependency
let scheduleAutoExport: (() => void) | null = null;

export async function triggerAutoExport(): Promise<void> {
  if (!scheduleAutoExport) {
    try {
      const module = await import('./graph-export.js');
      scheduleAutoExport = module.scheduleAutoExport;
    } catch (error) {
      logWarn('graph-scheduler', 'Failed to import graph-export module for auto-export', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Graph export not available, ignore
      return;
    }
  }
  scheduleAutoExport?.();
}
