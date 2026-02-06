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
    } catch {
      // Graph export not available, ignore
      return;
    }
  }
  scheduleAutoExport?.();
}
