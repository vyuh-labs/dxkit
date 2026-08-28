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

/**
 * The ONE SPDX-expression matcher (Rule 2): the risk-category tiers here AND
 * the prohibited-license producer both resolve "does this license match any
 * of these ids/prefixes?" through it. Compound expressions
 * ("GPL-3.0 OR MIT", "X AND Y", comma lists) are split and any term tested,
 * so a dual-licensed package still matches; matching is prefix-based per
 * term, so a family prefix ("GPL-") covers its variants and an exact id
 * ("AGPL-3.0") matches itself.
 */
export function licenseMatchesAny(licenseType: string, prefixes: ReadonlyArray<string>): boolean {
  for (const term of splitLicenseTerms(licenseType)) {
    for (const p of prefixes) {
      if (term.startsWith(p)) return true;
    }
  }
  return false;
}

/**
 * The ONE compound-license-expression splitter (Rule 2). "GPL-3.0 OR MIT",
 * "X AND Y" and comma lists split to their individual terms; both the risk
 * matcher above and the CycloneDX SBOM export's license rendering route
 * through it, so a second expression parser never grows elsewhere.
 */
export function splitLicenseTerms(licenseType: string): string[] {
  return licenseType.split(/\s+OR\s+|\s+AND\s+|,\s*/).filter((t) => t.length > 0);
}

/**
 * SPDX ids the license gathers are known to emit, for exact-id claims
 * (the CycloneDX `license.id` field is schema-restricted to the SPDX
 * enum, so a wrong claim makes the document invalid). This is a curated
 * subset of the SPDX list, deliberately biased toward false NEGATIVES:
 * a valid id missing here renders as the license NAME form instead,
 * which stays spec-valid and honest; an id present here but wrong
 * would not. Extend the set here (never a second list elsewhere) when
 * a gather starts emitting an id it lacks.
 */
const KNOWN_SPDX_IDS: ReadonlySet<string> = new Set([
  '0BSD',
  'AFL-3.0',
  'AGPL-1.0-only',
  'AGPL-1.0-or-later',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'Apache-1.1',
  'Apache-2.0',
  'Artistic-1.0',
  'Artistic-2.0',
  'BlueOak-1.0.0',
  'BSD-1-Clause',
  'BSD-2-Clause',
  'BSD-2-Clause-Patent',
  'BSD-3-Clause',
  'BSD-3-Clause-Clear',
  'BSD-4-Clause',
  'BSL-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC-BY-SA-3.0',
  'CC-BY-SA-4.0',
  'CC0-1.0',
  'CDDL-1.0',
  'CDDL-1.1',
  'ECL-2.0',
  'EPL-1.0',
  'EPL-2.0',
  'EUPL-1.1',
  'EUPL-1.2',
  'GPL-1.0-only',
  'GPL-1.0-or-later',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-2.0-only',
  'LGPL-2.0-or-later',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MPL-1.1',
  'MPL-2.0',
  'MS-PL',
  'MS-RL',
  'OFL-1.1',
  'OSL-3.0',
  'PostgreSQL',
  'PSF-2.0',
  'Python-2.0',
  'Ruby',
  'Unicode-DFS-2016',
  'Unlicense',
  'UPL-1.0',
  'WTFPL',
  'Zlib',
  'ZPL-2.1',
]);

/**
 * Deprecated-but-ubiquitous SPDX ids the ecosystems still ship (npm
 * metadata predates the `-only`/`-or-later` split). Still valid ids in
 * the SPDX list (marked deprecated), so claiming them is honest.
 */
const KNOWN_DEPRECATED_SPDX_IDS: ReadonlySet<string> = new Set([
  'AGPL-1.0',
  'AGPL-3.0',
  'GPL-1.0',
  'GPL-2.0',
  'GPL-2.0+',
  'GPL-3.0',
  'GPL-3.0+',
  'LGPL-2.0',
  'LGPL-2.1',
  'LGPL-2.1+',
  'LGPL-3.0',
  'LGPL-3.0+',
]);

/**
 * The ONE "is this string a known SPDX id?" predicate (Rule 2). Returns
 * the id itself for a single term found in the curated set, else null
 * (compound expressions, unknown ids, and 'UNKNOWN' all return null;
 * callers fall back to the free-form name representation).
 */
export function knownSpdxId(term: string): string | null {
  const t = term.trim();
  return KNOWN_SPDX_IDS.has(t) || KNOWN_DEPRECATED_SPDX_IDS.has(t) ? t : null;
}

const matchesAny = licenseMatchesAny;

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
