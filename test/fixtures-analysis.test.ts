/**
 * Fixture-repo ANALYSIS harness — the analysis analog of the install/uninstall
 * lifecycle net (`test/lifecycle/`). It exists because a whole CLASS of bugs
 * kept reaching users: a fix landed in one code path but not its sibling, and
 * dxkit's own self-guardrail could not catch it — dxkit's repo has no
 * `.env.example`, no base-URL-helper flow calls, no catch-all routes, so the
 * dogfood gate is BLIND to the shapes real repos have.
 *
 * This harness runs dxkit's USER-FACING analysis (the same gather functions the
 * scan / baseline / flow surfaces call) on a MATRIX of minimal per-stack
 * fixtures, and asserts cross-cutting invariants. It is deliberately NOT a
 * single Payload/Next.js fixture — the language-agnostic invariants
 * (`.env.example` is not a finding; a placeholder secret is dropped) are
 * asserted on TS, Python, AND Go, so a fix that only works for one stack fails
 * here. Flow-specific invariants run on the flow-capable pack (TS today); a new
 * language pack (M6) adds a fixture dir + a row and inherits the checks.
 *
 * Each fixture is copied to a throwaway git repo (env-in-git needs `git
 * ls-files`), then the gathers run in-process.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, renameSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { gatherFileFindings } from '../src/analyzers/security/gather';
import { gatherGrepSecretsResult } from '../src/analyzers/tools/grep-secrets';
import { gatherRepoFlowModel } from '../src/analyzers/flow/gather';
import { summarize } from '../src/analyzers/flow/model';
import { buildReachable } from '../src/analyzers/tests/import-graph';

const FIXTURES = join(__dirname, 'fixtures', 'analysis');

// Files that must live at a gitignored path (`.env.example`, `.dxkit/policy.json`)
// are COMMITTED under a non-ignored marker name and materialized into the staged
// copy. Committing them directly is impossible — dxkit's `.gitignore` excludes
// `.env.*` and `test/fixtures/**/.dxkit/` — and that is exactly how this test
// once passed locally (files on disk) but failed / falsely-passed in CI (files
// never committed). See also the `no fixture is gitignored` guard below.
const MATERIALIZE: Array<{ marker: string; target: string }> = [
  { marker: 'env.example', target: '.env.example' },
  { marker: 'dxkit-policy.json', target: '.dxkit/policy.json' },
];

/** Copy a fixture into a throwaway git repo (env-in-git needs tracked files). */
function stageFixture(stack: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dxkit-analysis-${stack}-`));
  cpSync(join(FIXTURES, stack), dir, { recursive: true });
  for (const { marker, target } of MATERIALIZE) {
    const from = join(dir, marker);
    if (existsSync(from)) {
      mkdirSync(dirname(join(dir, target)), { recursive: true });
      renameSync(from, join(dir, target));
    }
  }
  const git = (...a: string[]) =>
    execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

// Every stack in the matrix. `flow: true` marks the flow-capable packs whose
// route/call resolution is additionally asserted.
const STACKS: Array<{ stack: string; flow?: boolean }> = [
  { stack: 'ts-webapp', flow: true },
  { stack: 'python-svc' },
  { stack: 'go-svc' },
];

const staged: Record<string, string> = {};
beforeAll(() => {
  for (const { stack } of STACKS) staged[stack] = stageFixture(stack);
  return () => {
    for (const dir of Object.values(staged)) rmSync(dir, { recursive: true, force: true });
  };
});

describe('analysis fixtures — the fixtures actually reach CI', () => {
  it('no fixture file is gitignored (else it vanishes in CI and the test false-passes)', () => {
    // This is the guard for the trap that broke this very suite: a fixture at a
    // gitignored path (`.env.example`, `.dxkit/`) exists on the author's disk
    // but was never committed, so CI scanned a fixture that was missing files —
    // the flow test failed and the env test passed for the wrong reason. Any
    // path that must be gitignored is committed as a marker and materialized at
    // stage time (see MATERIALIZE); nothing under the fixtures tree may be
    // ignored.
    const repoRoot = join(__dirname, '..');
    const ignored = execFileSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--', 'test/fixtures/analysis'],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    expect(ignored, `gitignored fixture files (would not reach CI):\n${ignored}`).toBe('');
  });
});

describe('analysis fixtures — language-agnostic invariants (every stack)', () => {
  for (const { stack } of STACKS) {
    it(`${stack}: a committed .env.example is NOT an env-in-git finding`, () => {
      const findings = gatherFileFindings(staged[stack]);
      const envInGit = findings.filter((f) => f.rule === 'env-in-git');
      expect(envInGit.map((f) => f.file)).not.toContain('.env.example');
      // The only env file here IS the example — so there should be no finding.
      expect(envInGit).toHaveLength(0);
    });

    it(`${stack}: placeholder secret values are dropped, not flagged`, () => {
      const result = gatherGrepSecretsResult(staged[stack]);
      expect(result).not.toBeNull();
      // `password: 'password'` / `api_key = 'your-api-key'` are placeholders.
      expect(result!.findings).toHaveLength(0);
      expect(result!.suppressedCount).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('analysis fixtures — test-gap import-graph credits non-relative imports', () => {
  // The recurring class this guards: the import-graph resolver was blind to
  // non-relative specifiers, so an integration test that imports the module
  // under test by alias (TS `@/…`) or src-layout absolute path (Python
  // `authz.access`) produced NO edge — and the test-gap analyzer flagged the
  // exercised file as an untested gap. dxkit's own repo uses only relative
  // imports, so its self-guardrail is structurally blind to this shape (the
  // 2.30 class). These fixtures make the aliased / src-rooted shape visible.

  it('ts-webapp: an @/-aliased import from an int test resolves an edge to the source file', async () => {
    const reached = await buildReachable(['tests/int/access.int.spec.ts'], staged['ts-webapp']);
    // Without tsconfig `paths` awareness the alias would not resolve and the
    // set would not contain the source file.
    expect([...reached]).toContain('src/authz/access.ts');
  });

  it('python-svc: a src-layout absolute import from an int test resolves an edge to the source file', async () => {
    const reached = await buildReachable(['tests/int/test_access.py'], staged['python-svc']);
    // Without `src/`-root awareness the absolute import would anchor at the
    // project root only, miss `src/authz/access.py`, and leave it a gap.
    expect([...reached]).toContain('src/authz/access.py');
  });
});

describe('analysis fixtures — flow resolution (flow-capable packs)', () => {
  for (const { stack, flow } of STACKS.filter((s) => s.flow)) {
    it(`${stack}: base-URL-helper calls resolve via policy stripUrlPrefixes + catch-all`, async () => {
      // The user-facing surface loads .dxkit/policy.json:flow.stripUrlPrefixes
      // itself. Both calls use `${getClientSideURL()}`, which the policy strips,
      // then bind the served catch-all `app/(payload)/api/[...slug]/route.ts`.
      void flow;
      const model = await gatherRepoFlowModel(staged[stack]);
      const s = summarize(model);
      expect(s.calls).toBe(2);
      expect(s.unresolved).toBe(0); // 0/4 unresolved — the last-mile of flow correctness
    });
  }
});
