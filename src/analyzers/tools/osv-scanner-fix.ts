/**
 * osv-scanner fix — Tier-2 upgrade-plan enricher for the TypeScript pack.
 *
 * `npm audit` (Tier-1, typescript pack's primary dep-vuln source) produces
 * per-advisory findings with `fixedVersion` and, for transitive advisories,
 * a free-text `upgradeAdvice` like "Upgrade vitest to 4.1.5 [major]
 * (transitive fix)". That's good for humans reading markdown but leaves
 * autonomous upgrade bots to re-parse the string.
 *
 * `osv-scanner fix --format json --manifest <pkg.json> --lockfile <lock>`
 * produces a structured plan: for each proposed patch, which top-level
 * package to bump (`packageUpdates[]`) and which advisories it would
 * resolve (`fixed[]`). This module wraps that call and stamps the
 * structured result onto each matching `DepVulnFinding.upgradePlan` —
 * the typed sibling to the free-text `upgradeAdvice` that 10h.6.6 added.
 *
 * Degradation: if osv-scanner isn't installed, runs fine but returns
 * zero enrichments. The underlying npm-audit flow populates
 * `upgradeAdvice` either way. Downstream consumers that want the
 * structured form check `upgradePlan` presence.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { DepVulnFinding, DepVulnUpgradePlan } from '../../languages/capabilities/types';
import { findTool, TOOL_DEFS } from './tool-registry';

/** Raw osv-scanner `fix --format json` output shape. Kept internal —
 *  anything exposed outside this module is normalized first. */
interface OsvFixOutput {
  path: string;
  ecosystem: string;
  /** `relax` / `in-place` / `override` — the remediation strategy osv-scanner
   *  picked. We don't surface this; consumers care about the concrete plan. */
  strategy?: string;
  vulnerabilities?: OsvFixVuln[];
  patches?: OsvFixPatch[];
}

interface OsvFixVuln {
  id: string;
  packages?: Array<{ name: string; version: string }>;
  /** `true` when osv-scanner couldn't find a non-breaking upgrade path.
   *  Mapped to a `breaking: true` plan with empty `patches[]` so consumers
   *  see the attempt; today we just skip — no plan rather than a broken one. */
  unactionable?: boolean;
}

interface OsvFixPatch {
  /** Null entries appear in the output for some strategies (e.g. a
   *  no-op alternative). Treated as "no updates in this patch". */
  packageUpdates?: Array<{
    name: string;
    versionFrom: string;
    versionTo: string;
    transitive: boolean;
  }> | null;
  fixed?: OsvFixVuln[];
}

/**
 * Run osv-scanner against a TypeScript project and return a map keyed on
 * the `(package, installedVersion, advisoryId)` tuple → upgradePlan. Caller
 * iterates findings and copies the plan onto each match.
 *
 * Returns an empty map when:
 *   - osv-scanner binary is not available (tool missing — soft-fail)
 *   - package.json or package-lock.json is absent (osv-scanner fix needs both)
 *   - osv-scanner exits with parse-breaking output (log and degrade)
 *
 * Never throws. `gatherTsDepVulnsResult` calls this unconditionally and
 * treats the empty map as "no enrichment available".
 */
export async function gatherOsvScannerFixPlans(
  cwd: string,
): Promise<Map<string, DepVulnUpgradePlan>> {
  const manifestRel = 'package.json';
  const lockfileRel = 'package-lock.json';
  const manifestAbs = path.join(cwd, manifestRel);
  const lockfileAbs = path.join(cwd, lockfileRel);
  if (!fs.existsSync(manifestAbs) || !fs.existsSync(lockfileAbs)) {
    return new Map();
  }
  const tool = findTool(TOOL_DEFS['osv-scanner'], cwd);
  if (!tool.available || !tool.path) return new Map();
  // Quote paths defensively — repo paths with spaces break shell parsing
  // otherwise, and osv-scanner's CLI is shell-parsed.
  const cmd =
    `${tool.path} fix --format json --manifest ${JSON.stringify(manifestRel)} ` +
    `--lockfile ${JSON.stringify(lockfileRel)}`;
  let raw: string;
  try {
    raw = execSync(cmd, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
  } catch (err) {
    // osv-scanner exits non-zero whenever it finds vulns, even though the
    // JSON payload is complete. Capture stdout from the error and proceed.
    const e = err as { stdout?: Buffer | string };
    if (!e.stdout) return new Map();
    raw = typeof e.stdout === 'string' ? e.stdout : e.stdout.toString('utf8');
  }
  return parseOsvScannerFixOutput(raw);
}

/**
 * Parse raw `osv-scanner fix --format json` stdout into a plan-lookup map.
 *
 * The command prefixes JSON with a warning line when it falls back to
 * `npm install --legacy-peer-deps` (seen on 2026-04-24's dxkit sample
 * capture); skip anything before the first `{`. On parse failure,
 * returns an empty map rather than throwing — enrichment is best-effort.
 *
 * Exported for test coverage.
 */
export function parseOsvScannerFixOutput(raw: string): Map<string, DepVulnUpgradePlan> {
  const plans = new Map<string, DepVulnUpgradePlan>();
  const jsonStart = raw.indexOf('{');
  if (jsonStart < 0) return plans;
  let parsed: OsvFixOutput;
  try {
    parsed = JSON.parse(raw.slice(jsonStart)) as OsvFixOutput;
  } catch {
    return plans;
  }

  for (const patch of parsed.patches ?? []) {
    const updates = patch.packageUpdates;
    if (!updates || updates.length === 0) continue;
    const fixedIds = (patch.fixed ?? []).map((f) => f.id).sort();
    // Each patch may bundle multiple top-level updates (e.g. `vitest` +
    // `@vitest/coverage-v8` as a coordinated bump). The finding carries
    // only ONE upgradePlan; pick the direct-dep update as the "parent"
    // — it's the one a human would type — and attach the full patch
    // set via `patches[]`. Transitive-only updates fall back to the
    // first packageUpdate.
    const directUpdate = updates.find((u) => !u.transitive) ?? updates[0];
    const plan: DepVulnUpgradePlan = {
      parent: directUpdate.name,
      parentVersion: normalizeVersion(directUpdate.versionTo),
      patches: fixedIds,
      breaking: isSemverMajorBump(directUpdate.versionFrom, directUpdate.versionTo),
    };
    // Key every fixed advisory onto the same plan so renderers find it
    // when iterating findings.
    for (const fixed of patch.fixed ?? []) {
      for (const pkg of fixed.packages ?? []) {
        plans.set(planKey(pkg.name, pkg.version, fixed.id), plan);
      }
    }
  }
  return plans;
}

/**
 * Stamp upgradePlan on every finding with a matching `(package,
 * installedVersion, id)` tuple in the provided plan map. In-place;
 * finds with no matching plan are left unchanged. Idempotent.
 */
export function enrichWithUpgradePlans(
  findings: DepVulnFinding[],
  plans: Map<string, DepVulnUpgradePlan>,
): number {
  if (plans.size === 0) return 0;
  let count = 0;
  for (const f of findings) {
    if (!f.installedVersion) continue;
    const key = planKey(f.package, f.installedVersion, f.id);
    const plan = plans.get(key);
    if (plan) {
      f.upgradePlan = plan;
      count++;
    }
  }
  return count;
}

/** Shared key between plan-map construction and finding lookup.
 *
 *  GHSA/CVE/SNYK IDs are case-insensitive per their respective specs but
 *  producers disagree in practice — npm-audit emits uppercase
 *  (`GHSA-W5HQ-...`), osv-scanner emits lowercase (`GHSA-w5hq-...`).
 *  Lowercasing the ID component keeps plan lookups hit-or-miss-free when
 *  the two merge. Package names in npm are already lowercase; version
 *  strings have no case. */
export function planKey(pkg: string, version: string, advisoryId: string): string {
  return `${pkg}\0${version}\0${advisoryId.toLowerCase()}`;
}

/** Strip leading semver range operators so the plan carries a concrete
 *  version string (what a consumer would write in a manifest). osv-scanner
 *  emits `^3.2.4` / `~1.2.0` in the relax strategy; the structured payload
 *  is cleaner without the prefix. */
function normalizeVersion(v: string): string {
  return v.replace(/^[\^~>=<\s]+/, '').trim();
}

/** True when `to`'s major segment is higher than `from`'s. Pre-1.x
 *  versions (0.x.y) treat a minor bump as effectively breaking — osv-scanner
 *  doesn't flag it but semver does. Conservative — a jump that crosses
 *  a 0.x boundary (0.5.0 → 1.0.0) is also breaking. */
function isSemverMajorBump(from: string, to: string): boolean {
  const fromMajor = extractMajor(from);
  const toMajor = extractMajor(to);
  if (fromMajor === null || toMajor === null) return false;
  if (fromMajor !== toMajor) return true;
  if (fromMajor === 0) {
    const fromMinor = extractMinor(from);
    const toMinor = extractMinor(to);
    if (fromMinor !== null && toMinor !== null && fromMinor !== toMinor) return true;
  }
  return false;
}

function extractMajor(v: string): number | null {
  const m = v.match(/^[\^~>=<\s]*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function extractMinor(v: string): number | null {
  const m = v.match(/^[\^~>=<\s]*\d+\.(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
