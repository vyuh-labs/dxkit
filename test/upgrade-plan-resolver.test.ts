import { describe, it, expect } from 'vitest';
import {
  reconcileUpgradePlans,
  resolveTransitiveUpgradePlans,
  stampFromFreeTextAdvice,
} from '../src/analyzers/tools/upgrade-plan-resolver';
import type { DepVulnFinding } from '../src/languages/capabilities/types';

function mkFinding(
  overrides: Partial<DepVulnFinding> & Pick<DepVulnFinding, 'id' | 'package'>,
): DepVulnFinding {
  return {
    id: overrides.id,
    package: overrides.package,
    installedVersion: overrides.installedVersion ?? '1.0.0',
    tool: overrides.tool ?? 'npm-audit',
    severity: overrides.severity ?? 'medium',
    ...overrides,
  };
}

describe('reconcileUpgradePlans', () => {
  it('stamps a plan on findings whose id is in the plan patches[] but lack an upgradePlan', () => {
    const findings: DepVulnFinding[] = [
      mkFinding({
        id: 'CVE-1',
        package: 'vite',
        upgradePlan: {
          parent: 'vitest',
          parentVersion: '3.2.4',
          patches: ['CVE-1', 'CVE-2'],
          breaking: true,
        },
      }),
      // Sibling advisory — same patch, no plan yet.
      mkFinding({ id: 'CVE-2', package: 'esbuild' }),
    ];
    const stamped = reconcileUpgradePlans(findings);
    expect(stamped).toBe(1);
    expect(findings[1].upgradePlan?.parent).toBe('vitest');
    expect(findings[1].upgradePlan).toBe(findings[0].upgradePlan);
  });

  it('is case-insensitive on advisory id matching', () => {
    const findings: DepVulnFinding[] = [
      mkFinding({
        id: 'ghsa-aaaa-bbbb-cccc',
        package: 'x',
        upgradePlan: {
          parent: 'p',
          parentVersion: '2.0.0',
          patches: ['GHSA-AAAA-BBBB-CCCC', 'GHSA-dddd-eeee-ffff'],
          breaking: false,
        },
      }),
      mkFinding({ id: 'GHSA-DDDD-EEEE-FFFF', package: 'y' }),
    ];
    reconcileUpgradePlans(findings);
    expect(findings[1].upgradePlan?.parent).toBe('p');
  });

  it('never overwrites an existing plan', () => {
    const original = {
      parent: 'producerA',
      parentVersion: '1.0.0',
      patches: ['CVE-1'],
      breaking: false,
    };
    const findings: DepVulnFinding[] = [
      mkFinding({ id: 'CVE-1', package: 'pkg', upgradePlan: original }),
      mkFinding({
        id: 'CVE-2',
        package: 'other',
        upgradePlan: {
          parent: 'producerB',
          parentVersion: '2.0.0',
          patches: ['CVE-1', 'CVE-2'],
          breaking: true,
        },
      }),
    ];
    reconcileUpgradePlans(findings);
    // The finding with the pre-existing plan keeps it — producer-written
    // plans are authoritative; reconciliation only fills gaps.
    expect(findings[0].upgradePlan).toBe(original);
  });

  it('prefers the higher parentVersion when multiple plans list the same id', () => {
    const findings: DepVulnFinding[] = [
      mkFinding({
        id: 'CVE-SEED',
        package: 'a',
        upgradePlan: {
          parent: 'p',
          parentVersion: '2.0.0',
          patches: ['CVE-SEED', 'CVE-UNSTAMPED'],
          breaking: true,
        },
      }),
      mkFinding({
        id: 'CVE-OTHER',
        package: 'b',
        upgradePlan: {
          parent: 'p',
          parentVersion: '3.5.0',
          patches: ['CVE-OTHER', 'CVE-UNSTAMPED'],
          breaking: true,
        },
      }),
      mkFinding({ id: 'CVE-UNSTAMPED', package: 'c' }),
    ];
    reconcileUpgradePlans(findings);
    // The unstamped finding gets the 3.5.0 plan, not the 2.0.0 plan.
    expect(findings[2].upgradePlan?.parentVersion).toBe('3.5.0');
  });

  it('is idempotent — second run stamps nothing new', () => {
    const findings: DepVulnFinding[] = [
      mkFinding({
        id: 'CVE-1',
        package: 'a',
        upgradePlan: {
          parent: 'p',
          parentVersion: '2.0.0',
          patches: ['CVE-1', 'CVE-2'],
          breaking: false,
        },
      }),
      mkFinding({ id: 'CVE-2', package: 'b' }),
    ];
    reconcileUpgradePlans(findings);
    const second = reconcileUpgradePlans(findings);
    expect(second).toBe(0);
  });

  it('ignores findings not mentioned in any plan patches[]', () => {
    const findings: DepVulnFinding[] = [
      mkFinding({
        id: 'CVE-1',
        package: 'a',
        upgradePlan: { parent: 'p', parentVersion: '1.0.0', patches: ['CVE-1'], breaking: false },
      }),
      mkFinding({ id: 'CVE-UNRELATED', package: 'z' }),
    ];
    reconcileUpgradePlans(findings);
    expect(findings[1].upgradePlan).toBeUndefined();
  });
});

describe('stampFromFreeTextAdvice', () => {
  it('parses the transitive-fix template into a structured plan', () => {
    const findings: DepVulnFinding[] = [
      mkFinding({
        id: 'GHSA-xxx',
        package: 'minimatch',
        upgradeAdvice: 'Upgrade @loopback/cli to 7.0.1 [major] (transitive fix)',
      }),
    ];
    const stamped = stampFromFreeTextAdvice(findings);
    expect(stamped).toBe(1);
    expect(findings[0].upgradePlan).toEqual({
      parent: '@loopback/cli',
      parentVersion: '7.0.1',
      patches: ['GHSA-xxx'],
      breaking: true,
    });
  });

  it('detects non-major transitive upgrades', () => {
    const findings: DepVulnFinding[] = [
      mkFinding({
        id: 'CVE-minor',
        package: 'child',
        upgradeAdvice: 'Upgrade parent to 1.2.3 (transitive fix)',
      }),
    ];
    stampFromFreeTextAdvice(findings);
    expect(findings[0].upgradePlan?.breaking).toBe(false);
  });

  it('never overwrites an existing plan (pre-existing takes precedence)', () => {
    const existing = { parent: 'x', parentVersion: '1.0.0', patches: ['CVE-x'], breaking: false };
    const findings: DepVulnFinding[] = [
      mkFinding({
        id: 'CVE-x',
        package: 'y',
        upgradeAdvice: 'Upgrade other to 2.0.0 (transitive fix)',
        upgradePlan: existing,
      }),
    ];
    const stamped = stampFromFreeTextAdvice(findings);
    expect(stamped).toBe(0);
    expect(findings[0].upgradePlan).toBe(existing);
  });

  it('skips findings with no advice or with non-template advice', () => {
    const findings: DepVulnFinding[] = [
      mkFinding({ id: 'a', package: 'a' }), // no advice
      mkFinding({
        id: 'b',
        package: 'b',
        upgradeAdvice: 'PROPOSAL: Upgrade to 1.0.0 (resolves 1 vuln)', // Tier-1 template, not transitive
      }),
      mkFinding({ id: 'c', package: 'c', upgradeAdvice: 'some random text' }),
    ];
    const stamped = stampFromFreeTextAdvice(findings);
    expect(stamped).toBe(0);
    expect(findings.every((f) => !f.upgradePlan)).toBe(true);
  });
});

describe('resolveTransitiveUpgradePlans', () => {
  it('runs reconciliation and free-text parse in order', () => {
    const findings: DepVulnFinding[] = [
      // Tier-2 stamped finding
      mkFinding({
        id: 'CVE-seed',
        package: 'a',
        upgradePlan: {
          parent: 'parent',
          parentVersion: '2.0.0',
          patches: ['CVE-seed', 'CVE-twin'],
          breaking: true,
        },
      }),
      // Should be reconciled via patches[] lookup
      mkFinding({ id: 'CVE-twin', package: 'b' }),
      // Should be stamped from free-text only (no reconciliation match)
      mkFinding({
        id: 'CVE-lonely',
        package: 'c',
        upgradeAdvice: 'Upgrade libX to 3.0.0 (transitive fix)',
      }),
    ];
    const stats = resolveTransitiveUpgradePlans(findings);
    expect(stats.reconciled).toBe(1);
    expect(stats.fromFreeText).toBe(1);
    expect(findings[1].upgradePlan?.parent).toBe('parent');
    expect(findings[2].upgradePlan?.parent).toBe('libX');
  });
});
