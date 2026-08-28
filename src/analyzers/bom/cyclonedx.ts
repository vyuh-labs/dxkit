/**
 * CycloneDX SBOM renderer: a PURE projection of the ONE BoM concept
 * (`BomEntry[]` + report metadata, Rule 2) into the standard interchange
 * format. No gathering happens here: every fact comes from the joined
 * license + dep-vuln data the bom gather already produced, and any field
 * the data cannot back is OMITTED, never padded with a placeholder.
 *
 * specVersion: 1.5. Everything this renderer emits (components with
 * purl + licenses + properties, vulnerabilities with source, ratings,
 * and affects) is fully expressible in 1.5, and 1.5 has the widest
 * consumer support (Dependency-Track, osv-scanner, Trivy, Grype all
 * accept it). The 1.6 additions (cryptographic assets, attestations,
 * ML-BOM extensions) model data dxkit does not gather, so claiming 1.6
 * would buy nothing and narrow the consumer set.
 *
 * SPDX-format export is deliberately NOT implemented here or elsewhere
 * yet: CycloneDX was chosen first because it is the vulnerability-
 * workflow interchange format (a first-class vulnerabilities section,
 * which SPDX lacks); an SPDX document export lands when a consumer
 * needs it.
 *
 * Determinism: the renderer takes its timestamp as an argument (the
 * caller passes the report's own `analyzedAt`; there is no inline
 * Date.now), emits no random serialNumber, and preserves the gather's
 * stable entry ordering, so identical input renders byte-identical
 * output, pinned by test.
 */

import { knownSpdxId, splitLicenseTerms } from '../licenses/detailed';
import { getLanguage } from '../../languages';
import { buildPurl } from './purl';
import type { BomEntry, BomReport } from './types';

/** CycloneDX severity enum values our four-tier severities map onto. */
export type CycloneDxSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface CycloneDxLicenseEntry {
  license?: { id?: string; name?: string };
  expression?: string;
}

export interface CycloneDxProperty {
  name: string;
  value: string;
}

export interface CycloneDxComponent {
  'bom-ref': string;
  type: 'library';
  name: string;
  version?: string;
  purl?: string;
  licenses?: CycloneDxLicenseEntry[];
  properties?: CycloneDxProperty[];
}

export interface CycloneDxRating {
  severity: CycloneDxSeverity;
  score?: number;
}

export interface CycloneDxVulnerability {
  id: string;
  source?: { name: string; url?: string };
  description?: string;
  ratings: CycloneDxRating[];
  affects: Array<{ ref: string }>;
}

export interface CycloneDxDocument {
  bomFormat: 'CycloneDX';
  specVersion: '1.5';
  version: 1;
  metadata: {
    timestamp: string;
    tools: {
      components: Array<{ type: 'application'; name: string; version: string }>;
    };
    component: { 'bom-ref': string; type: 'application'; name: string };
  };
  components: CycloneDxComponent[];
  vulnerabilities?: CycloneDxVulnerability[];
}

export interface CycloneDxOptions {
  /** ISO timestamp for metadata.timestamp: injected, never Date.now
   *  inline. The CLI passes the report's own `analyzedAt` so the SBOM
   *  is stamped with the same instant as every other rendering of that
   *  gather. */
  timestamp: string;
  /** The generating dxkit version, for metadata.tools. */
  dxkitVersion: string;
}

/**
 * Advisory source derived from the id's namespace, a factual mapping
 * (GHSA ids ARE GitHub Advisory Database ids), never a guess: an
 * unrecognized scheme yields no source field at all.
 */
export function advisorySource(id: string): { name: string; url?: string } | undefined {
  if (/^GHSA-/.test(id)) {
    return { name: 'GitHub Advisory Database', url: `https://github.com/advisories/${id}` };
  }
  if (/^CVE-/.test(id)) {
    return { name: 'NVD', url: `https://nvd.nist.gov/vuln/detail/${id}` };
  }
  if (/^RUSTSEC-/.test(id)) {
    return { name: 'RustSec Advisory Database', url: `https://rustsec.org/advisories/${id}` };
  }
  if (/^(PYSEC|OSV)-/.test(id)) {
    return { name: 'OSV', url: `https://osv.dev/vulnerability/${id}` };
  }
  if (/^GO-\d{4}-/.test(id)) {
    return { name: 'Go Vulnerability Database', url: `https://pkg.go.dev/vuln/${id}` };
  }
  return undefined;
}

/**
 * License representation for one BoM row, per the honesty rules:
 * - 'UNKNOWN' / empty → undefined (no license claim at all);
 * - a single term that IS a known SPDX id → the id form;
 * - a compound OR/AND expression whose every term is a known SPDX id →
 *   the SPDX expression form (the string as gathered);
 * - anything else → the free-form name form (always spec-valid).
 * Id validity routes through the ONE `knownSpdxId` predicate in the
 * licenses module (Rule 2): no second SPDX list here.
 */
export function cycloneDxLicenses(licenseType: string): CycloneDxLicenseEntry[] | undefined {
  const raw = licenseType.trim();
  if (raw.length === 0 || raw === 'UNKNOWN') return undefined;
  const terms = splitLicenseTerms(raw);
  if (terms.length === 1) {
    const id = knownSpdxId(terms[0]);
    return id ? [{ license: { id } }] : [{ license: { name: raw } }];
  }
  const isPureExpression = /^[^,]+$/.test(raw) && /\s(OR|AND)\s/.test(raw);
  if (isPureExpression && terms.every((t) => knownSpdxId(t) !== null)) {
    return [{ expression: raw }];
  }
  return [{ license: { name: raw } }];
}

/** Render the CycloneDX document object from the one BoM report. */
export function toCycloneDx(report: BomReport, opts: CycloneDxOptions): CycloneDxDocument {
  const usedRefs = new Set<string>();
  // The root application's own bom-ref participates in the same
  // uniqueness domain as the component refs, so it is claimed first: a
  // library that happened to reduce to the same key gets the ordinal.
  const rootRef = `app:${report.repo}`;
  usedRefs.add(rootRef);
  const components: CycloneDxComponent[] = [];
  const refByEntry = new Map<BomEntry, string>();

  for (const entry of report.entries) {
    const purlType = entry.packId ? getLanguage(entry.packId)?.purlType : undefined;
    const purl = purlType ? buildPurl(purlType, entry.package, entry.version) : null;

    // bom-ref: the purl when derivable (globally unique by construction),
    // else the join key. A collision (two rows reducing to one key) gets
    // a disambiguating ordinal so refs stay unique (required for
    // `affects` resolution).
    let ref = purl ?? `${entry.package}@${entry.version}`;
    if (usedRefs.has(ref)) {
      let n = 2;
      while (usedRefs.has(`${ref}#${n}`)) n++;
      ref = `${ref}#${n}`;
    }
    usedRefs.add(ref);
    refByEntry.set(entry, ref);

    const properties: CycloneDxProperty[] = [];
    if (entry.packId) {
      properties.push({ name: 'dxkit:ecosystem', value: entry.packId });
    }
    if (!purl) {
      // Disclosed, never fabricated: say WHY this row carries no purl.
      const reason = !entry.packId
        ? 'ecosystem-unknown'
        : !purlType
          ? `no-purl-type-for-${entry.packId}`
          : `not-derivable-for-${purlType}`;
      properties.push({ name: 'dxkit:purl-omitted', value: reason });
    }

    const licenses = cycloneDxLicenses(entry.licenseType);
    components.push({
      'bom-ref': ref,
      type: 'library',
      name: entry.package,
      ...(entry.version && entry.version !== 'unknown' ? { version: entry.version } : {}),
      ...(purl ? { purl } : {}),
      ...(licenses ? { licenses } : {}),
      ...(properties.length > 0 ? { properties } : {}),
    });
  }

  // One vulnerability per advisory id, with `affects` unioning every
  // component the advisory was reported against (the same advisory on
  // two package rows is one CycloneDX vulnerability affecting both).
  const vulnById = new Map<string, CycloneDxVulnerability>();
  for (const entry of report.entries) {
    const ref = refByEntry.get(entry)!;
    for (const v of entry.vulns) {
      const rating: CycloneDxRating = {
        // Our four-tier severity IS a subset of the CycloneDX enum.
        severity: v.severity,
        ...(typeof v.cvssScore === 'number' ? { score: v.cvssScore } : {}),
      };
      const existing = vulnById.get(v.id);
      if (existing) {
        if (!existing.affects.some((a) => a.ref === ref)) existing.affects.push({ ref });
        // Distinct ratings union: another scan of the same advisory may
        // carry a different severity or score (a fact, so it is kept),
        // while an identical rating is not repeated.
        if (
          !existing.ratings.some((r) => r.severity === rating.severity && r.score === rating.score)
        ) {
          existing.ratings.push(rating);
        }
        continue;
      }
      const source = advisorySource(v.id);
      vulnById.set(v.id, {
        id: v.id,
        ...(source ? { source } : {}),
        ...(v.summary ? { description: v.summary } : {}),
        ratings: [rating],
        affects: [{ ref }],
      });
    }
  }
  // Plain codepoint comparison, not localeCompare: the anchor writer's
  // unchanged-skip depends on byte-identical output across hosts, and
  // localeCompare answers per the host locale.
  const vulnerabilities = [...vulnById.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp: opts.timestamp,
      tools: {
        components: [{ type: 'application', name: '@vyuhlabs/dxkit', version: opts.dxkitVersion }],
      },
      component: { 'bom-ref': rootRef, type: 'application', name: report.repo },
    },
    components,
    ...(vulnerabilities.length > 0 ? { vulnerabilities } : {}),
  };
}

/** Serialize the document with a stable layout (2-space indent, trailing
 *  newline) so identical input is byte-identical output. */
export function renderCycloneDx(report: BomReport, opts: CycloneDxOptions): string {
  return JSON.stringify(toCycloneDx(report, opts), null, 2) + '\n';
}
