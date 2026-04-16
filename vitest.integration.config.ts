import { defineConfig } from 'vitest/config';

/**
 * Integration test config. Runs only `test/integration/` tests, which shell
 * out to real tools (gitleaks, jscpd, eslint, npm-audit) against a temp repo.
 *
 * Slow (~80s). Not part of the default `vitest run` suite — run via
 * `npm run test:integration` or in CI before merges to main.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 120000,
  },
});
