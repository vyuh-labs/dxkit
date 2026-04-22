/**
 * Licenses analyzer — detailed report.
 *
 * Extends the base LicensesReport with risk-categorized findings and a
 * ranked action list. Unlike security/test-gaps, licenses aren't
 * graded — there's no "license score" — so actions are prioritized by
 * legal risk tier (unknown → strong-copyleft → weak-copyleft →
 * missing-attribution) rather than by projected score delta.
 *
 * Both the markdown formatter and the XLSX converter (Phase 10h.2.3)
 * can consume this same `LicensesDetailedReport` shape.
 */

import type { LicenseFinding } from '../../languages/capabilities/types';
import type { LicensesReport } from './types';

/**
 * Strong-copyleft SPDX families. Prefix match covers `-or-later` /
 * `-only` / version variants (`GPL-2.0`, `GPL-2.0-or-later`, etc.).
 * Distribution/linking typically requires exposing downstream source,
 * which is disqualifying for most proprietary products.
 */
const STRONG_COPYLEFT_PREFIXES: ReadonlyArray<string> = ['GPL-', 'AGPL-'];

/**
 * Weak-copyleft SPDX families. File-level or module-level restrictions
 * — less restrictive than strong copyleft but still require review
 * before shipping in a proprietary binary.
 */
const WEAK_COPYLEFT_PREFIXES: ReadonlyArray<string> = ['LGPL-', 'MPL-', 'EPL-', 'CDDL-'];

function matchesAny(licenseType: string, prefixes: ReadonlyArray<string>): boolean {
  // license-checker may emit "GPL-3.0 OR MIT" compound expressions.
  // Split and test any term so a dual-licensed package still gets flagged.
  const terms = licenseType.split(/\s+OR\s+|\s+AND\s+|,\s*/);
  for (const term of terms) {
    for (const p of prefixes) {
      if (term.startsWith(p)) return true;
    }
  }
  return false;
}

export interface LicenseRiskCategory {
  /** Severity tier for ordering and display. */
  readonly priority: 'critical' | 'high' | 'medium' | 'low';
  /** Short category key — stable across runs for programmatic filtering. */
  readonly id:
    | 'unknown-license'
    | 'strong-copyleft'
    | 'weak-copyleft'
    | 'missing-license-text'
    | 'missing-supplier';
  readonly title: string;
  readonly rationale: string;
  readonly recommendation: string;
  readonly affected: ReadonlyArray<LicenseFinding>;
}

export interface LicensesDetailedReport extends LicensesReport {
  riskCategories: ReadonlyArray<LicenseRiskCategory>;
}

export function buildLicensesDetailed(report: LicensesReport): LicensesDetailedReport {
  const unknown = report.findings.filter(
    (f) => f.licenseType === 'UNKNOWN' || f.licenseType.length === 0,
  );
  const strongCopyleft = report.findings.filter((f) =>
    matchesAny(f.licenseType, STRONG_COPYLEFT_PREFIXES),
  );
  const weakCopyleft = report.findings.filter((f) =>
    matchesAny(f.licenseType, WEAK_COPYLEFT_PREFIXES),
  );
  const missingText = report.findings.filter(
    (f) =>
      (f.licenseType !== 'UNKNOWN' && !f.licenseText) ||
      (f.licenseText !== undefined && f.licenseText.length === 0),
  );
  const missingSupplier = report.findings.filter((f) => !f.supplier || f.supplier.length === 0);

  const categories: LicenseRiskCategory[] = [];

  if (unknown.length > 0) {
    categories.push({
      priority: 'critical',
      id: 'unknown-license',
      title: 'Unknown or unresolved licenses',
      rationale:
        'Packages with no detected license may not be safe to redistribute. Their absence of license metadata blocks any licensing guarantee.',
      recommendation:
        'Audit each package individually. Contact maintainers, check the source repository directly, or replace with a license-known alternative.',
      affected: unknown,
    });
  }

  if (strongCopyleft.length > 0) {
    categories.push({
      priority: 'high',
      id: 'strong-copyleft',
      title: 'Strong-copyleft licenses (GPL / AGPL)',
      rationale:
        'GPL/AGPL licenses typically require derivative works to be distributed under the same license, including source code. Shipping these inside proprietary products can trigger the copyleft clause.',
      recommendation:
        'For each package, determine whether it is linked statically/dynamically into a distributable artifact. Consult legal before shipping; consider MIT/Apache alternatives.',
      affected: strongCopyleft,
    });
  }

  if (weakCopyleft.length > 0) {
    categories.push({
      priority: 'medium',
      id: 'weak-copyleft',
      title: 'Weak-copyleft licenses (LGPL / MPL / EPL / CDDL)',
      rationale:
        'Weak-copyleft licenses apply only to modifications of the licensed files themselves, not to derivative works linking to them. Still subject to attribution and in some cases source-disclosure for modifications.',
      recommendation:
        'Safe to use unmodified in proprietary products; any modifications must be published under the same license. Document intent so a future reviewer doesn’t re-audit unchanged deps.',
      affected: weakCopyleft,
    });
  }

  if (missingText.length > 0) {
    categories.push({
      priority: 'medium',
      id: 'missing-license-text',
      title: 'Missing license text',
      rationale:
        'License type is known but the full text is absent. Attribution clauses typically require the license text be distributed with the binary or notice file.',
      recommendation:
        'Locate each package’s LICENSE file from its source repository and bundle in NOTICE / THIRD-PARTY.md. Most ecosystems ship the file in the package directory.',
      affected: missingText,
    });
  }

  if (missingSupplier.length > 0) {
    categories.push({
      priority: 'low',
      id: 'missing-supplier',
      title: 'Missing supplier or author metadata',
      rationale:
        'Provenance information is useful during security review (who published this? when?), compliance audits, and vulnerability triage.',
      recommendation:
        'Manual lookup via each ecosystem’s registry (npm view, PyPI, crates.io). Consider dropping packages with no identifiable maintainer.',
      affected: missingSupplier,
    });
  }

  return {
    ...report,
    riskCategories: categories,
  };
}

const PRIORITY_LABELS: Record<LicenseRiskCategory['priority'], string> = {
  critical: '🔴 Critical',
  high: '🟠 High',
  medium: '🟡 Medium',
  low: '🔵 Low',
};

export function formatLicensesDetailedMarkdown(
  detailed: LicensesDetailedReport,
  elapsed: string,
): string {
  const L: string[] = [];

  L.push('# License Inventory — Detailed');
  L.push('');
  L.push(`**Date:** ${detailed.analyzedAt.slice(0, 10)}`);
  L.push(`**Repository:** ${detailed.repo}`);
  L.push(`**Branch:** ${detailed.branch} (${detailed.commitSha})`);
  L.push(`**Schema version:** ${detailed.schemaVersion}`);
  L.push('');
  L.push('---');
  L.push('');

  // Summary
  L.push('## Summary');
  L.push('');
  L.push(
    `**${detailed.summary.totalPackages} packages** across ${Object.keys(detailed.summary.byLicense).length} distinct license types.`,
  );
  if (detailed.riskCategories.length > 0) {
    L.push('');
    const n = detailed.riskCategories.length;
    L.push(`**${n} risk categor${n === 1 ? 'y' : 'ies'} flagged** — see below.`);
  }
  L.push('');
  L.push('---');
  L.push('');

  // Risk categories
  L.push('## Risk Review');
  L.push('');
  if (detailed.riskCategories.length === 0) {
    L.push(
      'No licensing risks flagged. Every package has a known license, full text, and supplier metadata.',
    );
  } else {
    L.push('Categories are ranked by legal risk tier. Review top-to-bottom.');
    L.push('');
    L.push('| # | Category | Priority | Affected |');
    L.push('|---|----------|----------|---------:|');
    detailed.riskCategories.forEach((c, i) => {
      L.push(`| ${i + 1} | ${c.title} | ${PRIORITY_LABELS[c.priority]} | ${c.affected.length} |`);
    });
    L.push('');
    for (const c of detailed.riskCategories) {
      L.push(`### ${PRIORITY_LABELS[c.priority]} — ${c.title} (${c.affected.length})`);
      L.push('');
      L.push(`**Why:** ${c.rationale}`);
      L.push('');
      L.push(`**What to do:** ${c.recommendation}`);
      L.push('');
      L.push('| Package | Version | License |');
      L.push('|---------|---------|---------|');
      const rows = [...c.affected].sort((a, b) => a.package.localeCompare(b.package));
      for (const f of rows) {
        L.push(`| \`${f.package}\` | ${f.version} | ${f.licenseType || 'UNKNOWN'} |`);
      }
      L.push('');
    }
  }
  L.push('---');
  L.push('');

  // Full inventory — every field
  L.push('## Full Inventory');
  L.push('');
  if (detailed.findings.length === 0) {
    L.push('_No packages detected._');
  } else {
    L.push('| Package | Version | License | Supplier | Description | Source URL |');
    L.push('|---------|---------|---------|----------|-------------|------------|');
    const rows = [...detailed.findings].sort((a, b) => a.package.localeCompare(b.package));
    for (const f of rows) {
      const supplier = (f.supplier || '').replace(/\|/g, '\\|');
      const desc = (f.description || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120);
      const url = f.sourceUrl || '';
      L.push(
        `| \`${f.package}\` | ${f.version} | ${f.licenseType} | ${supplier} | ${desc} | ${url} |`,
      );
    }
  }
  L.push('');
  L.push('---');
  L.push('');

  // Footer
  L.push(`**Tools used:** ${detailed.toolsUsed.join(', ') || '(none)'}`);
  L.push(`**Analysis time:** ${elapsed}s`);
  L.push('');
  L.push('*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit)*');

  return L.join('\n');
}
