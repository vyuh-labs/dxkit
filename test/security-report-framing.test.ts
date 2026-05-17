/**
 * D025e (2.4.7) — standalone vulnerability scan markdown framing.
 *
 * Pre-D025e: every case where `summary.dependencies.tool` was null
 * collapsed to a single string — *"No dependency audit data — no
 * language pack with a depVulns provider was active."* That framing
 * is factually wrong for the dpl-studio case where the csharp pack
 * IS active and DOES expose a depVulns provider; the tool just
 * couldn't run (dotnet not on PATH, no `packages.lock.json`).
 *
 * Post-D025e: three distinct branches based on
 * `summary.dependencies.{tool, available, unavailableReason}`:
 *
 *   1. `tool` set, `available === true` → normal happy path, table
 *      renders, no warning.
 *   2. `tool` set, `available === false` → partial-scan warning
 *      (some packs scanned, others unavailable). Table renders +
 *      ⚠ notice.
 *   3. `tool` null, `available === false` → scan-failed notice with
 *      mention of the 65/100 score cap.
 *   4. `tool` null, `available === true` → genuinely-inactive case
 *      (no pack active OR all packs reported `no-manifest`). The
 *      reworded "no active language pack reported a manifest to
 *      scan" string.
 */

import { describe, it, expect } from 'vitest';
import { formatSecurityReport, formatDepActionTitle } from '../src/analyzers/security';
import type { SecurityReport } from '../src/analyzers/security/types';

function makeReport(deps: Partial<SecurityReport['summary']['dependencies']>): SecurityReport {
  return {
    repo: 'test',
    analyzedAt: '2026-05-12T00:00:00.000Z',
    commitSha: 'abc1234',
    branch: 'main',
    summary: {
      findings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
      codeOnly: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
      secretsOnly: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
      dependencies: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        total: 0,
        tool: null,
        findings: [],
        available: true,
        unavailableReason: '',
        ...deps,
      },
    },
    findings: [],
    toolsUsed: [],
    toolsUnavailable: [],
  };
}

describe('formatSecurityReport — Dependency Vulnerabilities framing (D025e)', () => {
  it('branch 1: tool set + available=true renders the table without warnings', () => {
    const md = formatSecurityReport(
      makeReport({ tool: 'npm-audit', critical: 1, high: 2, total: 3, available: true }),
      '1.0',
    );
    expect(md).toContain('_Source: npm-audit_');
    expect(md).toMatch(/\| CRITICAL \| 1 \|/);
    expect(md).toMatch(/\| HIGH\s+\| 2 \|/);
    expect(md).not.toContain('Partial scan');
    expect(md).not.toContain('Dependency vulnerability scan unavailable');
    expect(md).not.toContain('no active language pack');
  });

  it('branch 2: tool set + available=false renders the table AND the partial-scan warning', () => {
    const md = formatSecurityReport(
      makeReport({
        tool: 'npm-audit',
        critical: 1,
        total: 1,
        available: false,
        unavailableReason: 'csharp: dotnet list package produced no output (see D036)',
      }),
      '1.0',
    );
    expect(md).toContain('_Source: npm-audit_');
    expect(md).toMatch(/\| CRITICAL \| 1 \|/);
    expect(md).toContain('Partial scan');
    expect(md).toContain('csharp: dotnet list package produced no output');
    expect(md).not.toContain('Dependency vulnerability scan unavailable');
  });

  it('branch 3: tool null + available=false surfaces the unavailable notice + cap mention', () => {
    const md = formatSecurityReport(
      makeReport({
        tool: null,
        available: false,
        unavailableReason: 'csharp: dotnet SDK not installed',
      }),
      '1.0',
    );
    expect(md).toContain('Dependency vulnerability scan unavailable');
    expect(md).toContain('csharp: dotnet SDK not installed');
    expect(md).toContain('capped at 65/100');
    expect(md).toContain('dep-audit incomplete');
    expect(md).not.toContain('Partial scan');
    expect(md).not.toContain('no active language pack');
  });

  it('branch 4: tool null + available=true (genuinely inactive) renders the reworded message', () => {
    const md = formatSecurityReport(
      makeReport({ tool: null, available: true, unavailableReason: '' }),
      '1.0',
    );
    // Post-D025e text — explicitly differentiates from the pre-D025e
    // "no language pack with a depVulns provider was active" string.
    expect(md).toContain('no active language pack reported a manifest to scan');
    expect(md).not.toContain('Dependency vulnerability scan unavailable');
    expect(md).not.toContain('Partial scan');
    expect(md).not.toContain('capped at 65/100');
  });

  // Regression: pre-D025e error framing should NEVER appear in any branch.
  // The old string conflated 4 distinct cases into 1; this guards against
  // a careless revert that re-introduces it.
  it('regression: pre-D025e inaccurate string is gone from every branch', () => {
    const branches = [
      makeReport({ tool: 'npm-audit', available: true }),
      makeReport({ tool: 'npm-audit', available: false, unavailableReason: 'x: y' }),
      makeReport({ tool: null, available: false, unavailableReason: 'x: y' }),
      makeReport({ tool: null, available: true }),
    ];
    for (const r of branches) {
      const md = formatSecurityReport(r, '1.0');
      expect(md).not.toContain('no language pack with a depVulns provider was active');
    }
  });
});

/**
 * C3.2 / D090 (2.4.7 Phase C3): "Remediation Commands" splits into
 *   - "Actionable upgrades" (findings with fixedVersion)
 *   - "Mitigation required — no patch available" (findings without)
 *
 * Pre-fix all entries went into one bash block, so on platform 84
 * `# no patched version available` prose lines drowned out a single
 * actual install command. The split surfaces the actionable subset.
 */
describe('formatSecurityReport — Remediation Commands split (D090)', () => {
  it('actionable-only: emits only the Actionable upgrades subsection', () => {
    const md = formatSecurityReport(
      makeReport({
        tool: 'npm-audit',
        critical: 1,
        total: 1,
        findings: [
          {
            id: 'CVE-2024-0001',
            package: 'lodash',
            installedVersion: '4.17.20',
            fixedVersion: '4.17.21',
            tool: 'npm-audit',
            packId: 'typescript',
            severity: 'high',
          },
        ],
      }),
      '1.0',
    );
    expect(md).toContain('## Remediation Commands');
    expect(md).toContain('### Actionable upgrades (1)');
    expect(md).not.toContain('### Mitigation required');
    expect(md).toMatch(/lodash@4\.17\.20 → 4\.17\.21 \(CVE-2024-0001\)/);
  });

  it('mitigation-only: emits only the Mitigation required subsection with advisory link', () => {
    const md = formatSecurityReport(
      makeReport({
        tool: 'npm-audit',
        critical: 1,
        total: 1,
        findings: [
          {
            id: 'GHSA-xxxx-yyyy-zzzz',
            package: 'left-pad',
            installedVersion: '1.3.0',
            tool: 'npm-audit',
            severity: 'medium',
            references: ['https://github.com/advisories/GHSA-xxxx-yyyy-zzzz'],
          },
        ],
      }),
      '1.0',
    );
    expect(md).toContain('## Remediation Commands');
    expect(md).not.toContain('### Actionable upgrades');
    expect(md).toContain('### Mitigation required — no patch available (1)');
    expect(md).toContain('`left-pad@1.3.0`');
    expect(md).toContain(
      '[GHSA-xxxx-yyyy-zzzz](https://github.com/advisories/GHSA-xxxx-yyyy-zzzz)',
    );
  });

  it('mixed: emits both subsections with correct counts', () => {
    const md = formatSecurityReport(
      makeReport({
        tool: 'npm-audit',
        critical: 1,
        high: 1,
        total: 2,
        findings: [
          {
            id: 'CVE-2024-0001',
            package: 'lodash',
            installedVersion: '4.17.20',
            fixedVersion: '4.17.21',
            tool: 'npm-audit',
            packId: 'typescript',
            severity: 'high',
          },
          {
            id: 'CVE-2024-0002',
            package: 'no-patch',
            installedVersion: '1.0.0',
            tool: 'npm-audit',
            severity: 'critical',
          },
        ],
      }),
      '1.0',
    );
    expect(md).toContain('### Actionable upgrades (1)');
    expect(md).toContain('### Mitigation required — no patch available (1)');
    // Mitigation-only entry must NOT bleed into the bash block.
    const bashBlock = md.split('```bash')[1]?.split('```')[0] ?? '';
    expect(bashBlock).toContain('lodash');
    expect(bashBlock).not.toContain('no-patch');
  });

  it('no findings: no Remediation Commands section emitted', () => {
    const md = formatSecurityReport(
      makeReport({ tool: 'npm-audit', total: 0, findings: [] }),
      '1.0',
    );
    expect(md).not.toContain('## Remediation Commands');
  });

  it('mitigation without references: falls back to plain ID', () => {
    const md = formatSecurityReport(
      makeReport({
        tool: 'npm-audit',
        total: 1,
        findings: [
          {
            id: 'CVE-2024-9999',
            package: 'unknown-ref',
            installedVersion: '0.1.0',
            tool: 'npm-audit',
            severity: 'low',
          },
        ],
      }),
      '1.0',
    );
    expect(md).toContain('### Mitigation required — no patch available (1)');
    expect(md).toContain('`unknown-ref@0.1.0` — CVE-2024-9999');
    expect(md).not.toContain('[CVE-2024-9999]');
  });
});

/**
 * G_v4_10 / D111 (2.4.7 Phase C3): dep-action title phrasing branches
 * on `fixedVersion`. Pre-fix the literal `Upgrade ${pkg} to
 * ${fixedVersion ?? '(no patch)'}` produced "Upgrade `SharpCompress`
 * to (no patch)" on dpl-studio Top 5 when D108 sparse-tier fallback
 * floated a mitigation-only finding into the table.
 *
 * The canonical helper is the only authorized site for this phrasing;
 * `scripts/check-architecture.sh` enforces it via G_v4_10. These tests
 * pin both the helper contract AND the integration through Top 5.
 */
describe('formatDepActionTitle (G_v4_10 / D111)', () => {
  it('phrases as "Upgrade" when fixedVersion is set', () => {
    expect(formatDepActionTitle('lodash', '4.17.21')).toBe('Upgrade `lodash` to 4.17.21');
  });

  it('phrases as "Review advisory" when fixedVersion is undefined', () => {
    expect(formatDepActionTitle('SharpCompress', undefined)).toBe(
      'Review advisory for `SharpCompress` — no patch available',
    );
  });

  it('phrases as "Review advisory" when fixedVersion is empty string', () => {
    expect(formatDepActionTitle('SharpCompress', '')).toBe(
      'Review advisory for `SharpCompress` — no patch available',
    );
  });

  it('regression — D108 × D111 intersection: mitigation-only finding in Top 5 uses Review-advisory phrasing', () => {
    // Reproduces dpl-studio's sparse-repo state: 1 mitigation-only
    // finding makes it into Top 5 via the D108 sparse-tier fallback.
    // Pre-D111 root fix this produced "Upgrade `SharpCompress` to (no
    // patch)" — grammatically nonsensical.
    const md = formatSecurityReport(
      makeReport({
        tool: 'osv-scanner-nuget-direct',
        total: 1,
        critical: 0,
        high: 0,
        medium: 1,
        low: 0,
        findings: [
          {
            id: 'GHSA-6c8g-7p36-r338',
            package: 'SharpCompress',
            installedVersion: '0.30.1',
            tool: 'osv-scanner-nuget-direct',
            packId: 'csharp',
            severity: 'medium',
            riskScore: 15,
          },
        ],
      }),
      '1.0',
    );
    expect(md).toContain('## 🎯 Top 5 Priority Actions');
    expect(md).toContain('Review advisory for `SharpCompress` — no patch available');
    // The broken pre-fix phrasing must NOT appear anywhere.
    expect(md).not.toContain('Upgrade `SharpCompress` to (no patch)');
    expect(md).not.toContain('to (no patch)');
  });

  it('regression — KEV tier mitigation-only also uses correct phrasing', () => {
    // Same root-fix branch covers KEV-listed mitigation-only deps.
    const md = formatSecurityReport(
      makeReport({
        tool: 'npm-audit',
        total: 1,
        critical: 1,
        findings: [
          {
            id: 'GHSA-KEV-XXXX',
            package: 'kev-no-patch',
            installedVersion: '1.0.0',
            tool: 'npm-audit',
            severity: 'critical',
            kev: true,
            riskScore: 90,
          },
        ],
      }),
      '1.0',
    );
    expect(md).toContain('## 🎯 Top 5 Priority Actions');
    expect(md).toContain('Review advisory for `kev-no-patch` — no patch available');
    expect(md).not.toContain('to (no patch)');
  });
});
