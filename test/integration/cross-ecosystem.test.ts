/**
 * Cross-ecosystem integration tests (Phase 10h.6.8).
 *
 * These tests run dxkit's vulnerability scanner against committed
 * benchmark fixtures (`test/fixtures/benchmarks/{python,go,rust,csharp,
 * csharp-multi}/`) — projects with deliberately pinned vulnerable deps.
 * They validate the 2.4.1 hotfixes against real ecosystem-tool output:
 *
 *   - Python: pip-audit duplicates dedup'd; requirements.txt fallback
 *     for topLevelDep when no venv is present.
 *   - Rust: upgradePlan.parentVersion is a clean semver string, not
 *     a comma-separated range.
 *   - C# (single): dotnet's `vulnerabilities` + `advisoryurl` shape
 *     parsed correctly (was: `advisories` + `advisoryUrl` — wrong).
 *   - C# (multi): Phase 10h.6.7 merge logic surfaces vulns reachable
 *     through sibling projects (D003 fix).
 *   - Go: govulncheck integration produces findings (call-graph-driven;
 *     gin advisories surface only when reachable from source).
 *
 * Toolchain gating: each ecosystem's tests `skipIf` the relevant
 * binary is not on PATH. Locally, contributors without cargo / dotnet /
 * go / govulncheck / pip-audit see those tests skip with a clear
 * message; CI installs them all and runs the full matrix.
 *
 * Fixture setup: C# fixtures need `dotnet restore` to produce
 * `obj/project.assets.json`. That happens in `beforeAll` per-suite,
 * gated on `dotnet` availability. obj/ is gitignored (per .gitignore
 * rule for `test/fixtures/benchmarks/**\/obj/`); no committed
 * machine-specific paths.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures', 'benchmarks');
const DXKIT_BIN = path.join(REPO_ROOT, 'dist', 'index.js');

// Async shell-outs are required: vitest 3's worker→main birpc channel has
// a 60s `onTaskUpdate` ack timeout; sync execSync starves the runner
// thread and trips an unhandled error that fails the test process even
// when every test passes (vitest #8164). All long-running shell-outs in
// this suite go through `execAsync` so the worker stays responsive.
const execAsync = promisify(exec);

/**
 * Benchmark-fixture metadata table — the SINGLE SOURCE OF TRUTH for
 * which languages participate in the cross-ecosystem matrix and where
 * each fixture's deliberate findings live. Adding a 6th language is one
 * row append + one fixture dir + one CI toolchain install — no
 * search-and-replace across describe blocks.
 *
 * Each `matrix — <report>` describe block iterates this array. New
 * report types (lint, dup, untested, bom, licenses, quality, test-gaps,
 * dev-report) extend each row with one optional field — no new describe
 * patterns to invent.
 *
 * Table-driven by design:
 *   - `name` is the display name in test output ("Python", "C# (multi)")
 *   - `dir` is the path under `test/fixtures/benchmarks/`
 *   - `secret.file` is the path under `dir` containing the fake credential
 *   - Future fields land in 10i.0.2/.3/.4 sub-commits (lint, dup, untested)
 *
 * The 10i.0.5 parity gate parses this array + every `matrix — <report>`
 * describe block to verify every (report × language) cell has both
 * metadata + an iteration. Adding a new report = grow the table + add a
 * matrix describe; the gate auto-extends.
 */
interface BenchmarkLanguage {
  /** Display name shown in vitest test output. */
  name: string;
  /** Subdirectory under `test/fixtures/benchmarks/`. */
  dir: string;
  /** Phase 10i.0.1 — fake hardcoded secret fixture. */
  secret?: {
    /** Path under `dir` to the file containing the deliberate AWS key. */
    file: string;
  };
  /** Phase 10i.0.2 — fixture with one deliberate linter violation. */
  lint?: {
    /** Path under `dir` to the file containing the violation. */
    file: string;
    /** Expected `metrics.lintTool` reported by `dxkit quality`. */
    expectedTool:
      | 'ruff'
      | 'eslint'
      | 'golangci-lint'
      | 'clippy'
      | 'dotnet-format'
      | 'detekt'
      | 'pmd'
      | 'rubocop';
    /** External binary the linter shells out to (used for `it.skipIf` gating). */
    requires: string;
  };
  /** Phase 10i.0.3 — fixture with one deliberate code-clone pair. */
  dup?: {
    /** Path under `dir` to the file containing the two near-identical helpers. */
    file: string;
  };
  /** Phase 10i.0.4 — fixture with one deliberate untested source file. */
  untested?: {
    /** Path under `dir` to the source file with no matching test. */
    file: string;
  };
}

const BENCHMARK_LANGUAGES: readonly BenchmarkLanguage[] = [
  {
    name: 'Python',
    dir: 'python',
    secret: { file: 'secrets.py' },
    lint: { file: 'bad_lint.py', expectedTool: 'ruff', requires: 'ruff' },
    dup: { file: 'duplications.py' },
    untested: { file: 'untested_module.py' },
  },
  {
    name: 'Go',
    dir: 'go',
    secret: { file: 'secrets.go' },
    lint: { file: 'bad_lint.go', expectedTool: 'golangci-lint', requires: 'golangci-lint' },
    dup: { file: 'duplications.go' },
    untested: { file: 'untested_module.go' },
  },
  {
    name: 'Rust',
    dir: 'rust',
    secret: { file: 'src/secrets.rs' },
    lint: { file: 'src/bad_lint.rs', expectedTool: 'clippy', requires: 'cargo' },
    dup: { file: 'src/duplications.rs' },
    untested: { file: 'src/untested_module.rs' },
  },
  {
    name: 'C# (single)',
    dir: 'csharp',
    secret: { file: 'Secrets.cs' },
    lint: { file: 'BadLint.cs', expectedTool: 'dotnet-format', requires: 'dotnet' },
    dup: { file: 'Duplications.cs' },
    untested: { file: 'UntestedModule.cs' },
  },
  {
    name: 'C# (multi)',
    dir: 'csharp-multi',
    secret: { file: path.join('ProjectA', 'Secrets.cs') },
    lint: {
      file: path.join('ProjectA', 'BadLint.cs'),
      expectedTool: 'dotnet-format',
      requires: 'dotnet',
    },
    dup: { file: path.join('ProjectA', 'Duplications.cs') },
    untested: { file: path.join('ProjectA', 'UntestedModule.cs') },
  },
  {
    name: 'Kotlin',
    dir: 'kotlin',
    secret: { file: 'Secrets.kt' },
    // detekt is a JVM tool — `requires: 'java'` gates on the runtime
    // because `commandExists('detekt')` returns true even when the
    // detekt-cli wrapper exists but Java is missing (the wrapper would
    // then crash with "JAVA_HOME is not set"). CI installs Java 17
    // before running this matrix row.
    lint: { file: 'BadLint.kt', expectedTool: 'detekt', requires: 'java' },
    dup: { file: 'Duplications.kt' },
    untested: { file: 'UntestedModule.kt' },
  },
  {
    name: 'Java',
    dir: 'java',
    secret: { file: 'Secrets.java' },
    // PMD is the canonical Java linter for the 10k.1 pack (lighter
    // than spotbugs since it's source-level, no compiled .class
    // requirement). `requires: 'pmd'` skips the matrix row locally
    // and on CI until the pack's lint capability + the PMD CI
    // toolchain install land in subsequent 10k.1.x commits.
    lint: { file: 'BadLint.java', expectedTool: 'pmd', requires: 'pmd' },
    dup: { file: 'Duplications.java' },
    untested: { file: 'UntestedModule.java' },
  },
  {
    name: 'Ruby',
    dir: 'ruby',
    secret: { file: 'secrets.rb' },
    // RuboCop is the canonical Ruby linter for the 10k.2 pack.
    // `requires: 'rubocop'` skips the matrix row locally and on CI
    // until the pack's lint capability + the rubocop CI toolchain
    // install land in 10k.2.5.
    lint: { file: 'bad_lint.rb', expectedTool: 'rubocop', requires: 'rubocop' },
    dup: { file: 'duplications.rb' },
    untested: { file: 'untested_module.rb' },
  },
];

interface DepVulnFinding {
  id: string;
  package: string;
  installedVersion?: string;
  severity: string;
  topLevelDep?: string[];
  fingerprint?: string;
  upgradePlan?: { parent: string; parentVersion: string; patches: string[]; breaking: boolean };
  references?: string[];
  tool: string;
}

interface DepVulnSummary {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  findings: DepVulnFinding[];
}

interface SecurityFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'secret' | 'code' | 'config' | 'dependency';
  cwe: string;
  rule: string;
  title: string;
  file: string;
  line: number;
  tool: string;
}

interface SecurityReport {
  summary: { dependencies: DepVulnSummary };
  findings: SecurityFinding[];
}

interface QualityReport {
  metrics: {
    lintErrors: number;
    lintWarnings: number;
    lintTool: string | null;
    duplication: {
      totalLines: number;
      duplicatedLines: number;
      percentage: number;
      cloneCount: number;
    } | null;
  };
  toolsUsed: string[];
  toolsUnavailable: string[];
}

interface TestGapsGap {
  path: string;
  lines: number;
  type: string;
  risk: 'critical' | 'high' | 'medium' | 'low';
  hasMatchingTest: boolean;
}

interface TestGapsReport {
  summary: {
    sourceFiles: number;
    effectiveCoverage: number;
    coverageSource: string;
  };
  gaps: TestGapsGap[];
  toolsUsed: string[];
  toolsUnavailable: string[];
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Per-(command, fixture) subprocess cache. The deep describes (Python:
// 3 calls, Rust/Go/C# single/C# multi: 1 each) AND the matrix describes
// (secrets: 5, lint: 5, dup: 5, test-gaps: 5) exercise the same dxkit
// reports on the same fixtures — without sharing, the suite spawns ~22
// network-bound subprocesses where ~11 are sufficient. Caching at the
// SecurityReport level lets `runDxkitVulnerabilities` (deep describes,
// summary.dependencies) and `runDxkitSecurityReport` (matrix secrets,
// findings) share one subprocess per fixture. Module-scoped + cleared
// between vitest reruns by the forks pool's process isolation.
const reportCache = new Map<string, Promise<unknown>>();

async function cachedExec<T>(key: string, run: () => Promise<T>): Promise<T> {
  let entry = reportCache.get(key) as Promise<T> | undefined;
  if (!entry) {
    entry = run();
    reportCache.set(key, entry);
  }
  return entry;
}

async function runDxkitSecurityReport(fixtureDir: string): Promise<SecurityReport> {
  return cachedExec(`vulnerabilities:${fixtureDir}`, async () => {
    const { stdout } = await execAsync(
      `node ${DXKIT_BIN} vulnerabilities ${fixtureDir} --json --no-save`,
      { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as SecurityReport;
  });
}

async function runDxkitVulnerabilities(fixtureDir: string): Promise<DepVulnSummary> {
  const report = await runDxkitSecurityReport(fixtureDir);
  return report.summary.dependencies;
}

async function runDxkitQualityReport(fixtureDir: string): Promise<QualityReport> {
  return cachedExec(`quality:${fixtureDir}`, async () => {
    const { stdout } = await execAsync(`node ${DXKIT_BIN} quality ${fixtureDir} --json --no-save`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
    return JSON.parse(stdout) as QualityReport;
  });
}

async function runDxkitTestGapsReport(fixtureDir: string): Promise<TestGapsReport> {
  return cachedExec(`test-gaps:${fixtureDir}`, async () => {
    const { stdout } = await execAsync(
      `node ${DXKIT_BIN} test-gaps ${fixtureDir} --json --no-save`,
      { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as TestGapsReport;
  });
}

describe('cross-ecosystem benchmarks — Python', () => {
  const fixture = path.join(FIXTURES, 'python');
  const hasPipAudit = commandExists('pip-audit');

  it.skipIf(!hasPipAudit)(
    'surfaces requests@2.20.0 advisories with no duplicate fingerprints',
    async () => {
      const dep = await runDxkitVulnerabilities(fixture);
      expect(dep.findings.length).toBeGreaterThan(0);
      const requestsFindings = dep.findings.filter((f) => f.package === 'requests');
      expect(requestsFindings.length).toBeGreaterThan(0);
      // Phase 10h.6.8 hotfix #1: pip-audit lists same advisory once per
      // affected version range; gather must dedup. No two findings on
      // the same (package, version, id) triple.
      const seen = new Set<string>();
      for (const f of dep.findings) {
        const key = `${f.package}\0${f.installedVersion ?? ''}\0${f.id}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    },
  );

  it.skipIf(!hasPipAudit)(
    'attributes topLevelDep on direct deps via requirements.txt fallback (no venv needed)',
    async () => {
      const dep = await runDxkitVulnerabilities(fixture);
      const requestsFinding = dep.findings.find((f) => f.package === 'requests');
      expect(requestsFinding).toBeDefined();
      // Phase 10h.6.8 hotfix #2: requests is in requirements.txt → must
      // get self-attribution even when no venv is present.
      expect(requestsFinding!.topLevelDep).toEqual(['requests']);
    },
  );

  it.skipIf(!hasPipAudit)(
    'populates upgradePlan.parent + fingerprint on every advisory',
    async () => {
      const dep = await runDxkitVulnerabilities(fixture);
      expect(dep.findings.length).toBeGreaterThan(0);
      for (const f of dep.findings) {
        expect(f.fingerprint).toMatch(/^[a-f0-9]{16}$/);
        if (f.upgradePlan) {
          // Phase 10h.6.2 contract: Python is flat — parent == package.
          expect(f.upgradePlan.parent).toBe(f.package);
          expect(f.upgradePlan.parentVersion).toMatch(/^\d/);
        }
      }
    },
  );
});

describe('cross-ecosystem benchmarks — Rust', () => {
  const fixture = path.join(FIXTURES, 'rust');
  const hasCargoAudit = commandExists('cargo-audit') || commandExists('cargo');

  it.skipIf(!hasCargoAudit)(
    'surfaces tokio@0.1.22 advisory with clean parentVersion (no semver range)',
    async () => {
      const dep = await runDxkitVulnerabilities(fixture);
      const tokioFinding = dep.findings.find((f) => f.package === 'tokio');
      expect(tokioFinding).toBeDefined();
      expect(tokioFinding!.id).toBe('RUSTSEC-2021-0124');
      expect(tokioFinding!.topLevelDep).toEqual(['tokio']);
      expect(tokioFinding!.upgradePlan).toBeDefined();
      // Phase 10h.6.8 hotfix #4: cargo-audit emits patched ranges like
      // ">=1.8.4, <1.9.0". parentVersion must be the clean semver
      // floor, not the range string.
      expect(tokioFinding!.upgradePlan!.parentVersion).toBe('1.8.4');
      expect(tokioFinding!.upgradePlan!.parent).toBe('tokio');
    },
  );
});

describe('cross-ecosystem benchmarks — C# (single project)', () => {
  const fixture = path.join(FIXTURES, 'csharp');
  const hasDotnet = commandExists('dotnet');

  beforeAll(async () => {
    if (!hasDotnet) return;
    // obj/project.assets.json is gitignored; regenerate before scan.
    await execAsync('dotnet restore --verbosity quiet', { cwd: fixture });
  });

  it.skipIf(!hasDotnet)(
    'surfaces Newtonsoft.Json@9.0.1 advisory from real dotnet output (parser key fix)',
    async () => {
      const dep = await runDxkitVulnerabilities(fixture);
      const finding = dep.findings.find((f) => f.package === 'Newtonsoft.Json');
      expect(finding).toBeDefined();
      // Phase 10h.6.8 hotfix #3: parser was reading `pkg.advisories` +
      // `adv.advisoryUrl`; real dotnet output uses `vulnerabilities` +
      // `advisoryurl`. Pre-fix: 0 findings on real input. Post-fix: id
      // extracted from advisoryurl, refs populated.
      expect(finding!.id).toBe('GHSA-5CRP-9R3C-P9VR');
      expect(finding!.topLevelDep).toEqual(['Newtonsoft.Json']);
      expect(finding!.severity).toBe('high');
      expect(finding!.references?.[0]).toMatch(/github\.com\/advisories\/GHSA-5crp-9r3c-p9vr/i);
      expect(finding!.tool).toBe('dotnet-vulnerable');
    },
  );
});

describe('cross-ecosystem benchmarks — C# (multi-project, D003 validator)', () => {
  const fixture = path.join(FIXTURES, 'csharp-multi');
  const hasDotnet = commandExists('dotnet');

  beforeAll(async () => {
    if (!hasDotnet) return;
    // obj/ in both ProjectA + ProjectB are gitignored.
    await execAsync('dotnet restore Solution.sln --verbosity quiet', { cwd: fixture });
  });

  it.skipIf(!hasDotnet)(
    'surfaces Newtonsoft.Json reachable only through ProjectB (Phase 10h.6.7 D003 fix)',
    async () => {
      // Pre-fix (before 2.4.0), `findProjectAssetsJson` returned the
      // first obj/project.assets.json found in a depth-4 walk; for a
      // 2-project solution that's unpredictable which project's graph
      // got loaded. Post-fix, all project.assets.json files are merged
      // and BFS runs against the union — so an advisory whose only
      // reach is through a sibling project must surface every time.
      const dep = await runDxkitVulnerabilities(fixture);
      const finding = dep.findings.find((f) => f.package === 'Newtonsoft.Json');
      expect(finding).toBeDefined();
      expect(finding!.id).toBe('GHSA-5CRP-9R3C-P9VR');
      expect(finding!.topLevelDep).toEqual(['Newtonsoft.Json']);
    },
  );

  it.skipIf(!hasDotnet)('discovers obj/project.assets.json under both project subdirs', () => {
    // Sanity check that the fixture actually has the multi-project
    // layout the D003 fix was designed against. If this fails the
    // earlier assertion is meaningless.
    expect(fs.existsSync(path.join(fixture, 'ProjectA', 'obj', 'project.assets.json'))).toBe(true);
    expect(fs.existsSync(path.join(fixture, 'ProjectB', 'obj', 'project.assets.json'))).toBe(true);
  });
});

describe('cross-ecosystem benchmarks — Kotlin', () => {
  const fixture = path.join(FIXTURES, 'kotlin');
  const hasOsvScanner = commandExists('osv-scanner');

  it.skipIf(!hasOsvScanner)(
    'osv-scanner surfaces gson@2.8.5 advisory (GHSA-4jrv-ppp4-jm57) from pom.xml',
    async () => {
      const dep = await runDxkitVulnerabilities(fixture);
      expect(dep.findings.length).toBeGreaterThan(0);
      // Every kotlin pack finding flows through osv-scanner — the only
      // depVulns source for this pack today.
      const kotlinFindings = dep.findings.filter((f) => f.tool === 'osv-scanner');
      expect(kotlinFindings.length).toBeGreaterThan(0);
      // gson@2.8.5 has GHSA-4jrv-ppp4-jm57 (alias CVE-2022-25647). The
      // exact advisory id may rotate when OSV.dev re-publishes, but the
      // package name + version anchor is stable.
      const gsonFindings = kotlinFindings.filter((f) => f.package === 'com.google.code.gson:gson');
      expect(gsonFindings.length).toBeGreaterThan(0);
      expect(gsonFindings[0].installedVersion).toBe('2.8.5');
    },
  );

  it.skipIf(!hasOsvScanner)(
    'every advisory has a stable fingerprint and no duplicates by (package, version, id)',
    async () => {
      const dep = await runDxkitVulnerabilities(fixture);
      expect(dep.findings.length).toBeGreaterThan(0);
      // Same dedup contract as the python pack: osv-scanner can list a
      // single advisory once per affected version range; gather must
      // collapse duplicates at the source so consumers don't see synthetic
      // fingerprint collisions.
      const seen = new Set<string>();
      for (const f of dep.findings) {
        if (f.tool !== 'osv-scanner') continue;
        const key = `${f.package}\0${f.installedVersion ?? ''}\0${f.id}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        // Phase 10i fingerprint contract — kotlin row must comply.
        if (f.fingerprint) expect(f.fingerprint).toMatch(/^[a-f0-9]{16}$/);
      }
    },
  );
});

describe('cross-ecosystem benchmarks — Java', () => {
  const fixture = path.join(FIXTURES, 'java');
  const hasOsvScanner = commandExists('osv-scanner');

  it.skipIf(!hasOsvScanner)(
    'osv-scanner surfaces commons-collections@3.2.1 deserialization advisory (GHSA-6hgm-866r-3cjv) from pom.xml',
    async () => {
      const dep = await runDxkitVulnerabilities(fixture);
      expect(dep.findings.length).toBeGreaterThan(0);
      // Java pack delegates to the shared
      // src/analyzers/tools/osv-scanner-maven.ts gather (10k.1.4 SSOT
      // refactor) — same pipeline as kotlin, just attributed via
      // DepVulnFinding.tool === 'osv-scanner'.
      const javaFindings = dep.findings.filter((f) => f.tool === 'osv-scanner');
      expect(javaFindings.length).toBeGreaterThan(0);
      // commons-collections@3.2.1 has GHSA-6hgm-866r-3cjv (alias
      // CVE-2015-7501 — the original "Mad Gadget" Java deserialization
      // exploit). Famous, stable advisory presence on OSV.dev.
      const ccFindings = javaFindings.filter(
        (f) => f.package === 'commons-collections:commons-collections',
      );
      expect(ccFindings.length).toBeGreaterThan(0);
      expect(ccFindings[0].installedVersion).toBe('3.2.1');
    },
  );
});

describe('cross-ecosystem benchmarks — Go', () => {
  const fixture = path.join(FIXTURES, 'go');
  const hasGovulncheck = commandExists('govulncheck');

  it.skipIf(!hasGovulncheck)(
    'govulncheck surfaces stdlib advisories on the gin v1.6.0 module',
    async () => {
      // govulncheck does call-graph reachability analysis. The fixture's
      // main.go exercises gin's basic API but does not necessarily call
      // the specific functions covered by gin's RUSTSEC-equivalent
      // advisories — so gin findings may or may not surface. stdlib
      // findings always surface (any Go binary uses the runtime).
      const dep = await runDxkitVulnerabilities(fixture);
      expect(dep.findings.length).toBeGreaterThan(0);
      expect(dep.findings.every((f) => f.tool === 'govulncheck')).toBe(true);
      const stdlibFindings = dep.findings.filter((f) => f.package === 'stdlib');
      expect(stdlibFindings.length).toBeGreaterThan(0);
    },
  );
});

/**
 * Matrix layer — uniform feature coverage across every language pack.
 *
 * Each `matrix — <report>` describe iterates `BENCHMARK_LANGUAGES` and
 * runs the same assertion against each fixture's deliberate finding.
 * Catches "pack X stopped working entirely" regressions (e.g., the
 * 10h.6.8 C# defect that returned 0 findings on real .NET output for
 * 5 months — would have been caught immediately by a uniform "C# pack
 * surfaces ≥1 advisory" matrix assertion).
 *
 * Distinct from the language-named "deep" describes above (e.g.,
 * `cross-ecosystem benchmarks — Python`), which are heterogeneous
 * regression coverage for specific Phase 10h.6.8 parser fixes
 * (Python dedup, Rust parentVersion, C# parser key, multi-project
 * D003). Two layers, distinct purposes:
 *   - Matrix:    same assertion × all languages — catches pipeline death
 *   - Deep:      one specific assertion per known footgun
 */

/**
 * Phase 10i.0.1 — secrets coverage across every language pack.
 *
 * Each fixture has one hardcoded fake AWS access key (clearly-fake
 * `AKIA1234567890ABCDEF` — passes gitleaks' `aws-access-token` regex,
 * fails real AWS validation). Asserts dxkit's vulnerability pipeline
 * surfaces a `SecretFinding` (category=secret, tool=gitleaks) pointing
 * at the deliberate fixture file in every ecosystem.
 *
 * Pre-stages the assertion surface for 10i.2 (SecretFinding
 * fingerprints) and the 10i.0.5 parity gate.
 *
 * Toolchain gate: `gitleaks` runs language-agnostically, so one
 * `commandExists` check covers every row.
 */
describe('matrix — secrets (Phase 10i.0.1)', () => {
  const hasGitleaks = commandExists('gitleaks');

  for (const lang of BENCHMARK_LANGUAGES) {
    if (!lang.secret) continue;
    const secretFile = lang.secret.file;
    it.skipIf(!hasGitleaks)(`${lang.name}: hardcoded AWS key in ${secretFile}`, async () => {
      const report = await runDxkitSecurityReport(path.join(FIXTURES, lang.dir));
      const secrets = report.findings.filter((f) => f.category === 'secret');
      expect(secrets.length).toBeGreaterThan(0);
      const aws = secrets.find((f) => f.file.endsWith(secretFile));
      expect(aws, `expected a secret finding on ${secretFile}`).toBeDefined();
      expect(aws!.tool).toBe('gitleaks');
      expect(aws!.rule).toBe('aws-access-token');
    });
  }
});

/**
 * Phase 10i.0.2 — lint coverage across every language pack.
 *
 * Each fixture has one source file with one deliberate linter
 * violation idiomatic to that ecosystem (ruff F401 unused-import,
 * gosimple S1002 bool-comparison, clippy unused_variables, dotnet-
 * format whitespace). Asserts dxkit's quality pipeline reports the
 * pack's expected linter and a non-zero error+warning count.
 *
 * Pre-stages the assertion surface for 10i.2 (LintFinding fingerprints)
 * and the 10i.0.5 parity gate.
 *
 * Closes D016 — the C# pack's `dotnet-format` parser was filtering for
 * the substring `'Formatted'` (a string that never appears in real
 * dotnet-format output) and silently returning 0 violations on every
 * real .NET project. Caught by adding the C# row to this matrix; fixed
 * in `src/languages/csharp.ts:gatherCsharpLintResult`.
 *
 * Toolchain gate: each row's `lint.requires` declares the binary the
 * pack's linter shells out to. Locally, contributors without ruff /
 * golangci-lint / cargo / dotnet see those rows skip; CI installs all
 * four and runs the full matrix.
 */
describe('matrix — lint (Phase 10i.0.2)', () => {
  for (const lang of BENCHMARK_LANGUAGES) {
    if (!lang.lint) continue;
    const { file, expectedTool, requires } = lang.lint;
    it.skipIf(!commandExists(requires))(`${lang.name}: ${expectedTool} flags ${file}`, async () => {
      const report = await runDxkitQualityReport(path.join(FIXTURES, lang.dir));
      expect(report.metrics.lintTool).toBe(expectedTool);
      const total = report.metrics.lintErrors + report.metrics.lintWarnings;
      expect(
        total,
        `expected ${expectedTool} to report ≥1 lint finding for ${lang.name} (got ${total})`,
      ).toBeGreaterThan(0);
    });
  }
});

/**
 * Phase 10i.0.3 — duplication coverage across every language pack.
 *
 * Each fixture has one source file with two near-identical helpers
 * sized comfortably above jscpd's `--min-lines 5 --min-tokens 50`
 * defaults. Asserts dxkit's quality pipeline reports a non-zero clone
 * count for every fixture.
 *
 * Pre-stages the assertion surface for 10i.2 (DuplicationClone
 * fingerprints) and the 10i.0.5 parity gate.
 *
 * Toolchain gate: jscpd is the universal duplication scanner — runs
 * language-agnostically on text, so one `commandExists` check covers
 * every row. (Same shape as the secrets matrix.)
 */
describe('matrix — duplications (Phase 10i.0.3)', () => {
  const hasJscpd = commandExists('jscpd');

  for (const lang of BENCHMARK_LANGUAGES) {
    if (!lang.dup) continue;
    const dupFile = lang.dup.file;
    it.skipIf(!hasJscpd)(`${lang.name}: jscpd flags clone in ${dupFile}`, async () => {
      const report = await runDxkitQualityReport(path.join(FIXTURES, lang.dir));
      expect(report.metrics.duplication).not.toBeNull();
      expect(
        report.metrics.duplication!.cloneCount,
        `expected jscpd to find ≥1 clone for ${lang.name}`,
      ).toBeGreaterThan(0);
    });
  }
});

/**
 * Phase 10i.0.4 — test-gaps coverage across every language pack.
 *
 * Each fixture has one source file with no matching test file.
 * Asserts dxkit's `test-gaps` pipeline detects the file as a source
 * file and reports it in `gaps[]` with `hasMatchingTest: false`.
 *
 * Pre-stages the assertion surface for 10i.2 (UntestedFinding
 * fingerprints) and the 10i.0.5 parity gate.
 *
 * Toolchain gate: test-gaps has no external tool dependency — it
 * walks the source tree directly using each pack's
 * `sourceExtensions` + `testFilePatterns` and falls back to
 * filename-match coverage when no coverage artifact is present. So
 * every row runs unconditionally (no `skipIf`).
 *
 * No coverage artifact is committed: filename-match is intentional
 * because the matrix is about "test-gaps detects this file as
 * untested," not "the parser handles every coverage format." The
 * latter is unit-test territory.
 */
describe('matrix — test-gaps (Phase 10i.0.4)', () => {
  for (const lang of BENCHMARK_LANGUAGES) {
    if (!lang.untested) continue;
    const untestedFile = lang.untested.file;
    it(`${lang.name}: test-gaps surfaces ${untestedFile} as untested`, async () => {
      const report = await runDxkitTestGapsReport(path.join(FIXTURES, lang.dir));
      const gap = report.gaps.find((g) => g.path.endsWith(untestedFile));
      expect(gap, `expected ${untestedFile} in gaps[] for ${lang.name}`).toBeDefined();
      expect(gap!.hasMatchingTest).toBe(false);
    });
  }
});
