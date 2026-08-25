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
 * here. Flow-specific invariants run on every flow-capable pack (TS + Python
 * today); a new language pack adds a fixture dir + a row and inherits the
 * checks — the flow rows additionally pin that stack's served/consumed forms.
 *
 * Each fixture is copied to a throwaway git repo (env-in-git needs `git
 * ls-files`), then the gathers run in-process.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { gatherFileFindings } from '../src/analyzers/security/gather';
import { gatherGrepSecretsResult } from '../src/analyzers/tools/grep-secrets';
import { gatherHygieneMarkers } from '../src/analyzers/quality/gather';
import { gatherRepoFlowModel } from '../src/analyzers/flow/gather';
import { gatherRepoModelSet } from '../src/analyzers/model-schema/gather';
import { summarize } from '../src/analyzers/flow/model';
import { buildReachable } from '../src/analyzers/tests/import-graph';
import { trustedLocalContext } from '../src/analysis-trust';
import { createBaseline } from '../src/baseline/create';
import { runGuardrailCheck } from '../src/baseline/check';
import { CONFIDENCE_CONTENT_HASH_SAME_FILE } from '../src/baseline/git-aware-match';
import { isSanitized } from '../src/baseline/sanitize';

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
  // Stale-suffix targets are committed under marker names for TWO reasons:
  // node_modules/ is gitignored repo-wide, and a tracked `*.orig` would be
  // flagged by dxkit's own self-guardrail hygiene scan.
  { marker: 'nm-lookup-orig.marker', target: 'node_modules/cldr/dist/lookup.js.orig' },
  { marker: 'src-legacy-orig.marker', target: 'src/legacy.js.orig' },
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

// Every stack in the matrix. `flow` marks the flow-capable packs whose
// route/call resolution is additionally asserted, with the stack's expected
// consumed-call count (every one of which must resolve — 0 unresolved is the
// last-mile of flow correctness on every flow-capable stack, not just TS).
const STACKS: Array<{ stack: string; flow?: { calls: number } }> = [
  { stack: 'ts-webapp', flow: { calls: 2 } },
  { stack: 'python-svc', flow: { calls: 4 } },
  { stack: 'go-svc', flow: { calls: 3 } },
  { stack: 'java-svc', flow: { calls: 2 } },
  { stack: 'kotlin-svc', flow: { calls: 2 } },
  { stack: 'csharp-svc', flow: { calls: 2 } },
  { stack: 'ruby-svc', flow: { calls: 2 } },
  { stack: 'rust-svc', flow: { calls: 2 } },
  // No flow row: a uv-workspace monorepo (nested member with src/ layout,
  // distribution name != import name, member-prefixed test basenames) — the
  // environment shape the #219/#223 class was structurally blind to. The
  // language-agnostic invariants run here like everywhere; the import-graph
  // association is additionally pinned below.
  { stack: 'python-uv' },
  // No flow row: the swift pack declares no httpFlow (iOS apps consume APIs
  // through URLSession wrappers a v1 descriptor can't resolve honestly).
  { stack: 'swift-app' },
  // No flow row: the php pack declares no httpFlow yet (framework routing —
  // Laravel/Symfony attribute routes — is a follow-up descriptor wave).
  { stack: 'php-app' },
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
    )
      .trim()
      .split('\n')
      // Regenerable BUILD OUTPUT inside a fixture is deliberately ignored
      // (SwiftPM's .build/ from a local floor-verification run) — it is not
      // fixture content, and CI never has it. The guard is about SOURCE
      // files silently failing to reach CI.
      .filter((f) => f && !f.includes('/.build/'))
      .join('\n');
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

  it('ts-webapp: a tracked .orig under node_modules is NOT a stale file; one in src/ IS (T2.2)', () => {
    // The rollout bug: a repo with node_modules committed to git got
    // `node_modules/**/*.orig` flagged as net-new stale files (its baseline
    // install tree differed from CI's `npm ci` tree). Stale-file discovery
    // must consult the ONE exclusion source (Rule 4). The src/ control pins
    // that the filter is exclusion-scoped, not suffix-dead.
    const { staleFiles } = gatherHygieneMarkers(staged['ts-webapp']);
    expect(staleFiles.some((f) => f.startsWith('node_modules/'))).toBe(false);
    expect(staleFiles).toContain('src/legacy.js.orig');
  });
});

describe('analysis fixtures — model-schema extraction (marker-based, every stack)', () => {
  // The language-agnostic invariants: a MARKED model extracts with its
  // optionality forms normalized; an unmarked helper next to it stays
  // invisible (precision over recall — the capability's documented posture).
  // One matrix, three stacks: a fix that only works for one framework
  // overfits and fails here.
  const MODEL_ROWS: Array<{
    stack: string;
    expected: string[];
    optionalField: { model: string; field: string };
    invisible: string;
  }> = [
    {
      stack: 'ts-webapp',
      expected: ['User'],
      optionalField: { model: 'User', field: 'nick' }, // `?` marker
      invisible: 'UserMapper',
    },
    {
      stack: 'python-svc',
      expected: ['Article', 'ArticleDto'],
      optionalField: { model: 'Article', field: 'summary' }, // null=True
      invisible: 'ArticleIndexer',
    },
    {
      stack: 'go-svc',
      expected: ['Report'],
      optionalField: { model: 'Report', field: 'note' }, // pointer + omitempty
      invisible: 'reportCache',
    },
    {
      stack: 'java-svc',
      expected: ['Report'],
      optionalField: { model: 'Report', field: 'note' }, // @Column(nullable = true)
      invisible: 'ReportIndexer',
    },
    {
      stack: 'kotlin-svc',
      expected: ['Item'],
      optionalField: { model: 'Item', field: 'note' }, // String? marker
      invisible: 'ItemIndexer',
    },
    {
      stack: 'csharp-svc',
      // Order via [Table] (its two PARTIAL declarations assemble into one
      // entity); Customer via the DbSet<Customer> container reference.
      expected: ['Order', 'Customer'],
      optionalField: { model: 'Order', field: 'Note' }, // string? marker
      invisible: 'OrderMapper',
    },
    {
      stack: 'ruby-svc',
      // The db/schema.rb table is the entity (name = the wire contract)…
      expected: ['articles'],
      optionalField: { model: 'articles', field: 'summary' }, // absent null: ⇒ nullable
      // …and the ActiveRecord class is demoted to discovery while it exists.
      invisible: 'Article',
    },
    {
      stack: 'rust-svc',
      expected: ['Report'],
      optionalField: { model: 'Report', field: 'note' }, // Option<String>
      invisible: 'ReportCache',
    },
  ];

  for (const row of MODEL_ROWS) {
    it(`${row.stack}: marked models extract, helpers stay invisible, optionality normalizes`, async () => {
      const set = await gatherRepoModelSet(staged[row.stack]);
      const names = set.models.map((m) => m.name);
      for (const name of row.expected) expect(names, `missing model ${name}`).toContain(name);
      expect(names).not.toContain(row.invisible);
      const model = set.models.find((m) => m.name === row.optionalField.model)!;
      const field = model.fields.find((f) => f.name === row.optionalField.field);
      expect(field, `${row.optionalField.model}.${row.optionalField.field}`).toBeDefined();
      expect(field!.required).toBe(false);
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

  it('python-uv: a workspace-member src-layout import from a member-prefixed test resolves', async () => {
    // The #223 shape: `packages/acme-platform/tests/test_acme_platform_util.py`
    // imports `acme.util` — the filename heuristic can never associate the
    // prefixed basename with `util.py`, so without member-root awareness the
    // module reads as untested and the phantom gap gets grandfathered.
    const reached = await buildReachable(
      ['packages/acme-platform/tests/test_acme_platform_util.py'],
      staged['python-uv'],
    );
    expect([...reached]).toContain('packages/acme-platform/src/acme/util.py');
  });
});

describe('analysis fixtures — flow resolution (flow-capable packs)', () => {
  for (const { stack, flow } of STACKS.filter((s) => s.flow)) {
    it(`${stack}: every consumed call resolves against the stack's served surface`, async () => {
      // The user-facing surface loads .dxkit/policy.json:flow config itself
      // (ts-webapp: stripUrlPrefixes + the [...slug] catch-all; python-svc:
      // FastAPI decorators + Flask methods-kwarg + a Django ANY route).
      const model = await gatherRepoFlowModel(staged[stack], { trust: trustedLocalContext() });
      const s = summarize(model);
      expect(s.calls).toBe(flow!.calls);
      expect(s.unresolved).toBe(0); // the last-mile of flow correctness
    });
  }

  it('python-svc: the three Python served forms + coverage honesty hold end-to-end', async () => {
    const model = await gatherRepoFlowModel(staged['python-svc'], { trust: trustedLocalContext() });
    const served = model.routes.map((r) => `${r.method} ${r.path}`).sort();
    // FastAPI member decorators, Flask methods-kwarg (one route per verb),
    // Django path() as ANY — and the include('admin/') mount mints NOTHING.
    expect(served).toEqual([
      'ANY /reports/{var}',
      'GET /items/{var}',
      'GET /legacy',
      'POST /legacy',
      'POST /users',
    ]);
    // A PUT against the Django route resolves via the ANY rule.
    const put = model.bindings.find((b) => b.call.method === 'PUT');
    expect(put?.route?.path).toBe('/reports/{var}');
    // The runtime-built requests.get(url) is DISCLOSED as dynamic, not dropped.
    expect(model.dynamicCalls).toHaveLength(1);
    expect(model.dynamicCalls[0].receiver).toBe('requests');
  });

  it('go-svc: stdlib registrars + 1.22 patterns + chi verbs + coverage honesty hold end-to-end', async () => {
    const model = await gatherRepoFlowModel(staged['go-svc'], { trust: trustedLocalContext() });
    const served = model.routes.map((r) => `${r.method} ${r.path}`).sort();
    // Plain HandleFunc → ANY; 1.22 "GET /…" patterns → concrete verbs with
    // {id} canonicalized; the chi-style r.Post rides routeRouterCallees.
    expect(served).toEqual([
      'ANY /healthz',
      'GET /reports/export',
      'GET /reports/{var}',
      'POST /reports',
    ]);
    // A GET against the plain HandleFunc route resolves via the ANY rule, and
    // the NewRequest constructor binds like any member client call.
    const byPath = Object.fromEntries(model.bindings.map((b) => [b.call.path, b]));
    expect(byPath['/healthz']?.route?.path).toBe('/healthz');
    expect(byPath['/reports/export']?.route?.method).toBe('GET');
    // The runtime-built http.Get(url) is DISCLOSED as dynamic, not dropped.
    expect(model.dynamicCalls).toHaveLength(1);
    expect(model.dynamicCalls[0].receiver).toBe('http');
  });

  it('java-svc: Spring class prefix + builder chain + enum-verb exchange hold end-to-end', async () => {
    const model = await gatherRepoFlowModel(staged['java-svc'], { trust: trustedLocalContext() });
    const served = model.routes.map((r) => `${r.method} ${r.path}`).sort();
    // Class-level @RequestMapping("/api/reports") prefixes both handlers —
    // the marker @PostMapping is the prefix alone; the class annotation
    // itself minted NO route.
    expect(served).toEqual(['GET /api/reports/{var}', 'POST /api/reports']);
    // getForObject binds the GET; the WebClient chain binds the POST.
    const byMethod = Object.fromEntries(model.bindings.map((b) => [b.call.method, b]));
    expect(byMethod['GET']?.route?.path).toBe('/api/reports/{var}');
    expect(byMethod['POST']?.route?.path).toBe('/api/reports');
    // exchange(url, HttpMethod.GET, …) — enum verb, runtime URL — is
    // DISCLOSED as dynamic, never silently dropped.
    expect(model.dynamicCalls).toHaveLength(1);
    expect(model.dynamicCalls[0].receiver).toBe('restTemplate');
  });

  it('kotlin-svc: Ktor DSL nesting + $id templates + coverage honesty hold end-to-end', async () => {
    const model = await gatherRepoFlowModel(staged['kotlin-svc'], { trust: trustedLocalContext() });
    const served = model.routes.map((r) => `${r.method} ${r.path}`).sort();
    // route("/api") { … } prefixes the nested verbs; the top-level get
    // stays unprefixed; {id} and $id both canonicalize to {var}.
    expect(served).toEqual(['GET /api/items/{var}', 'GET /healthz', 'POST /api/items']);
    const byMethod = Object.fromEntries(model.bindings.map((b) => [b.call.method, b]));
    expect(byMethod['GET']?.route?.path).toBe('/api/items/{var}');
    expect(byMethod['POST']?.route?.path).toBe('/api/items');
    // The runtime-built client.get(url) is DISCLOSED as dynamic.
    expect(model.dynamicCalls).toHaveLength(1);
    expect(model.dynamicCalls[0].receiver).toBe('client');
  });

  it('csharp-svc: the [controller] token + attribute pairs + coverage honesty hold end-to-end', async () => {
    const model = await gatherRepoFlowModel(staged['csharp-svc'], { trust: trustedLocalContext() });
    const served = model.routes.map((r) => `${r.method} ${r.path}`).sort();
    // [Route("api/[controller]")] substitutes the class name (never an
    // over-matching {var}); the marker [HttpPost] serves the prefix alone.
    expect(served).toEqual(['GET /api/reports/{var}', 'POST /api/reports']);
    const byMethod = Object.fromEntries(model.bindings.map((b) => [b.call.method, b]));
    // The interpolated $"/api/reports/{id}" binds the GET; PostAsync the POST.
    expect(byMethod['GET']?.route?.path).toBe('/api/reports/{var}');
    expect(byMethod['POST']?.route?.path).toBe('/api/reports');
    // The runtime-built client.GetAsync(BuildUrl()) is DISCLOSED as dynamic.
    expect(model.dynamicCalls).toHaveLength(1);
    expect(model.dynamicCalls[0].receiver).toBe('client');
  });

  it('ruby-svc: resources expansion + draw qualifiers + coverage honesty hold end-to-end', async () => {
    const model = await gatherRepoFlowModel(staged['ruby-svc'], { trust: trustedLocalContext() });
    const served = model.routes.map((r) => `${r.method} ${r.path}`).sort();
    // resources :articles, only: [:index, :create] under namespace :api →
    // exactly two routes with the /api prefix; the explicit get qualifies
    // via its to: binding + draw ancestry.
    expect(served).toEqual(['GET /api/articles', 'GET /health', 'POST /api/articles']);
    const byMethod = Object.fromEntries(model.bindings.map((b) => [b.call.method, b]));
    expect(byMethod['GET']?.route?.path).toBe('/api/articles');
    expect(byMethod['POST']?.route?.path).toBe('/api/articles');
    // The runtime-built HTTParty.get(url) is DISCLOSED as dynamic.
    expect(model.dynamicCalls).toHaveLength(1);
    expect(model.dynamicCalls[0].receiver).toBe('HTTParty');
  });

  it('rust-svc: axum nest argument-side prefixing + ANY routes + coverage honesty hold end-to-end', async () => {
    const model = await gatherRepoFlowModel(staged['rust-svc'], { trust: trustedLocalContext() });
    const served = model.routes.map((r) => `${r.method} ${r.path}`).sort();
    // .nest("/api", …) prefixes ONLY its argument router; the chain-link
    // /healthz sibling stays unprefixed; .route mints ANY routes.
    expect(served).toEqual(['ANY /api/reports', 'ANY /api/reports/{var}', 'ANY /healthz']);
    const byPath = Object.fromEntries(model.bindings.map((b) => [b.call.path, b]));
    // A concrete /api/reports/1 resolves against the {var} route (the ANY
    // rule + var matching), and the scoped reqwest::get binds /healthz.
    expect(byPath['/api/reports/1']?.route?.path).toBe('/api/reports/{var}');
    expect(byPath['/healthz']?.route?.path).toBe('/healthz');
    // The format!-built URL is DISCLOSED as dynamic.
    expect(model.dynamicCalls).toHaveLength(1);
    expect(model.dynamicCalls[0].receiver).toBe('client');
  });
});

describe('analysis fixtures: identity survives a whole-file reformat (custom-check content hash)', () => {
  // The class this guards: a repo with a grandfathered lint backlog reindents
  // one file. Every finding moves past the 3-line identity window AND every
  // line is rewritten in the diff, so neither the fingerprint nor the git line
  // map can pair a finding with its moved self. Only the content-hash pass
  // (whitespace-normalized) can, and it only fires when the producer stamped a
  // hash on BOTH sides. Before the shared stamper, custom-check entries carried
  // none, so a reformat read as "resolved" for the whole backlog plus
  // "net-new" for every finding the diff happened to touch. dxkit's own repo
  // has no custom-check backlog, so the self-guardrail cannot see this shape.
  // Not in STACKS: this fixture exists for the gate, not the per-stack
  // invariants, and it is staged on demand to keep the matrix cheap.
  const FIXTURE = 'ts-lint-backlog';
  const FILE = 'src/legacy.ts';
  let dir: string;
  const vcs = (...a: string[]) =>
    execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  const commitTree = (message: string) => {
    vcs('add', '-A');
    vcs('commit', '-qm', message);
  };
  const reformat = (src: string) =>
    src
      .replace(/\n\n\n/g, '\n\n')
      .split('\n')
      .map((l) => l.replace(/^( {4})+/, (m) => ' '.repeat(m.length / 2)))
      .join('\n');
  const customCheckPairs = (result: Awaited<ReturnType<typeof runGuardrailCheck>>) =>
    result.pairs.filter((p) => p.kind === 'custom-check');

  beforeAll(() => {
    dir = stageFixture(FIXTURE);
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it('a reindent of a file with a lint backlog yields zero net-new custom-check findings end-to-end', async () => {
    const created = await createBaseline({ cwd: dir });
    const entries = (created.file?.findings ?? []).filter((f) => f.kind === 'custom-check');
    // The whole backlog is captured, located, and stamped on the baseline side.
    expect(entries.length).toBe(8);
    for (const e of entries) {
      expect(e.kind === 'custom-check' && !isSanitized(e) && e.file).toBe(FILE);
      expect(e.kind === 'custom-check' && !isSanitized(e) && e.contentHash).toMatch(
        /^[0-9a-f]{16}$/,
      );
    }
    // Commit the baseline (committed mode anchors on the tree), then reformat.
    commitTree('baseline');
    const before = readFileSync(join(dir, FILE), 'utf8');
    const after = reformat(before);
    expect(after).not.toBe(before);
    expect(after.split('\n').length).toBeLessThan(before.split('\n').length);
    writeFileSync(join(dir, FILE), after);
    commitTree('reformat: 4-space to 2-space, collapse double blanks');

    const result = await runGuardrailCheck({ trust: trustedLocalContext(), cwd: dir });
    const pairs = customCheckPairs(result);
    expect(pairs.length).toBe(8);
    expect(pairs.filter((p) => p.classification.status === 'added')).toEqual([]);
    expect(pairs.filter((p) => p.classification.status === 'removed')).toEqual([]);
    expect(pairs.every((p) => p.classification.blocks === false)).toBe(true);
    // Seven findings sit on reindented lines: the diff rewrote them, so the
    // git line map has no image and only the content pass can pair them. The
    // eighth (`function debugLog(`) is unindented, so git maps it directly.
    // A SAME-FILE content pair carries the 0.90 tier, which clears every
    // default per-severity threshold: the whole backlog reads PERSISTED,
    // never `uncertain`, never `added`, never a block.
    const byContent = pairs.filter((p) =>
      p.classification.reasons.some((r) => r.code === 'content-hash'),
    );
    expect(byContent.length).toBe(7);
    for (const p of byContent) {
      expect(p.pair.confidence).toBe(CONFIDENCE_CONTENT_HASH_SAME_FILE);
      expect(p.classification.status).toBe('persisted');
    }
    expect(pairs.length - byContent.length).toBe(1);

    // The negative: a genuinely new call after the reformat is still net-new,
    // and the ones that moved stay grandfathered. Appended past every existing
    // finding's context window, so nothing else changes identity.
    writeFileSync(
      join(dir, FILE),
      readFileSync(join(dir, FILE), 'utf8') +
        "\nexport function extra(): void {\n  debugLog('extra');\n}\n",
    );
    commitTree('introduce a new debugLog call');
    const again = await runGuardrailCheck({ trust: trustedLocalContext(), cwd: dir });
    const added = customCheckPairs(again).filter((p) => p.classification.status === 'added');
    expect(added.length).toBe(1);
    expect(added[0].classification.blocks).toBe(true);
    expect(customCheckPairs(again).filter((p) => p.classification.status === 'removed')).toEqual(
      [],
    );
  }, 120_000);
});
