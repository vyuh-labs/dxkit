/**
 * Tests for the dashboard analyzer (D020).
 *
 * The dashboard is pure templating over a `.dxkit/reports/` directory
 * — no shell-outs, no analysis — so the tests synthesize a temp
 * reports directory with stub markdowns + JSON envelopes and assert
 * on the rendered HTML's structure and content.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyzeDashboard } from '../src/analyzers/dashboard';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-dashboard-'));
  fs.mkdirSync(path.join(tmp, '.dxkit', 'reports'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(tmp, '.dxkit', 'reports', rel);
  fs.writeFileSync(abs, content);
}

describe('analyzeDashboard', () => {
  it('throws a helpful error when the reports directory does not exist', () => {
    fs.rmSync(path.join(tmp, '.dxkit'), { recursive: true });
    expect(() => analyzeDashboard(tmp)).toThrow(/Reports directory not found/);
  });

  it('returns zero reports when the directory exists but is empty', () => {
    const result = analyzeDashboard(tmp);
    expect(result.reportCount).toBe(0);
    // HTML is still emitted (sidebar with just the Overview tab) — the
    // CLI decides whether to treat zero reports as an error.
    expect(result.html).toContain('<!DOCTYPE html>');
    expect(result.html).toContain('DXKit Dashboard');
  });

  it('renders every present report into its own sidebar tab', () => {
    write('health-audit-2026-05-11.md', '# Health Audit\n\nScore: 80/100.');
    write('vulnerability-scan-2026-05-11.md', '# Vulnerability Scan\n\n3 high-severity findings.');
    write('test-gaps-2026-05-11.md', '# Test Gaps\n\n12 untested files.');
    write('quality-review-2026-05-11.md', '# Code Quality\n\nSlop: 65/100.');

    const result = analyzeDashboard(tmp);
    expect(result.reportCount).toBe(4);
    expect(result.html).toContain('Health Audit');
    expect(result.html).toContain('Vulnerability Scan');
    expect(result.html).toContain('Test Gaps');
    expect(result.html).toContain('Code Quality');
    // Per-report markdown content is embedded for client-side rendering.
    expect(result.html).toContain('3 high-severity findings');
    expect(result.html).toContain('12 untested files');
  });

  it('prefers the -detailed.md variant over the plain markdown for the same date', () => {
    write('health-audit-2026-05-11.md', '# Health Audit (plain)');
    write('health-audit-2026-05-11-detailed.md', '# Health Audit (DETAILED — richer content)');

    const result = analyzeDashboard(tmp);
    expect(result.html).toContain('Health Audit (DETAILED — richer content)');
    expect(result.html).not.toContain('Health Audit (plain)');
  });

  it('synthesizes the Overview from -detailed.json files', () => {
    write('health-audit-2026-05-11.md', '# Health');
    write(
      'health-audit-2026-05-11-detailed.json',
      JSON.stringify({
        summary: { overallScore: 73, rating: 'B' },
        dimensions: {
          testing: { score: 60 },
          quality: { score: 80 },
          documentation: { score: 50 },
          security: { score: 85 },
          maintainability: { score: 70 },
          developerExperience: { score: 90 },
        },
      }),
    );
    write('vulnerability-scan-2026-05-11.md', '# Vuln');
    write(
      'vulnerability-scan-2026-05-11-detailed.json',
      JSON.stringify({
        findings: [
          { severity: 'critical', rule: 'sqli', file: 'src/db.ts', line: 42, tool: 'semgrep' },
          { severity: 'high', rule: 'xss', file: 'src/ui.ts', line: 7, tool: 'semgrep' },
        ],
      }),
    );

    const result = analyzeDashboard(tmp);
    expect(result.summary.healthScore).toBe(73);
    expect(result.summary.healthGrade).toBe('B');
    expect(result.summary.vulnCount).toBe(2);
    // Critical issues surfaced on Overview (top vulns).
    expect(result.criticalIssueCount).toBeGreaterThan(0);
    // Hero score is rendered in the HTML.
    expect(result.html).toContain('73');
    expect(result.html).toContain('Rating B');
    // Dimension breakdown shows each dimension name.
    expect(result.html).toContain('Testing');
    expect(result.html).toContain('Security');
  });

  it('aggregates dep-vulns from summary.dependencies.findings into the Vulnerabilities tile (regression guard)', () => {
    // Pre-fix bug (caught 2026-05-13 on the .NET WinForms benchmark):
    // the dashboard read only `vulns.findings` (code findings —
    // semgrep/gitleaks). Dependency vulnerabilities live in
    // `vulns.summary.dependencies.findings`. Reading only the code
    // array caused the Vulnerabilities tile to show 0 on the
    // benchmark even when osv-scanner-nuget-direct surfaced real CVEs. Both
    // streams must be unioned for tile counts AND for the "Critical
    // Issues at a Glance" surfacing.
    write('vulnerability-scan-2026-05-11.md', '# Vuln');
    write(
      'vulnerability-scan-2026-05-11-detailed.json',
      JSON.stringify({
        findings: [], // no code findings
        summary: {
          findings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
          dependencies: {
            critical: 0,
            high: 1,
            medium: 1,
            low: 0,
            total: 2,
            tool: 'osv-scanner-nuget-direct',
            findings: [
              {
                id: 'GHSA-7j9m-j397-g4wx',
                package: 'MongoDB.Driver',
                installedVersion: '2.13.1',
                tool: 'osv-scanner',
                severity: 'high',
              },
              {
                id: 'GHSA-6c8g-7p36-r338',
                package: 'SharpCompress',
                installedVersion: '0.30.1',
                tool: 'osv-scanner',
                severity: 'medium',
              },
            ],
          },
        },
      }),
    );

    const result = analyzeDashboard(tmp);
    // Tile total reflects union of code + dep findings (2 dep here).
    expect(result.summary.vulnCount).toBe(2);
    // Critical Issues section includes the HIGH dep-vuln (MongoDB).
    expect(result.criticalIssueCount).toBeGreaterThan(0);
    expect(result.html).toContain('GHSA-7j9m-j397-g4wx');
  });

  it('discloses allowlisted dep-vulns in the Vulnerabilities tile (#27)', () => {
    // An accepted dep advisory is annotated upstream (aggregator) and
    // serialized into summary.dependencies.findings; the dashboard tile
    // counts it as allowlisted so a reviewed-and-accepted CVE doesn't read
    // as un-triaged risk — same disclosure the vuln scan + BoM show.
    write('vulnerability-scan-2026-05-11.md', '# Vuln');
    write(
      'vulnerability-scan-2026-05-11-detailed.json',
      JSON.stringify({
        findings: [],
        summary: {
          findings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
          dependencies: {
            critical: 0,
            high: 1,
            medium: 0,
            low: 0,
            total: 1,
            tool: 'osv-scanner',
            findings: [
              {
                id: 'GHSA-accepted',
                package: 'left-pad',
                installedVersion: '1.0.0',
                tool: 'osv-scanner',
                severity: 'high',
                allowlisted: true,
                allowlistCategory: 'test-fixture',
              },
            ],
          },
        },
      }),
    );

    const result = analyzeDashboard(tmp);
    // The Vulnerabilities tile sub-line discloses the allowlisted dep-vuln.
    expect(result.html).toContain('1 allowlisted');
  });

  it('degrades gracefully when JSON envelopes are missing or malformed', () => {
    write('health-audit-2026-05-11.md', '# Health');
    write('health-audit-2026-05-11-detailed.json', '{ this is not valid json');

    const result = analyzeDashboard(tmp);
    // Reportcontent stillembedded; Overview just has no synthesis numbers.
    expect(result.reportCount).toBe(1);
    expect(result.summary.healthScore).toBeNull();
    expect(result.html).toContain('<!DOCTYPE html>');
  });

  it('escapes HTML in user-controlled strings', () => {
    const result = analyzeDashboard(tmp, { projectName: '<script>alert(1)</script>' });
    expect(result.html).not.toContain('<script>alert(1)</script>');
    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('derives projectName from package.json when not explicitly provided', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: '@scope/my-pkg', version: '1.0.0' }),
    );
    const result = analyzeDashboard(tmp);
    expect(result.html).toContain('@scope/my-pkg');
  });

  it('falls back to basename(cwd) when package.json is absent', () => {
    const result = analyzeDashboard(tmp);
    expect(result.html).toContain(path.basename(tmp));
  });

  it('embeds markdown as a JSON-safe payload that the client can render', () => {
    // The dashboard embeds report markdowns inside a <script type="application/json">
    // block. The implementation must escape `<` so the embedded content
    // cannot prematurely close the script tag.
    write('health-audit-2026-05-11.md', 'Look at this </script><script>alert("xss")</script>');
    const result = analyzeDashboard(tmp);
    // Raw closing-script-tag sequence must not appear unescaped inside
    // the embedded JSON.
    expect(result.html).not.toMatch(/<\/script><script>alert/);
    // The escaped form (`<`) must be present so the JS can decode
    // the original content client-side without triggering the parser.
    expect(result.html).toContain('\\u003c/script');
  });
});
