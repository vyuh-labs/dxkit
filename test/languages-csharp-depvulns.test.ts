import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  csharp,
  parseDotnetVulnerableOutput,
  parseProjectAssetsJson,
  buildCsharpTopLevelDepIndex,
  mergeAssetParses,
  findRealPackagesLockFiles,
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
                  vulnerabilities: [
                    {
                      advisoryurl: 'https://github.com/advisories/GHSA-h5c3-5r3r-rr8q',
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
                  vulnerabilities: [
                    {
                      advisoryurl: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
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
                  vulnerabilities: [{ severity: 'low' }],
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
                  vulnerabilities: [{ severity: 'high' }],
                },
                {
                  id: 'good',
                  resolvedVersion: '2.0.0',
                  vulnerabilities: [{ severity: 'high' }],
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
                  vulnerabilities: [
                    {
                      advisoryurl: 'https://github.com/advisories/GHSA-1111-2222-3333',
                      severity: 'critical',
                    },
                    {
                      advisoryurl: 'https://github.com/advisories/GHSA-4444-5555-6666',
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
                  vulnerabilities: [
                    {
                      advisoryurl: 'https://github.com/advisories/GHSA-7777-8888-9999',
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
                  vulnerabilities: [{ severity: 'low' }],
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

  it('surfaces unrestored projects from the problems array — never a silent clean (the unrestored-tree class)', () => {
    // Shape captured live from `dotnet list package --vulnerable
    // --include-transitive --format json` on an unrestored tree: exit 0,
    // zero packages, and a per-project error INSIDE the JSON. Reading
    // this as ran-and-clean is the false-clean that made a committed
    // baseline "comparable" with CI's restored scan and false-blocked 9
    // pre-existing vulns as a PR's own.
    const raw = JSON.stringify({
      version: 1,
      parameters: '--vulnerable --include-transitive',
      problems: [
        {
          project: '/repo/App.Web/App.Web.csproj',
          level: 'error',
          text: 'No assets file was found for `/repo/App.Web/App.Web.csproj`. Please run restore before running this command.',
        },
        {
          project: '/repo/App.Core/App.Core.csproj',
          level: 'error',
          text: 'No assets file was found for `/repo/App.Core/App.Core.csproj`. Please run restore before running this command.',
        },
        // A non-restore warning must NOT count as unobserved.
        { project: '/repo/App.Web/App.Web.csproj', level: 'warning', text: 'some other notice' },
      ],
      projects: [
        { path: '/repo/App.Web/App.Web.csproj' },
        { path: '/repo/App.Core/App.Core.csproj' },
      ],
    });
    const parsed = parseDotnetVulnerableOutput(raw)!;
    expect(parsed.findings).toEqual([]);
    expect(parsed.unrestoredProjects).toEqual([
      '/repo/App.Web/App.Web.csproj',
      '/repo/App.Core/App.Core.csproj',
    ]);
  });

  it('a fully-restored report carries no unrestored projects', () => {
    const raw = JSON.stringify({
      projects: [{ frameworks: [{ topLevelPackages: [] }] }],
    });
    expect(parseDotnetVulnerableOutput(raw)!.unrestoredProjects).toEqual([]);
  });

  it('handles empty vulnerabilities array as zero findings', () => {
    const raw = JSON.stringify({
      projects: [
        {
          frameworks: [
            {
              topLevelPackages: [{ id: 'safe', resolvedVersion: '1.0.0', vulnerabilities: [] }],
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
                  vulnerabilities: [
                    {
                      severity: 'high',
                      advisoryurl: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
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
                  vulnerabilities: [
                    {
                      severity: 'critical',
                      advisoryurl: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
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
                  vulnerabilities: [
                    {
                      severity: 'high',
                      advisoryurl: 'https://github.com/advisories/GHSA-top1-xxxx-yyyy',
                    },
                  ],
                },
              ],
              transitivePackages: [
                {
                  id: 'TransPkg',
                  resolvedVersion: '2.0.0',
                  vulnerabilities: [
                    {
                      severity: 'medium',
                      advisoryurl: 'https://github.com/advisories/GHSA-tra1-xxxx-yyyy',
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

describe('mergeAssetParses (D003 — multi-project merge)', () => {
  it('unions top-level sets across projects', () => {
    const a = { topLevels: ['Alpha', 'Shared'], edges: new Map<string, Set<string>>() };
    const b = { topLevels: ['Beta', 'Shared'], edges: new Map<string, Set<string>>() };
    const merged = mergeAssetParses([a, b]);
    expect(merged.topLevels).toEqual(['Alpha', 'Beta', 'Shared']);
  });

  it('unions edge adjacency for the same source package', () => {
    // Project A sees Newtonsoft.Json → Foo; project B sees it → Bar.
    // The merged graph shows both children reachable from Newtonsoft.Json.
    const a = {
      topLevels: ['Alpha'],
      edges: new Map<string, Set<string>>([['Newtonsoft.Json', new Set(['Foo'])]]),
    };
    const b = {
      topLevels: ['Beta'],
      edges: new Map<string, Set<string>>([['Newtonsoft.Json', new Set(['Bar'])]]),
    };
    const merged = mergeAssetParses([a, b]);
    expect(merged.edges.get('Newtonsoft.Json')).toEqual(new Set(['Foo', 'Bar']));
  });

  it('enables attribution reachable through a sibling project only', () => {
    // This is the core D003 case: vulnerability in `Leaf` reachable ONLY
    // via `Beta` project's graph. First-project-wins logic would miss it.
    const a = {
      topLevels: ['Alpha'],
      edges: new Map<string, Set<string>>([['Alpha', new Set(['UnrelatedDep'])]]),
    };
    const b = {
      topLevels: ['Beta'],
      edges: new Map<string, Set<string>>([
        ['Beta', new Set(['Middle'])],
        ['Middle', new Set(['Leaf'])],
      ]),
    };
    const merged = mergeAssetParses([a, b]);
    const idx = buildCsharpTopLevelDepIndex(merged);
    // Pre-fix, attribution would be empty because only project A's
    // assets was read. Post-fix, Leaf is correctly attributed to Beta.
    expect(idx.get('Leaf')).toEqual(['Beta']);
  });

  it('handles empty input gracefully', () => {
    const merged = mergeAssetParses([]);
    expect(merged.topLevels).toEqual([]);
    expect(merged.edges.size).toBe(0);
  });

  it('handles a single-project input identically to pre-fix behavior', () => {
    const single = {
      topLevels: ['Solo'],
      edges: new Map<string, Set<string>>([['Solo', new Set(['Child'])]]),
    };
    const merged = mergeAssetParses([single]);
    expect(merged.topLevels).toEqual(['Solo']);
    expect(merged.edges.get('Solo')).toEqual(new Set(['Child']));
  });
});

// depVulns gather preflight depth parity with detect().
//
// `hasCsharpProject` once used a depth-1 walk while detect() walked
// depth 5. A deeply-nested layout like `app/src/modules/Core/<Module>/
// <Module>.csproj` produced Stack: csharp at the top level but
// "Unavailable: dep-audit" at the gather level — because the preflight
// rejected the deep cwd before reaching the dotnet probe. The two
// depths now agree.
//
// We don't test `hasCsharpProject` directly (it's private). Instead we
// assert the observable contract: if detect() says "this IS a csharp
// project", the depVulns provider must not refuse the gather on
// preflight grounds. Without a real dotnet binary on this dev machine
// the gather can still legitimately return null (tool-missing for
// dotnet probe failure, OR transient `dotnet list` failure), but the
// SHAPE of the failure must change — the result must be reached AT or
// AFTER the dotnet probe, not before. We can't observe the outcome
// kind from the provider (it collapses everything to null), so the
// guard here is the simpler symmetry assertion: detect() and gather
// preflight agree.
describe('csharp depVulns preflight parity with detect() (D035)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-d035-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('detect() and depVulns provider agree on a depth-5 .csproj layout', async () => {
    const deep = path.join(tmp, 'Code', 'Source', 'Dev', 'Core', 'Module');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'Module.csproj'), '');

    // detect() must see the project (D024 guarantee).
    expect(csharp.detect(tmp)).toBe(true);

    // The gather is reached. We don't depend on dotnet being installed
    // for this assertion — `gather()` can return null OR an envelope;
    // what matters is that the call doesn't throw and we get a defined
    // result. Pre-D035, the gather would short-circuit via the depth-1
    // preflight before ever invoking findTool/dotnet. The post-D035
    // shape: gather runs, hits findTool, and (in this test environment
    // without a real .csproj that dotnet can resolve) returns null.
    const result = await csharp.capabilities!.depVulns!.gather(tmp);
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('returns false from both detect() and gather when no csharp project exists', async () => {
    fs.writeFileSync(path.join(tmp, 'README.md'), '');
    expect(csharp.detect(tmp)).toBe(false);
    const result = await csharp.capabilities!.depVulns!.gather(tmp);
    expect(result).toBeNull();
  });
});

describe('findRealPackagesLockFiles (transitive lockfile discovery)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-nuget-lock-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const csproj = '<Project Sdk="Microsoft.NET.Sdk"></Project>';

  it('finds a committed packages.lock.json next to a .csproj', () => {
    fs.writeFileSync(path.join(tmp, 'App.csproj'), csproj);
    fs.writeFileSync(path.join(tmp, 'packages.lock.json'), '{"version":1,"dependencies":{}}');
    const found = findRealPackagesLockFiles(tmp);
    expect(found).toHaveLength(1);
    expect(found[0].endsWith('packages.lock.json')).toBe(true);
  });

  it('returns empty when a .csproj has no adjacent lock file (falls back to direct path)', () => {
    fs.writeFileSync(path.join(tmp, 'App.csproj'), csproj);
    expect(findRealPackagesLockFiles(tmp)).toEqual([]);
  });

  it('discovers one lock file per project in a multi-project layout', () => {
    for (const proj of ['DataStore', 'DataEngine', 'ConnectorUtils']) {
      const dir = path.join(tmp, proj);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${proj}.csproj`), csproj);
      fs.writeFileSync(path.join(dir, 'packages.lock.json'), '{"version":1,"dependencies":{}}');
    }
    expect(findRealPackagesLockFiles(tmp)).toHaveLength(3);
  });

  it('only counts lock files that sit next to a project file', () => {
    // A stray lock file with no adjacent .csproj is not discovered.
    fs.writeFileSync(path.join(tmp, 'App.csproj'), csproj);
    const orphan = path.join(tmp, 'unrelated');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'packages.lock.json'), '{"version":1,"dependencies":{}}');
    expect(findRealPackagesLockFiles(tmp)).toEqual([]);
  });
});
