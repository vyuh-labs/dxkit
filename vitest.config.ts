import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default suite = unit tests + fast integration tests. Integration tests
    // share analyzer output via beforeAll so the whole suite runs in ~20s.
    // `npm run test:integration` still available to run integration only.
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'templates/**', 'src-templates/**', 'test/fixtures/**'],
    // 60s default: cross-ecosystem.test.ts shells out to pip-audit /
    // govulncheck / cargo-audit / dotnet, which hit the npm / pypi /
    // crates.io / nuget registries. 30s was tight enough to flake on
    // slow-network days (pip-audit observed at 27-34s on the
    // requests@2.20.0 fixture). Unit tests are unaffected — they fail
    // fast on assertion errors; only hangs care about the timeout.
    testTimeout: 60000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/analyzers/tools/default-exclusions.gitignore'],
    },
  },
});
