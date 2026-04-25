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
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures', 'benchmarks');
const DXKIT_BIN = path.join(REPO_ROOT, 'dist', 'index.js');

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

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function runDxkitVulnerabilities(fixtureDir: string): DepVulnSummary {
  const out = execSync(`node ${DXKIT_BIN} vulnerabilities ${fixtureDir} --json --no-save`, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });
  const report = JSON.parse(out) as { summary: { dependencies: DepVulnSummary } };
  return report.summary.dependencies;
}

describe('cross-ecosystem benchmarks — Python', () => {
  const fixture = path.join(FIXTURES, 'python');
  const hasPipAudit = commandExists('pip-audit');

  it.skipIf(!hasPipAudit)(
    'surfaces requests@2.20.0 advisories with no duplicate fingerprints',
    () => {
      const dep = runDxkitVulnerabilities(fixture);
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
    () => {
      const dep = runDxkitVulnerabilities(fixture);
      const requestsFinding = dep.findings.find((f) => f.package === 'requests');
      expect(requestsFinding).toBeDefined();
      // Phase 10h.6.8 hotfix #2: requests is in requirements.txt → must
      // get self-attribution even when no venv is present.
      expect(requestsFinding!.topLevelDep).toEqual(['requests']);
    },
  );

  it.skipIf(!hasPipAudit)('populates upgradePlan.parent + fingerprint on every advisory', () => {
    const dep = runDxkitVulnerabilities(fixture);
    expect(dep.findings.length).toBeGreaterThan(0);
    for (const f of dep.findings) {
      expect(f.fingerprint).toMatch(/^[a-f0-9]{16}$/);
      if (f.upgradePlan) {
        // Phase 10h.6.2 contract: Python is flat — parent == package.
        expect(f.upgradePlan.parent).toBe(f.package);
        expect(f.upgradePlan.parentVersion).toMatch(/^\d/);
      }
    }
  });
});

describe('cross-ecosystem benchmarks — Rust', () => {
  const fixture = path.join(FIXTURES, 'rust');
  const hasCargoAudit = commandExists('cargo-audit') || commandExists('cargo');

  it.skipIf(!hasCargoAudit)(
    'surfaces tokio@0.1.22 advisory with clean parentVersion (no semver range)',
    () => {
      const dep = runDxkitVulnerabilities(fixture);
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

  beforeAll(() => {
    if (!hasDotnet) return;
    // obj/project.assets.json is gitignored; regenerate before scan.
    execSync('dotnet restore --verbosity quiet', { cwd: fixture, stdio: 'pipe' });
  });

  it.skipIf(!hasDotnet)(
    'surfaces Newtonsoft.Json@9.0.1 advisory from real dotnet output (parser key fix)',
    () => {
      const dep = runDxkitVulnerabilities(fixture);
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

  beforeAll(() => {
    if (!hasDotnet) return;
    // obj/ in both ProjectA + ProjectB are gitignored.
    execSync('dotnet restore Solution.sln --verbosity quiet', { cwd: fixture, stdio: 'pipe' });
  });

  it.skipIf(!hasDotnet)(
    'surfaces Newtonsoft.Json reachable only through ProjectB (Phase 10h.6.7 D003 fix)',
    () => {
      // Pre-fix (before 2.4.0), `findProjectAssetsJson` returned the
      // first obj/project.assets.json found in a depth-4 walk; for a
      // 2-project solution that's unpredictable which project's graph
      // got loaded. Post-fix, all project.assets.json files are merged
      // and BFS runs against the union — so an advisory whose only
      // reach is through a sibling project must surface every time.
      const dep = runDxkitVulnerabilities(fixture);
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

describe('cross-ecosystem benchmarks — Go', () => {
  const fixture = path.join(FIXTURES, 'go');
  const hasGovulncheck = commandExists('govulncheck');

  it.skipIf(!hasGovulncheck)(
    'govulncheck surfaces stdlib advisories on the gin v1.6.0 module',
    () => {
      // govulncheck does call-graph reachability analysis. The fixture's
      // main.go exercises gin's basic API but does not necessarily call
      // the specific functions covered by gin's RUSTSEC-equivalent
      // advisories — so gin findings may or may not surface. stdlib
      // findings always surface (any Go binary uses the runtime).
      const dep = runDxkitVulnerabilities(fixture);
      expect(dep.findings.length).toBeGreaterThan(0);
      expect(dep.findings.every((f) => f.tool === 'govulncheck')).toBe(true);
      const stdlibFindings = dep.findings.filter((f) => f.package === 'stdlib');
      expect(stdlibFindings.length).toBeGreaterThan(0);
    },
  );
});
