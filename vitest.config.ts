import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default suite = unit tests + fast integration tests. Integration tests
    // share analyzer output via beforeAll so the whole suite runs in ~20s.
    // `npm run test:integration` still available to run integration only.
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'templates/**', 'src-templates/**', 'test/fixtures/**'],
    // 180s default: cross-ecosystem.test.ts shells out to pip-audit /
    // govulncheck / cargo-audit / dotnet, which hit the npm / pypi /
    // crates.io / nuget registries. 60s was tight on cold-cache /
    // resource-constrained machines (cargo-audit + pip-audit both
    // observed >60s on WSL2 with concurrent VSCode tsservers). Unit
    // tests are unaffected — they fail fast on assertion errors; only
    // hangs care about the timeout.
    testTimeout: 180000,
    // pool: 'forks' instead of vitest 3.x default 'threads' — the
    // threads-pool birpc channel between worker and main starves under
    // heavy concurrent subprocess fan-out (cross-ecosystem.test.ts
    // spawns ~10+ network-bound child processes), surfacing as
    // "Timeout calling onTaskUpdate" unhandled errors that fail the
    // test process even when every assertion passes (vitest #8164,
    // documented mitigation in cross-ecosystem.test.ts header).
    // Forks isolates each test file in its own child node process —
    // ~50ms startup overhead per file vs threads, but no RPC starvation.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/analyzers/tools/default-exclusions.gitignore'],
    },
  },
});
