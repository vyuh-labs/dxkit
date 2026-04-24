/**
 * Cross-pack upgrade-plan resolver — Phase 10h.6.4.
 *
 * Runs after every pack has contributed its Tier-1/Tier-2 dep-vuln
 * findings and the per-pack Tier-2 fix tools (osv-scanner fix in TS,
 * pip-audit's fix_versions in Python, cargo-audit's patched[] in Rust)
 * have stamped `upgradePlan` on whichever findings they could. This
 * resolver fills the gaps in two passes:
 *
 *   Pass 1 — plan reconciliation. osv-scanner's structured output
 *   frequently lists multiple advisories under one patch (e.g. a single
 *   `vitest ^2 → ^3` bump patches both vite + esbuild CVEs). Only the
 *   advisories in `patches[]` get stamped by 10h.6.1's enricher because
 *   it keys on (package, version, id). If another producer (npm-audit's
 *   default output, Snyk later) emits a finding for an advisory that
 *   ALSO appears in some plan's `patches[]` but with a different
 *   package/version tuple, the reconciliation pass stamps it too.
 *
 *   Pass 2 — transitive free-text parse. npm-audit emits free-text
 *   `upgradeAdvice` like `"Upgrade @loopback/cli to 7.0.1 [major]
 *   (transitive fix)"` on transitive advisories. That string is
 *   structured data trapped in a string; this pass parses it into a
 *   proper `upgradePlan` when no better one is available. Conservative:
 *   only activates when `upgradeAdvice` matches the exact transitive-
 *   fix template the TS pack emits. Future producers that emit the
 *   same shape benefit automatically.
 *
 * Purity: mutates findings in place (stamps `upgradePlan`) and returns
 * a count of additions. Never overwrites an existing plan — the
 * per-pack producers are authoritative.
 */

import type { DepVulnFinding, DepVulnUpgradePlan } from '../../languages/capabilities/types';

/**
 * Matches the TS pack's transitive-fix `upgradeAdvice` template:
 *   "Upgrade <pkg> to <version>[ [major]] (transitive fix)"
 * Captures pkg + version + optional [major] flag.
 */
const TRANSITIVE_ADVICE_RE = /^Upgrade (\S+) to (\S+?)(?:\s+\[major\])? \(transitive fix\)$/;

/** Result summary — useful for tests and for the security/gather caller
 *  that wants to log how much reconciliation actually happened. */
export interface ResolverStats {
  reconciled: number;
  fromFreeText: number;
}

/**
 * Run the resolver over a flat finding set. Mutates in place; returns
 * per-pass counts. Idempotent — re-running on the same set after
 * resolver-stamping yields zero additions.
 */
export function resolveTransitiveUpgradePlans(findings: DepVulnFinding[]): ResolverStats {
  return {
    reconciled: reconcileUpgradePlans(findings),
    fromFreeText: stampFromFreeTextAdvice(findings),
  };
}

/**
 * Pass 1 — for every advisory id listed in any existing plan's
 * `patches[]`, ensure the matching finding (if any, by id only) carries
 * the same `upgradePlan`. Case-insensitive id matching matches the
 * osv-scanner-fix planKey convention.
 *
 * Exported for test coverage.
 */
export function reconcileUpgradePlans(findings: DepVulnFinding[]): number {
  // Build: advisory id → canonical plan. When an advisory id appears in
  // multiple plans' patches[] (possible if two tools emit overlapping
  // plans), keep the one with the highest parentVersion so the rollup
  // reflects the most aggressive viable remediation.
  const plansByAdvisoryId = new Map<string, DepVulnUpgradePlan>();
  for (const f of findings) {
    if (!f.upgradePlan) continue;
    for (const id of f.upgradePlan.patches) {
      const key = id.toLowerCase();
      const existing = plansByAdvisoryId.get(key);
      if (!existing) {
        plansByAdvisoryId.set(key, f.upgradePlan);
      } else if (
        f.upgradePlan.parent === existing.parent &&
        compareVersions(f.upgradePlan.parentVersion, existing.parentVersion) > 0
      ) {
        plansByAdvisoryId.set(key, f.upgradePlan);
      }
    }
  }
  // Stamp plans on findings whose id appears in some plan's patches[]
  // but whose own `upgradePlan` is absent. Reconciliation only —
  // never overwrites.
  let stamped = 0;
  for (const f of findings) {
    if (f.upgradePlan) continue;
    const plan = plansByAdvisoryId.get(f.id.toLowerCase());
    if (plan) {
      f.upgradePlan = plan;
      stamped++;
    }
  }
  return stamped;
}

/**
 * Pass 2 — derive `upgradePlan` from the npm-audit-style transitive-fix
 * `upgradeAdvice` free-text template. Activates only when the string
 * matches exactly and no structured plan exists. Outputs a
 * single-advisory plan (patches = [finding.id]) since the free-text
 * template doesn't carry cross-advisory rollup.
 *
 * Exported for test coverage.
 */
export function stampFromFreeTextAdvice(findings: DepVulnFinding[]): number {
  let stamped = 0;
  for (const f of findings) {
    if (f.upgradePlan) continue;
    if (!f.upgradeAdvice) continue;
    const m = f.upgradeAdvice.match(TRANSITIVE_ADVICE_RE);
    if (!m) continue;
    f.upgradePlan = {
      parent: m[1],
      parentVersion: m[2],
      patches: [f.id],
      breaking: f.upgradeAdvice.includes('[major]'),
    };
    stamped++;
  }
  return stamped;
}

/**
 * Numeric semver compare for the plan-selection tiebreaker. Returns
 * positive when `a > b`, negative when `a < b`, 0 when equal. Falls
 * back to lexicographic compare for non-numeric segments.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => parseInt(p, 10));
  const pb = b.split('.').map((p) => parseInt(p, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const xa = pa[i];
    const xb = pb[i];
    if (isNaN(xa) || isNaN(xb)) return a.localeCompare(b);
    if (xa !== xb) return xa - xb;
  }
  return 0;
}
