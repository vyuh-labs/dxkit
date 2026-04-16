import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default suite = unit tests only. Slow integration tests live under
    // test/integration/ and run via `npm run test:integration` (or in CI).
    include: ['test/**/*.test.ts'],
    exclude: [
      'node_modules/**',
      'dist/**',
      'templates/**',
      'src-templates/**',
      'test/fixtures/**',
      'test/integration/**',
    ],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/analyzers/tools/default-exclusions.gitignore'],
    },
  },
});
