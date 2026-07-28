/**
 * The deterministic bump plan (pure half). Pins:
 *   - structured upgradePlans win; direct-dep fixedVersion is the fallback;
 *   - transitive findings without a plan are SKIPPED-AND-NAMED, never guessed;
 *   - breaking bumps skip unless allowMajor; allowlisted findings skip;
 *   - non-node ecosystems are disclosed, not silently dropped;
 *   - per-parent dedupe collapses to the LATEST target version and merges
 *     advisory lists; ordering is severity-first, deterministic.
 */

import { describe, it, expect } from 'vitest';
import { buildBumpPlan } from '../../src/deps-bump/plan';
import type { DepVulnFinding } from '../../src/languages/capabilities/types';

function f(over: Partial<DepVulnFinding>): DepVulnFinding {
  return {
    id: 'GHSA-test-0001',
    package: 'left-pad',
    tool: 'npm-audit',
    severity: 'high',
    packId: 'typescript',
    ...over,
  } as DepVulnFinding;
}

describe('buildBumpPlan', () => {
  it('plans a direct-dep bump from fixedVersion', () => {
    const { bumps, skipped } = buildBumpPlan([
      f({
        package: 'axios',
        installedVersion: '1.7.0',
        fixedVersion: '1.8.2',
        topLevelDep: ['axios'],
      }),
    ]);
    expect(skipped).toHaveLength(0);
    expect(bumps).toEqual([
      {
        parent: 'axios',
        toVersion: '1.8.2',
        fromVersion: '1.7.0',
        breaking: false,
        advisories: ['GHSA-test-0001'],
        maxSeverity: 'high',
      },
    ]);
  });

  it('prefers the structured upgradePlan (transitive → parent bump)', () => {
    const { bumps } = buildBumpPlan([
      f({
        package: 'minimatch',
        upgradePlan: {
          parent: 'some-cli',
          parentVersion: '7.0.1',
          patches: ['GHSA-test-0001', 'GHSA-test-0002'],
          breaking: false,
        },
      }),
    ]);
    expect(bumps).toHaveLength(1);
    expect(bumps[0].parent).toBe('some-cli');
    expect(bumps[0].advisories).toEqual(['GHSA-test-0001', 'GHSA-test-0002']);
  });

  it('skips-and-names: transitive without plan, no fix, breaking, allowlisted, other ecosystem', () => {
    const { bumps, skipped } = buildBumpPlan([
      f({ id: 'A1', package: 'deep-dep', fixedVersion: '2.0.0', topLevelDep: ['some-parent'] }),
      f({ id: 'A2', package: 'no-fix-lib' }),
      f({
        id: 'A3',
        package: 'major-lib',
        installedVersion: '1.0.0',
        fixedVersion: '2.0.0',
        topLevelDep: ['major-lib'],
      }),
      f({ id: 'A4', package: 'accepted-lib', fixedVersion: '3.0.1', allowlisted: true }),
      f({ id: 'A5', package: 'requests', packId: 'python', fixedVersion: '2.32.0' }),
    ]);
    expect(bumps).toHaveLength(0);
    expect(skipped.map((s) => [s.advisoryId, s.reason])).toEqual([
      ['A1', 'transitive-without-plan'],
      ['A2', 'no-fix-available'],
      ['A3', 'breaking-not-allowed'],
      ['A4', 'allowlisted'],
      ['A5', 'ecosystem-not-supported'],
    ]);
  });

  it('allowMajor admits breaking bumps, still flagged', () => {
    const { bumps } = buildBumpPlan(
      [
        f({
          package: 'major-lib',
          installedVersion: '1.0.0',
          fixedVersion: '2.0.0',
          topLevelDep: ['major-lib'],
        }),
      ],
      { allowMajor: true },
    );
    expect(bumps).toHaveLength(1);
    expect(bumps[0].breaking).toBe(true);
  });

  it('dedupes per parent to the latest target and merges advisories; severity orders the plan', () => {
    const { bumps } = buildBumpPlan([
      f({
        id: 'L1',
        package: 'low-lib',
        severity: 'low',
        fixedVersion: '1.0.1',
        topLevelDep: ['low-lib'],
      }),
      f({
        id: 'C1',
        package: 'shared-lib',
        severity: 'medium',
        fixedVersion: '4.17.20',
        topLevelDep: ['shared-lib'],
      }),
      f({
        id: 'C2',
        package: 'shared-lib',
        severity: 'critical',
        fixedVersion: '4.17.21',
        topLevelDep: ['shared-lib'],
      }),
    ]);
    expect(bumps.map((b) => b.parent)).toEqual(['shared-lib', 'low-lib']); // critical first
    expect(bumps[0].toVersion).toBe('4.17.21'); // the higher fix subsumes
    expect(bumps[0].advisories).toEqual(['C1', 'C2']);
    expect(bumps[0].maxSeverity).toBe('critical');
  });
});
