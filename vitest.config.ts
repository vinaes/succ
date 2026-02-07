import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Increase timeout for slow tests
    testTimeout: 30000,
    // Include TypeScript test files
    include: ['src/**/*.test.ts', 'dist/**/*.test.js'],
    // Exclude node_modules
    exclude: ['node_modules', 'dist/node_modules'],
    // Use vmThreads pool — forks pool has kill EPERM on Windows (Vitest 4.x)
    pool: 'vmThreads',
  },
});
