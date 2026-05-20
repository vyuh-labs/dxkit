import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default suite = unit tests only. The slow integration test lives
    // under `test/integration/` and runs via `npm run test:integration`
    // (its own config). Excluded here so the local push gate, which
    // runs the default suite under coverage instrumentation, stays
    // well under 5 minutes — integration's full-pipeline shell-outs
    // (license-checker, semgrep, jscpd, graphify, gitleaks) compound
    // with v8 coverage's per-import overhead and historically pushed
    // the gate past vitest's internal worker-IPC timeouts. CI runs
    // the integration suite as a separate step (`.github/workflows/
    // ci.yml`) so PRs still validate it.
    include: ['test/**/*.test.ts'],
    exclude: [
      'node_modules/**',
      'dist/**',
      'templates/**',
      'src-templates/**',
      'test/fixtures/**',
      'test/integration/**',
    ],
    // 300s default: cross-ecosystem.test.ts shells out to pip-audit /
    // govulncheck / cargo-audit / dotnet, which hit the npm / pypi /
    // crates.io / nuget registries. 60s was tight on cold-cache /
    // resource-constrained machines (cargo-audit + pip-audit both
    // observed >60s on WSL2 with concurrent VSCode tsservers). The
    // baseline integration tests in test/baseline/{check,create}.test.ts
    // were observed at 175-228s under concurrent WSL2 load (VSCode
    // language servers + browser + dxkit subprocesses), pushing them
    // past a 180s ceiling on the wrong side of the headroom. 300s
    // covers both registry-bound and load-induced variance. Unit
    // tests are unaffected — they fail fast on assertion errors; only
    // hangs care about the timeout.
    testTimeout: 300000,
    // Match testTimeout for hooks. Default vitest hookTimeout is 10s,
    // which is too short for the C# `beforeAll` blocks that run
    // `dotnet restore` against a cold NuGet cache (observed: 2026-04-28
    // baseline run before 10k.1 work, both csharp + csharp-multi suites
    // timed out at the 10s default). Same network/cold-cache risk
    // applies to any future beforeAll that pre-warms a toolchain
    // (cargo fetch, pip install, gradle wrapper download).
    hookTimeout: 300000,
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
