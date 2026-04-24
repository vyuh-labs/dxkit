import { describe, it, expect } from 'vitest';
import type { DepVulnFinding, DepVulnUpgradePlan } from '../src/languages/capabilities/types';

/**
 * Shape contract for `DepVulnUpgradePlan`. The type is populated by
 * future Tier-2 fix tools (10h.6.1/.2/.3) and the cross-pack transitive
 * resolver (10h.6.4); this test locks the wire format down early so
 * those commits can only add producers, never rework the shape.
 */
describe('DepVulnUpgradePlan', () => {
  it('is JSON-serializable without loss', () => {
    const plan: DepVulnUpgradePlan = {
      parent: '@loopback/cli',
      parentVersion: '7.0.1',
      patches: ['GHSA-xxxx-yyyy-zzzz', 'CVE-2022-1234'],
      breaking: true,
    };
    const round = JSON.parse(JSON.stringify(plan)) as DepVulnUpgradePlan;
    expect(round).toEqual(plan);
  });

  it('attaches to a DepVulnFinding alongside upgradeAdvice', () => {
    // Both fields coexist — upgradeAdvice stays for markdown, upgradePlan
    // is the agent-consumable structured form. Renderers pick the richer
    // available value per consumer.
    const finding: DepVulnFinding = {
      id: 'GHSA-xxxx-yyyy-zzzz',
      package: 'minimatch',
      installedVersion: '3.0.4',
      tool: 'npm-audit',
      severity: 'high',
      upgradeAdvice: 'Upgrade @loopback/cli to 7.0.1 (patches 2 advisories)',
      upgradePlan: {
        parent: '@loopback/cli',
        parentVersion: '7.0.1',
        patches: ['GHSA-xxxx-yyyy-zzzz', 'CVE-2022-1234'],
        breaking: true,
      },
    };
    expect(finding.upgradePlan?.parent).toBe('@loopback/cli');
    expect(finding.upgradePlan?.patches).toHaveLength(2);
    expect(finding.upgradePlan?.patches).toContain(finding.id);
  });

  it('supports the direct-dep case where parent equals the finding package', () => {
    const finding: DepVulnFinding = {
      id: 'CVE-2024-1',
      package: 'axios',
      installedVersion: '0.18.0',
      tool: 'npm-audit',
      severity: 'medium',
      upgradePlan: {
        parent: 'axios',
        parentVersion: '1.7.2',
        patches: ['CVE-2024-1'],
        breaking: true,
      },
    };
    expect(finding.upgradePlan?.parent).toBe(finding.package);
  });
});
