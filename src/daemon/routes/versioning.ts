/**
 * API Versioning — add /v1/ prefix to daemon routes.
 *
 * Phase 5.2: Maps /v1/api/* → /api/* for all existing routes.
 * Old routes remain for backward compatibility.
 * Future breaking changes go under /v2/.
 */

import type { RouteMap } from './types.js';

/** Current API version */
export const API_VERSION = 'v1';

/**
 * Add versioned route aliases (/v1/api/...) for all /api/ routes.
 * Original routes are preserved for backward compatibility.
 *
 * @param routes - Original route map
 * @returns Route map with both original and versioned routes
 */
export function addVersionedRoutes(routes: RouteMap): RouteMap {
  const versioned: RouteMap = {};

  for (const [key, handler] of Object.entries(routes)) {
    // Parse "METHOD /path"
    const spaceIdx = key.indexOf(' ');
    if (spaceIdx === -1) continue;

    const method = key.substring(0, spaceIdx);
    const path = key.substring(spaceIdx + 1);

    // Add /v1 prefix for /api/* routes
    if (path.startsWith('/api/')) {
      const versionedKey = `${method} /${API_VERSION}${path}`;
      versioned[versionedKey] = handler;
    }
  }

  return { ...routes, ...versioned };
}

/**
 * Get the API version info response.
 */
export function getApiVersionInfo(): {
  current: string;
  supported: string[];
  deprecation: Record<string, string>;
} {
  return {
    current: API_VERSION,
    supported: [API_VERSION],
    deprecation: {},
  };
}
