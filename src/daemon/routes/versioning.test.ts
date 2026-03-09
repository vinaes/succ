import { describe, it, expect } from 'vitest';
import { addVersionedRoutes, getApiVersionInfo, API_VERSION } from './versioning.js';
import type { RouteMap } from './types.js';

describe('API versioning', () => {
  it('should add /v1 prefix for /api/ routes', () => {
    const routes: RouteMap = {
      'GET /api/status': async () => ({ ok: true }),
      'POST /api/remember': async () => ({ id: 1 }),
      'GET /health': async () => ({ status: 'ok' }),
    };

    const versioned = addVersionedRoutes(routes);

    // Original routes preserved
    expect(versioned['GET /api/status']).toBeDefined();
    expect(versioned['POST /api/remember']).toBeDefined();
    expect(versioned['GET /health']).toBeDefined();

    // Versioned aliases added
    expect(versioned['GET /v1/api/status']).toBeDefined();
    expect(versioned['POST /v1/api/remember']).toBeDefined();

    // Non-api routes don't get versioned
    expect(versioned['GET /v1/health']).toBeUndefined();
  });

  it('versioned route should call same handler as original', async () => {
    const handler = async () => ({ result: 42 });
    const routes: RouteMap = {
      'GET /api/test': handler,
    };

    const versioned = addVersionedRoutes(routes);
    expect(versioned['GET /v1/api/test']).toBe(handler);
  });

  it('should not duplicate if route already exists', () => {
    const routes: RouteMap = {
      'GET /api/status': async () => ({ ok: true }),
    };

    const versioned = addVersionedRoutes(routes);
    const keys = Object.keys(versioned);

    // Should have exactly 2: original + versioned
    expect(keys.filter((k) => k.includes('/api/status'))).toHaveLength(2);
  });

  it('API_VERSION should be v1', () => {
    expect(API_VERSION).toBe('v1');
  });

  it('getApiVersionInfo should return version info', () => {
    const info = getApiVersionInfo();
    expect(info.current).toBe('v1');
    expect(info.supported).toContain('v1');
    expect(info.deprecation).toEqual({});
  });
});
