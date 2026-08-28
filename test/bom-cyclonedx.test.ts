/**
 * CycloneDX SBOM export (4.4.7 S1).
 *
 * Pins the renderer's honesty contract (fields come from gathered data
 * or are omitted; purls are derived from pack-declared ecosystems or
 * disclosed as omitted, never fabricated), the structural validity of
 * the document (unique bom-refs, affects references resolve), purl
 * derivation per ecosystem, license representation through the ONE
 * SPDX helper, byte determinism, ecosystem threading through the bom
 * gather, and the reports-snapshot pickup of the persisted SBOM file.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPurl, SUPPORTED_PURL_TYPES } from '../src/analyzers/bom/purl';
import {
  advisorySource,
  cycloneDxLicenses,
  renderCycloneDx,
  toCycloneDx,
} from '../src/analyzers/bom/cyclonedx';
import { gatherBomEntries } from '../src/analyzers/bom/gather';
import { stampLicensePackId } from '../src/analyzers/licenses/gather';
import { knownSpdxId, splitLicenseTerms } from '../src/analyzers/licenses/detailed';
import { getCommand } from '../src/discovery/commands';
import { collectArtifacts } from '../src/reports-cli';
import type { BomEntry, BomReport, BomSeverity } from '../src/analyzers/bom/types';
import type { DepVulnFinding, LicensesResult } from '../src/languages/capabilities/types';
import type { DepVulnSummary } from '../src/analyzers/security/types';

function vuln(over: Partial<DepVulnFinding> & { id: string; package: string }): DepVulnFinding {
  return { severity: 'high', tool: 'osv-scanner', ...over };
}

function entry(over: Partial<BomEntry> & { package: string; version: string }): BomEntry {
  return {
    licenseType: 'MIT',
    vulns: [],
    maxSeverity: null,
    upgradeAdvice: '',
    joinedFromBoth: true,
    ...over,
  };
}

function report(entries: BomEntry[]): BomReport {
  const bySeverity: Record<BomSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  return {
    repo: 'sample-repo',
    analyzedAt: '2026-08-28T00:00:00.000Z',
    commitSha: 'abc1234',
    branch: 'main',
    schemaVersion: '1',
    summary: {
      totalPackages: entries.length,
      bySeverity,
      vulnerablePackages: 0,
      actionableVulns: 0,
      totalAdvisories: 0,
      allowlistedAdvisories: 0,
      vulnOnlyPackages: 0,
      byTopLevelDep: {},
      filter: 'all',
      unfilteredTotalPackages: entries.length,
      projectRoots: ['.'],
      fingerprints: [],
    },
    entries,
    toolsUsed: [],
    toolsUnavailable: [],
  };
}

const OPTS = { timestamp: '2026-08-28T00:00:00.000Z', dxkitVersion: '4.4.7-test' };

describe('buildPurl (per-ecosystem derivation)', () => {
  it('npm: unscoped and scoped (scope percent-encoded into the namespace)', () => {
    expect(buildPurl('npm', 'lodash', '4.17.21')).toBe('pkg:npm/lodash@4.17.21');
    expect(buildPurl('npm', '@scope/pkg', '1.0.0')).toBe('pkg:npm/%40scope/pkg@1.0.0');
  });

  it('pypi: PEP 503 normalization (lowercase, underscore and dot fold to hyphen)', () => {
    expect(buildPurl('pypi', 'Typing_Extensions', '4.8.0')).toBe(
      'pkg:pypi/typing-extensions@4.8.0',
    );
    expect(buildPurl('pypi', 'zope.interface', '6.0')).toBe('pkg:pypi/zope-interface@6.0');
  });

  it('golang: module path splits into namespace + name, lowercased', () => {
    expect(buildPurl('golang', 'github.com/BurntSushi/toml', 'v1.2.0')).toBe(
      'pkg:golang/github.com/burntsushi/toml@v1.2.0',
    );
    expect(buildPurl('golang', 'gopkg.in/yaml.v3', 'v3.0.1')).toBe(
      'pkg:golang/gopkg.in/yaml.v3@v3.0.1',
    );
  });

  it('maven: group:artifact splits at the colon; colon-less names cannot derive', () => {
    expect(buildPurl('maven', 'org.apache.commons:commons-lang3', '3.12.0')).toBe(
      'pkg:maven/org.apache.commons/commons-lang3@3.12.0',
    );
    expect(buildPurl('maven', 'commons-lang3', '3.12.0')).toBeNull();
  });

  it('composer: vendor/name splits at the slash; vendor-less names cannot derive', () => {
    expect(buildPurl('composer', 'guzzlehttp/guzzle', '7.8.0')).toBe(
      'pkg:composer/guzzlehttp/guzzle@7.8.0',
    );
    expect(buildPurl('composer', 'guzzle', '7.8.0')).toBeNull();
  });

  it('cargo / gem / nuget: plain name, no namespace', () => {
    expect(buildPurl('cargo', 'serde', '1.0.190')).toBe('pkg:cargo/serde@1.0.190');
    expect(buildPurl('gem', 'rails', '7.1.2')).toBe('pkg:gem/rails@7.1.2');
    expect(buildPurl('nuget', 'Newtonsoft.Json', '13.0.3')).toBe(
      'pkg:nuget/Newtonsoft.Json@13.0.3',
    );
  });

  it('percent-encodes version metadata (+ becomes %2B)', () => {
    expect(buildPurl('cargo', 'openssl', '0.10.55+echo.1')).toBe(
      'pkg:cargo/openssl@0.10.55%2Becho.1',
    );
  });

  it('fails closed on unknown types and unusable inputs', () => {
    expect(buildPurl('swiftpm-made-up', 'x', '1.0.0')).toBeNull();
    expect(buildPurl('npm', '', '1.0.0')).toBeNull();
    expect(buildPurl('npm', 'x', '')).toBeNull();
    expect(buildPurl('npm', 'x', 'unknown')).toBeNull();
  });

  it('supported-type set matches the switch (every listed type derives something)', () => {
    for (const type of SUPPORTED_PURL_TYPES) {
      const name = type === 'maven' ? 'g:a' : type === 'composer' ? 'v/n' : 'name';
      expect(buildPurl(type, name, '1.0.0'), type).not.toBeNull();
    }
  });
});

describe('license representation (through the ONE SPDX helper)', () => {
  it('splitLicenseTerms splits OR / AND / comma forms', () => {
    expect(splitLicenseTerms('MIT OR Apache-2.0')).toEqual(['MIT', 'Apache-2.0']);
    expect(splitLicenseTerms('MIT, ISC')).toEqual(['MIT', 'ISC']);
    expect(splitLicenseTerms('MIT')).toEqual(['MIT']);
  });

  it('knownSpdxId answers known, deprecated-known, and unknown ids', () => {
    expect(knownSpdxId('MIT')).toBe('MIT');
    expect(knownSpdxId('GPL-3.0')).toBe('GPL-3.0');
    expect(knownSpdxId('Custom Corp License')).toBeNull();
  });

  it('a known single id renders as the SPDX id form', () => {
    expect(cycloneDxLicenses('MIT')).toEqual([{ license: { id: 'MIT' } }]);
  });

  it('an unknown license string renders as the name form (never a fake id)', () => {
    expect(cycloneDxLicenses('Custom Corp License')).toEqual([
      { license: { name: 'Custom Corp License' } },
    ]);
  });

  it('a compound expression of known ids renders as an SPDX expression', () => {
    expect(cycloneDxLicenses('MIT OR Apache-2.0')).toEqual([{ expression: 'MIT OR Apache-2.0' }]);
  });

  it('a compound with an unknown term falls back to the name form', () => {
    expect(cycloneDxLicenses('MIT OR SeenNowhere-1.0')).toEqual([
      { license: { name: 'MIT OR SeenNowhere-1.0' } },
    ]);
  });

  it('UNKNOWN and empty make no license claim at all', () => {
    expect(cycloneDxLicenses('UNKNOWN')).toBeUndefined();
    expect(cycloneDxLicenses('')).toBeUndefined();
  });
});

describe('toCycloneDx (document structure + honesty)', () => {
  const fullEntry = entry({
    package: '@scope/web',
    version: '2.0.0',
    packId: 'typescript',
    licenseType: 'MIT',
    maxSeverity: 'high',
    vulns: [
      vuln({
        id: 'GHSA-aaaa-bbbb-cccc',
        package: '@scope/web',
        installedVersion: '2.0.0',
        severity: 'high',
        cvssScore: 8.1,
        summary: 'Prototype pollution',
        packId: 'typescript',
      }),
    ],
  });
  const pyEntry = entry({
    package: 'requests',
    version: '2.31.0',
    packId: 'python',
    licenseType: 'Apache-2.0',
  });
  const noEcosystem = entry({
    package: 'mystery',
    version: '1.0.0',
    licenseType: 'UNKNOWN',
    joinedFromBoth: false,
  });

  const doc = toCycloneDx(report([fullEntry, pyEntry, noEcosystem]), OPTS);

  it('carries the required top-level fields', () => {
    expect(doc.bomFormat).toBe('CycloneDX');
    expect(doc.specVersion).toBe('1.5');
    expect(doc.version).toBe(1);
    expect(doc.metadata.timestamp).toBe(OPTS.timestamp);
    expect(doc.metadata.tools.components[0]).toEqual({
      type: 'application',
      name: '@vyuhlabs/dxkit',
      version: '4.4.7-test',
    });
    expect(doc.metadata.component).toEqual({
      'bom-ref': 'app:sample-repo',
      type: 'application',
      name: 'sample-repo',
    });
  });

  it('derives purls from the pack-declared ecosystem', () => {
    const [ts, py] = doc.components;
    expect(ts.purl).toBe('pkg:npm/%40scope/web@2.0.0');
    expect(py.purl).toBe('pkg:pypi/requests@2.31.0');
  });

  it('a row with no ecosystem carries bom-ref only, with the omission disclosed', () => {
    const c = doc.components[2];
    expect(c.purl).toBeUndefined();
    expect(c['bom-ref']).toBe('mystery@1.0.0');
    expect(c.properties).toContainEqual({ name: 'dxkit:purl-omitted', value: 'ecosystem-unknown' });
  });

  it('a known ecosystem is disclosed as a property', () => {
    expect(doc.components[0].properties).toContainEqual({
      name: 'dxkit:ecosystem',
      value: 'typescript',
    });
  });

  it('bom-refs are unique and every affects ref resolves', () => {
    const refs = doc.components.map((c) => c['bom-ref']);
    expect(new Set(refs).size).toBe(refs.length);
    for (const v of doc.vulnerabilities ?? []) {
      for (const a of v.affects) {
        expect(refs, `unresolved affects ref ${a.ref}`).toContain(a.ref);
      }
    }
  });

  it('renders vulnerabilities with source, rating, and description from gathered facts', () => {
    expect(doc.vulnerabilities).toHaveLength(1);
    const v = doc.vulnerabilities![0];
    expect(v.id).toBe('GHSA-aaaa-bbbb-cccc');
    expect(v.source).toEqual({
      name: 'GitHub Advisory Database',
      url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
    });
    expect(v.ratings).toEqual([{ severity: 'high', score: 8.1 }]);
    expect(v.description).toBe('Prototype pollution');
    expect(v.affects).toEqual([{ ref: 'pkg:npm/%40scope/web@2.0.0' }]);
  });

  it('omits the vulnerabilities section entirely when there are none', () => {
    const clean = toCycloneDx(report([pyEntry]), OPTS);
    expect(clean.vulnerabilities).toBeUndefined();
  });

  it('a rating without a cvssScore carries severity only (no invented score)', () => {
    const e = entry({
      package: 'x',
      version: '1.0.0',
      packId: 'ruby',
      vulns: [vuln({ id: 'CVE-2024-0001', package: 'x', severity: 'low' })],
    });
    const d = toCycloneDx(report([e]), OPTS);
    expect(d.vulnerabilities![0].ratings).toEqual([{ severity: 'low' }]);
  });

  it('one advisory across two packages becomes one vulnerability affecting both', () => {
    const a = entry({
      package: 'liba',
      version: '1.0.0',
      packId: 'rust',
      vulns: [vuln({ id: 'RUSTSEC-2024-0001', package: 'liba', severity: 'medium' })],
    });
    const b = entry({
      package: 'libb',
      version: '2.0.0',
      packId: 'rust',
      vulns: [vuln({ id: 'RUSTSEC-2024-0001', package: 'libb', severity: 'medium' })],
    });
    const d = toCycloneDx(report([a, b]), OPTS);
    expect(d.vulnerabilities).toHaveLength(1);
    expect(d.vulnerabilities![0].affects).toEqual([
      { ref: 'pkg:cargo/liba@1.0.0' },
      { ref: 'pkg:cargo/libb@2.0.0' },
    ]);
  });

  it('a colliding fallback ref is disambiguated so refs stay unique', () => {
    const a = entry({ package: 'dup', version: '1.0.0' });
    const b = entry({ package: 'dup', version: '1.0.0' });
    const d = toCycloneDx(report([a, b]), OPTS);
    const refs = d.components.map((c) => c['bom-ref']);
    expect(new Set(refs).size).toBe(2);
  });

  it('an entry with version "unknown" omits the version field', () => {
    const e = entry({ package: 'ghost', version: 'unknown', joinedFromBoth: false });
    const d = toCycloneDx(report([e]), OPTS);
    expect(d.components[0].version).toBeUndefined();
    expect(d.components[0].purl).toBeUndefined();
  });

  it('is byte-deterministic: same input + same injected timestamp', () => {
    const r = report([fullEntry, pyEntry, noEcosystem]);
    expect(renderCycloneDx(r, OPTS)).toBe(renderCycloneDx(r, OPTS));
    expect(renderCycloneDx(r, OPTS).endsWith('\n')).toBe(true);
  });
});

describe('advisorySource', () => {
  it('maps known id schemes and stays silent on unknown ones', () => {
    expect(advisorySource('CVE-2024-1234')?.name).toBe('NVD');
    expect(advisorySource('PYSEC-2024-1')?.name).toBe('OSV');
    expect(advisorySource('GO-2024-1234')?.name).toBe('Go Vulnerability Database');
    expect(advisorySource('VENDOR-XYZ-1')).toBeUndefined();
  });
});

describe('ecosystem threading (gather to entry)', () => {
  it('stampLicensePackId stamps every finding once, idempotently', () => {
    const env: LicensesResult = {
      schemaVersion: 1,
      tool: 'license-checker',
      findings: [
        { package: 'a', version: '1.0.0', licenseType: 'MIT' },
        { package: 'b', version: '2.0.0', licenseType: 'ISC', packId: 'python' },
      ],
    };
    const stamped = stampLicensePackId(env, 'typescript');
    expect(stamped.findings[0].packId).toBe('typescript');
    // An already-stamped finding keeps its provenance.
    expect(stamped.findings[1].packId).toBe('python');
  });

  it('gatherBomEntries threads packId from the license row, and from vulns for vuln-only rows', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-bom-eco-'));
    try {
      const licenses: LicensesResult = {
        schemaVersion: 1,
        tool: 'license-checker',
        findings: [
          { package: 'left-pad', version: '1.3.0', licenseType: 'MIT', packId: 'typescript' },
        ],
      };
      const depVulns: DepVulnSummary = {
        critical: 0,
        high: 1,
        medium: 0,
        low: 0,
        total: 1,
        tool: 'osv-scanner',
        findings: [
          vuln({
            id: 'GHSA-vuln-only-0001',
            package: 'orphan-pkg',
            installedVersion: '0.1.0',
            packId: 'python',
          }),
        ],
      } as DepVulnSummary;
      const { entries } = await gatherBomEntries(tmp, {
        licensesOverride: licenses,
        depVulnsOverride: depVulns,
      });
      const licensed = entries.find((e) => e.package === 'left-pad');
      const vulnOnly = entries.find((e) => e.package === 'orphan-pkg');
      expect(licensed?.packId).toBe('typescript');
      expect(vulnOnly?.packId).toBe('python');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('discovery + snapshot pickup', () => {
  it('sbom resolves as an alias of bom', () => {
    const cmd = getCommand('sbom');
    expect(cmd?.id).toBe('bom');
  });

  it('collectArtifacts publishes the newest bom-*.cdx.json as sbom.cdx.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-sbom-artifacts-'));
    try {
      const reportsDir = path.join(tmp, '.dxkit', 'reports');
      fs.mkdirSync(reportsDir, { recursive: true });
      fs.writeFileSync(path.join(reportsDir, 'bom-2026-01-01.cdx.json'), '{"old":true}');
      fs.writeFileSync(path.join(reportsDir, 'bom-2026-08-28.cdx.json'), '{"new":true}');
      const artifacts = collectArtifacts(tmp);
      const sbom = artifacts.find((a) => a.path === 'sbom.cdx.json');
      expect(sbom?.content).toBe('{"new":true}');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('collectArtifacts emits no sbom artifact when none was rendered', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-sbom-none-'));
    try {
      fs.mkdirSync(path.join(tmp, '.dxkit', 'reports'), { recursive: true });
      const artifacts = collectArtifacts(tmp);
      expect(artifacts.find((a) => a.path === 'sbom.cdx.json')).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
