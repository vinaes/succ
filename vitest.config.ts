import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    projects: [
      {
        // Main project — forks for full mock isolation between test files
        test: {
          name: 'main',
          testTimeout: 30000,
          hookTimeout: 30000,
          include: ['src/**/*.test.ts'],
          exclude: ['node_modules', '**/ort-session.test.*'],
          pool: 'forks',
        },
      },
      {
        // Native addon tests — forks pool required for onnxruntime-node .node bindings
        // vmThreads causes Float32Array realm mismatch with native addons
        test: {
          name: 'native',
          testTimeout: 30000,
          include: ['src/lib/ort-session.test.ts'],
          pool: 'forks',
        },
      },
    ],
  },
});
