import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    projects: [
      {
        // Main project — vmThreads for most tests
        test: {
          name: 'main',
          include: ['src/**/*.test.ts', 'dist/**/*.test.js'],
          exclude: ['node_modules', 'dist/node_modules', '**/ort-session.test.*'],
          pool: 'vmThreads',
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
