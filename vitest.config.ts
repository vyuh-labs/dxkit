import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default suite = unit tests + fast integration tests. Integration tests
    // share analyzer output via beforeAll so the whole suite runs in ~20s.
    // `npm run test:integration` still available to run integration only.
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'templates/**', 'src-templates/**', 'test/fixtures/**'],
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
