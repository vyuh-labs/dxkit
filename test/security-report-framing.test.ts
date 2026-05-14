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
import { formatSecurityReport } from '../src/analyzers/security';
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
