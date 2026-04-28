import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  enrichWithUpgradePlans,
  parseOsvScannerFixOutput,
  planKey,
} from '../src/analyzers/tools/osv-scanner-fix';
import type { DepVulnFinding } from '../src/languages/capabilities/types';

/** Captured from running `osv-scanner fix --format json --manifest package.json
 *  --lockfile package-lock.json` against dxkit itself on 2026-04-24. Covers
 *  three realistic shapes: a normal patch, a patch with null packageUpdates
 *  (no-op alternative), and an unactionable vuln (uuid with no fix path). */
const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures/osv-scanner/dxkit-sample.json'),
  'utf8',
);

function mkFinding(
  overrides: Partial<DepVulnFinding> & Pick<DepVulnFinding, 'id' | 'package'>,
): DepVulnFinding {
  // id + package are required in overrides per Pick<>; defaults apply
  // only to the rest. Spread last so overrides win.
  return {
    installedVersion: '1.0.0',
    tool: 'npm-audit',
    severity: 'medium',
    ...overrides,
  };
}

describe('parseOsvScannerFixOutput — sample output', () => {
  it('returns plans for every fixed advisory in a patch', () => {
    const plans = parseOsvScannerFixOutput(FIXTURE);
    // Sample fixture has one actionable patch (vitest) fixing two advisories
    // (GHSA-4w7w-66w2-5vf9 on vite@5.4.21, GHSA-67mh-4wv8-2f99 on esbuild@0.21.5).
    expect(plans.size).toBe(2);
    expect(plans.has(planKey('vite', '5.4.21', 'GHSA-4w7w-66w2-5vf9'))).toBe(true);
    expect(plans.has(planKey('esbuild', '0.21.5', 'GHSA-67mh-4wv8-2f99'))).toBe(true);
  });

  it('points every fixed-advisory entry at the same parent upgrade', () => {
    const plans = parseOsvScannerFixOutput(FIXTURE);
    const vitePlan = plans.get(planKey('vite', '5.4.21', 'GHSA-4w7w-66w2-5vf9'));
    const esbuildPlan = plans.get(planKey('esbuild', '0.21.5', 'GHSA-67mh-4wv8-2f99'));
    expect(vitePlan?.parent).toBe('vitest');
    expect(esbuildPlan?.parent).toBe('vitest');
    // Both advisories sit under the same patch, so the plan's patches[]
    // lists both ids — consumers see "one upgrade patches 2 advisories".
    expect(vitePlan?.patches).toEqual(['GHSA-4w7w-66w2-5vf9', 'GHSA-67mh-4wv8-2f99'].sort());
    expect(esbuildPlan?.patches).toEqual(vitePlan?.patches);
  });

  it('strips semver range operators from parentVersion', () => {
    const plans = parseOsvScannerFixOutput(FIXTURE);
    const plan = plans.get(planKey('vite', '5.4.21', 'GHSA-4w7w-66w2-5vf9'));
    // Fixture has versionTo: "^3.2.4" → agent-consumable form is 3.2.4.
    expect(plan?.parentVersion).toBe('3.2.4');
  });

  it('flags a major-version parent bump as breaking', () => {
    const plans = parseOsvScannerFixOutput(FIXTURE);
    const plan = plans.get(planKey('vite', '5.4.21', 'GHSA-4w7w-66w2-5vf9'));
    // ^2.1.4 → ^3.2.4 crosses major — breaking
    expect(plan?.breaking).toBe(true);
  });

  it('skips unactionable vulns (no plan emitted)', () => {
    const plans = parseOsvScannerFixOutput(FIXTURE);
    // uuid@8.3.2 / GHSA-w5hq-g745-h8pq has unactionable: true in fixture;
    // no patch fixes it, so no plan entry.
    expect(plans.has(planKey('uuid', '8.3.2', 'GHSA-w5hq-g745-h8pq'))).toBe(false);
  });

  it('ignores patches with null packageUpdates', () => {
    // Sample fixture contains one such patch; the parser must not crash
    // on it (parser crashed was the original implementation without the
    // null guard).
    const plans = parseOsvScannerFixOutput(FIXTURE);
    expect(plans.size).toBeGreaterThan(0);
  });
});

describe('parseOsvScannerFixOutput — resilience', () => {
  it('strips preamble text before the first { (osv legacy-peer-deps warning)', () => {
    const withPreamble = 'npm install failed. Trying again with `--legacy-peer-deps`\n' + FIXTURE;
    const plans = parseOsvScannerFixOutput(withPreamble);
    expect(plans.size).toBe(2);
  });

  it('returns empty map on no JSON at all', () => {
    expect(parseOsvScannerFixOutput('').size).toBe(0);
    expect(parseOsvScannerFixOutput('not json anywhere').size).toBe(0);
  });

  it('returns empty map on malformed JSON (no throw)', () => {
    const plans = parseOsvScannerFixOutput('{ "incomplete":');
    expect(plans.size).toBe(0);
  });

  it('returns empty map when patches array is absent', () => {
    const plans = parseOsvScannerFixOutput('{"path":"x","ecosystem":"npm"}');
    expect(plans.size).toBe(0);
  });

  it('marks pre-1.x minor bump as breaking (0.5 → 0.6)', () => {
    const json = JSON.stringify({
      path: 'package.json',
      ecosystem: 'npm',
      patches: [
        {
          packageUpdates: [
            { name: 'p', versionFrom: '^0.5.0', versionTo: '^0.6.0', transitive: false },
          ],
          fixed: [{ id: 'CVE-x', packages: [{ name: 'p', version: '0.5.0' }] }],
        },
      ],
    });
    const plans = parseOsvScannerFixOutput(json);
    const plan = plans.get(planKey('p', '0.5.0', 'CVE-x'));
    expect(plan?.breaking).toBe(true);
  });

  it('does not mark same-major patch bump as breaking (1.2.3 → 1.2.4)', () => {
    const json = JSON.stringify({
      patches: [
        {
          packageUpdates: [
            { name: 'p', versionFrom: '^1.2.3', versionTo: '^1.2.4', transitive: false },
          ],
          fixed: [{ id: 'CVE-x', packages: [{ name: 'p', version: '1.2.3' }] }],
        },
      ],
    });
    const plans = parseOsvScannerFixOutput(json);
    expect(plans.get(planKey('p', '1.2.3', 'CVE-x'))?.breaking).toBe(false);
  });

  it('prefers direct (non-transitive) update as the parent over transitive ones', () => {
    const json = JSON.stringify({
      patches: [
        {
          packageUpdates: [
            {
              name: 'transitive-dep',
              versionFrom: '^1.0.0',
              versionTo: '^2.0.0',
              transitive: true,
            },
            {
              name: 'direct-parent',
              versionFrom: '^2.0.0',
              versionTo: '^3.0.0',
              transitive: false,
            },
          ],
          fixed: [{ id: 'CVE-x', packages: [{ name: 'leaf', version: '1.0.0' }] }],
        },
      ],
    });
    const plans = parseOsvScannerFixOutput(json);
    const plan = plans.get(planKey('leaf', '1.0.0', 'CVE-x'));
    expect(plan?.parent).toBe('direct-parent');
  });
});

describe('enrichWithUpgradePlans', () => {
  it('stamps upgradePlan on matching findings', () => {
    const plans = parseOsvScannerFixOutput(FIXTURE);
    const findings: DepVulnFinding[] = [
      mkFinding({
        id: 'GHSA-4w7w-66w2-5vf9',
        package: 'vite',
        installedVersion: '5.4.21',
      }),
      mkFinding({
        id: 'GHSA-67mh-4wv8-2f99',
        package: 'esbuild',
        installedVersion: '0.21.5',
      }),
    ];
    const stamped = enrichWithUpgradePlans(findings, plans);
    expect(stamped).toBe(2);
    expect(findings[0].upgradePlan?.parent).toBe('vitest');
    expect(findings[1].upgradePlan?.parent).toBe('vitest');
  });

  it('leaves findings unchanged when no matching plan exists', () => {
    const plans = parseOsvScannerFixOutput(FIXTURE);
    const findings: DepVulnFinding[] = [
      mkFinding({ id: 'UNKNOWN-1', package: 'axios', installedVersion: '0.18.0' }),
    ];
    enrichWithUpgradePlans(findings, plans);
    expect(findings[0].upgradePlan).toBeUndefined();
  });

  it('ignores findings without installedVersion', () => {
    const plans = parseOsvScannerFixOutput(FIXTURE);
    const findings: DepVulnFinding[] = [
      mkFinding({ id: 'GHSA-4w7w-66w2-5vf9', package: 'vite', installedVersion: undefined }),
    ];
    const stamped = enrichWithUpgradePlans(findings, plans);
    expect(stamped).toBe(0);
    expect(findings[0].upgradePlan).toBeUndefined();
  });

  it('is idempotent (stamping twice yields same plan)', () => {
    const plans = parseOsvScannerFixOutput(FIXTURE);
    const findings: DepVulnFinding[] = [
      mkFinding({
        id: 'GHSA-4w7w-66w2-5vf9',
        package: 'vite',
        installedVersion: '5.4.21',
      }),
    ];
    enrichWithUpgradePlans(findings, plans);
    const first = findings[0].upgradePlan;
    enrichWithUpgradePlans(findings, plans);
    expect(findings[0].upgradePlan).toBe(first);
  });

  it('returns 0 for empty plan map without walking findings', () => {
    const findings: DepVulnFinding[] = [mkFinding({ id: 'x', package: 'p' })];
    const stamped = enrichWithUpgradePlans(findings, new Map());
    expect(stamped).toBe(0);
  });

  it('matches case-insensitive GHSA ids (npm-audit emits uppercase; osv-scanner emits lowercase)', () => {
    const plans = parseOsvScannerFixOutput(FIXTURE);
    // npm-audit would emit this finding with an uppercased ID; ensure
    // enrichment finds the plan regardless.
    const findings: DepVulnFinding[] = [
      mkFinding({
        id: 'GHSA-4W7W-66W2-5VF9', // uppercase
        package: 'vite',
        installedVersion: '5.4.21',
      }),
    ];
    enrichWithUpgradePlans(findings, plans);
    expect(findings[0].upgradePlan?.parent).toBe('vitest');
  });
});
