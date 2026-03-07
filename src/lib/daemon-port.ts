/**
 * Stable daemon port — deterministic port from project path hash.
 *
 * Used by HTTP hooks (settings.json URLs are static, so port must be predictable).
 * Config override: `daemon.port` in config.json.
 */

import { createHash } from 'crypto';

/** Port range: 18000–27999 (10,000 ports, above ephemeral range) */
const PORT_RANGE_START = 18000;
const PORT_RANGE_SIZE = 10000;

/**
 * Compute a deterministic port from a project directory path.
 * Same project always gets the same port (unless config overrides it).
 */
export function getStablePort(projectDir: string): number {
  const normalized = projectDir.toLowerCase().replace(/\\/g, '/');
  const hash = createHash('sha256').update(normalized).digest();
  return PORT_RANGE_START + (hash.readUInt16BE(0) % PORT_RANGE_SIZE);
}
