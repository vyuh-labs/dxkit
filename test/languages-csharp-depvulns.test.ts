import { describe, it, expect } from 'vitest';
import {
  parseDotnetVulnerableOutput,
  parseProjectAssetsJson,
  buildCsharpTopLevelDepIndex,
} from '../src/languages/csharp';

// Fixture JSONs mirror the dotnet list package --vulnerable --format json
// schema documented at
// https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-list-package.
// Used in lieu of a real .NET SDK on the dev machine; full pipeline
// validation runs at 10h.5 release time on equipped machine.

describe('parseDotnetVulnerableOutput', () => {
  it('returns null for malformed JSON', () => {
    expect(parseDotnetVulnerableOutput('not json')).toBeNull();
  });

  it('returns empty results when projects array is absent', () => {
    const parsed = parseDotnetVulnerableOutput(JSON.stringify({ version: 1 }))!;
    expect(parsed.findings).toEqual([]);
    expect(parsed.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });

  it('extracts a complete advisory with GHSA URL', () => {
    const raw = JSON.stringify({
      version: 1,
      projects: [
        {
          path: '/repo/foo.csproj',
          frameworks: [
            {
              framework: 'net8.0',
              topLevelPackages: [
                {
                  id: 'Microsoft.AspNetCore.App',
                  requestedVersion: '8.0.0',
                  resolvedVersion: '8.0.0',
                  advisories: [
                    {
                      advisoryUrl: 'https://github.com/advisories/GHSA-h5c3-5r3r-rr8q',
                      severity: 'high',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const parsed = parseDotnetVulnerableOutput(raw)!;
    expect(parsed.counts).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
    expect(parsed.findings).toHaveLength(1);
    const f = parsed.findings[0];
    expect(f.id).toBe('GHSA-H5C3-5R3R-RR8Q');
    expect(f.package).toBe('Microsoft.AspNetCore.App');
    expect(f.installedVersion).toBe('8.0.0');
    expect(f.tool).toBe('dotnet-vulnerable');
    expect(f.severity).toBe('high');
    expect(f.aliases).toEqual(['GHSA-H5C3-5R3R-RR8Q']);
    expect(f.references).toEqual(['https://github.com/advisories/GHSA-h5c3-5r3r-rr8q']);
    // dotnet --vulnerable doesn't ship CVSS or fix-version data
    expect(f.cvssScore).toBeUndefined();
    expect(f.fixedVersion).toBeUndefined();
  });

  it('maps moderate → medium (NuGet vocabulary)', () => {
    const raw = JSON.stringify({
      projects: [
        {
          frameworks: [
            {
              topLevelPackages: [
                {
                  id: 'foo',
                  resolvedVersion: '1.0.0',
                  advisories: [
                    {
                      advisoryUrl: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
                      severity: 'moderate',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const parsed = parseDotnetVulnerableOutput(raw)!;
    expect(parsed.findings[0].severity).toBe('medium');
    expect(parsed.counts).toEqual({ critical: 0, high: 0, medium: 1, low: 0 });
  });

  it('falls back to synthetic id when GHSA URL is missing', () => {
    const raw = JSON.stringify({
      projects: [
        {
          frameworks: [
            {
              topLevelPackages: [
                {
                  id: 'foo',
                  resolvedVersion: '1.0.0',
                  advisories: [{ severity: 'low' }],
                },
              ],
            },
          ],
        },
      ],
    });
    const parsed = parseDotnetVulnerableOutput(raw)!;
    expect(parsed.findings[0].id).toBe('nuget-foo@1.0.0');
    expect(parsed.findings[0].aliases).toBeUndefined();
    expect(parsed.findings[0].references).toBeUndefined();
  });

  it('skips packages with no id', () => {
    const raw = JSON.stringify({
      projects: [
        {
          frameworks: [
            {
              topLevelPackages: [
                {
                  resolvedVersion: '1.0.0',
                  advisories: [{ severity: 'high' }],
                },
                {
                  id: 'good',
                  resolvedVersion: '2.0.0',
                  advisories: [{ severity: 'high' }],
                },
              ],
            },
          ],
        },
      ],
    });
    const parsed = parseDotnetVulnerableOutput(raw)!;
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].package).toBe('good');
    // Only the surviving advisory contributes to counts — no double-count
    expect(parsed.counts).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
  });

  it('aggregates across multiple projects, frameworks, packages', () => {
    const raw = JSON.stringify({
      projects: [
        {
          frameworks: [
            {
              topLevelPackages: [
                {
                  id: 'a',
                  resolvedVersion: '1.0.0',
                  advisories: [
                    {
                      advisoryUrl: 'https://github.com/advisories/GHSA-1111-2222-3333',
                      severity: 'critical',
                    },
                    {
                      advisoryUrl: 'https://github.com/advisories/GHSA-4444-5555-6666',
                      severity: 'high',
                    },
                  ],
                },
              ],
            },
            {
              topLevelPackages: [
                {
                  id: 'b',
                  resolvedVersion: '2.0.0',
                  advisories: [
                    {
                      advisoryUrl: 'https://github.com/advisories/GHSA-7777-8888-9999',
                      severity: 'moderate',
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          frameworks: [
            {
              topLevelPackages: [
                {
                  id: 'c',
                  resolvedVersion: '3.0.0',
                  advisories: [{ severity: 'low' }],
                },
              ],
            },
          ],
        },
      ],
    });
    const parsed = parseDotnetVulnerableOutput(raw)!;
    expect(parsed.counts).toEqual({ critical: 1, high: 1, medium: 1, low: 1 });
    expect(parsed.findings).toHaveLength(4);
  });

  it('handles empty advisories array as zero findings', () => {
    const raw = JSON.stringify({
      projects: [
        {
          frameworks: [
            {
              topLevelPackages: [{ id: 'safe', resolvedVersion: '1.0.0', advisories: [] }],
            },
          ],
        },
      ],
    });
    const parsed = parseDotnetVulnerableOutput(raw)!;
    expect(parsed.findings).toEqual([]);
    expect(parsed.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });

  it('sets topLevelDep to the package itself — every emitted top-level finding is direct', () => {
    const raw = JSON.stringify({
      projects: [
        {
          frameworks: [
            {
              topLevelPackages: [
                {
                  id: 'Newtonsoft.Json',
                  resolvedVersion: '12.0.3',
                  advisories: [
                    {
                      severity: 'high',
                      advisoryUrl: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const parsed = parseDotnetVulnerableOutput(raw)!;
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].topLevelDep).toEqual(['Newtonsoft.Json']);
  });

  it('emits findings for transitivePackages with topLevelDep unset', () => {
    const raw = JSON.stringify({
      projects: [
        {
          frameworks: [
            {
              topLevelPackages: [],
              transitivePackages: [
                {
                  id: 'System.Net.Http',
                  resolvedVersion: '4.3.0',
                  advisories: [
                    {
                      severity: 'critical',
                      advisoryUrl: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const parsed = parseDotnetVulnerableOutput(raw)!;
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].package).toBe('System.Net.Http');
    // Transitives leave topLevelDep unset — attachment happens
    // downstream via project.assets.json walk.
    expect(parsed.findings[0].topLevelDep).toBeUndefined();
    expect(parsed.counts.critical).toBe(1);
  });

  it('emits both top-level and transitive findings in one pass', () => {
    const raw = JSON.stringify({
      projects: [
        {
          frameworks: [
            {
              topLevelPackages: [
                {
                  id: 'TopPkg',
                  resolvedVersion: '1.0.0',
                  advisories: [
                    {
                      severity: 'high',
                      advisoryUrl: 'https://github.com/advisories/GHSA-top1-xxxx-yyyy',
                    },
                  ],
                },
              ],
              transitivePackages: [
                {
                  id: 'TransPkg',
                  resolvedVersion: '2.0.0',
                  advisories: [
                    {
                      severity: 'medium',
                      advisoryUrl: 'https://github.com/advisories/GHSA-tra1-xxxx-yyyy',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const parsed = parseDotnetVulnerableOutput(raw)!;
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings.find((f) => f.package === 'TopPkg')?.topLevelDep).toEqual(['TopPkg']);
    expect(parsed.findings.find((f) => f.package === 'TransPkg')?.topLevelDep).toBeUndefined();
  });
});

describe('parseProjectAssetsJson', () => {
  it('returns null on malformed JSON', () => {
    expect(parseProjectAssetsJson('not json')).toBeNull();
    expect(parseProjectAssetsJson('')).toBeNull();
  });

  it('returns null on JSON with neither targets nor project sections', () => {
    expect(parseProjectAssetsJson('{}')).toBeNull();
  });

  it('extracts top-levels from project.frameworks and edges from targets', () => {
    const raw = JSON.stringify({
      targets: {
        'net6.0': {
          'Newtonsoft.Json/13.0.1': {
            type: 'package',
            dependencies: {},
          },
          'Microsoft.Extensions.Http/6.0.0': {
            type: 'package',
            dependencies: {
              'Microsoft.Extensions.DependencyInjection': '6.0.0',
            },
          },
          'Microsoft.Extensions.DependencyInjection/6.0.0': {
            type: 'package',
          },
        },
      },
      project: {
        frameworks: {
          'net6.0': {
            dependencies: {
              'Newtonsoft.Json': { target: 'Package', version: '[13.0.1, )' },
              'Microsoft.Extensions.Http': { target: 'Package', version: '[6.0.0, )' },
            },
          },
        },
      },
    });
    const parsed = parseProjectAssetsJson(raw)!;
    expect(parsed.topLevels).toEqual(['Microsoft.Extensions.Http', 'Newtonsoft.Json']);
    expect([...(parsed.edges.get('Microsoft.Extensions.Http') ?? [])]).toEqual([
      'Microsoft.Extensions.DependencyInjection',
    ]);
  });

  it('merges edges + top-levels across multiple target frameworks', () => {
    const raw = JSON.stringify({
      targets: {
        'net6.0': {
          'A/1.0.0': { dependencies: { B: '1.0.0' } },
        },
        'net8.0': {
          'A/1.0.0': { dependencies: { C: '1.0.0' } },
        },
      },
      project: {
        frameworks: {
          'net6.0': { dependencies: { A: {} } },
          'net8.0': { dependencies: { A: {}, D: {} } },
        },
      },
    });
    const parsed = parseProjectAssetsJson(raw)!;
    expect(parsed.topLevels).toEqual(['A', 'D']);
    expect([...(parsed.edges.get('A') ?? [])].sort()).toEqual(['B', 'C']);
  });
});

describe('buildCsharpTopLevelDepIndex', () => {
  it('attributes direct + transitive deps', () => {
    const idx = buildCsharpTopLevelDepIndex({
      topLevels: ['TopPkg'],
      edges: new Map([
        ['TopPkg', new Set(['Middle'])],
        ['Middle', new Set(['Leaf'])],
      ]),
    });
    expect(idx.get('TopPkg')).toEqual(['TopPkg']);
    expect(idx.get('Middle')).toEqual(['TopPkg']);
    expect(idx.get('Leaf')).toEqual(['TopPkg']);
  });

  it('unions attributions when a transitive is reachable from multiple top-levels', () => {
    const idx = buildCsharpTopLevelDepIndex({
      topLevels: ['A', 'B'],
      edges: new Map([
        ['A', new Set(['Shared'])],
        ['B', new Set(['Shared'])],
      ]),
    });
    expect(idx.get('Shared')).toEqual(['A', 'B']);
  });

  it('handles cycles without infinite looping', () => {
    const idx = buildCsharpTopLevelDepIndex({
      topLevels: ['A'],
      edges: new Map([
        ['A', new Set(['B'])],
        ['B', new Set(['A'])],
      ]),
    });
    expect(idx.get('A')).toEqual(['A']);
    expect(idx.get('B')).toEqual(['A']);
  });
});
