import { describe, it, expect } from 'vitest';
import { parseDotnetVulnerableOutput } from '../src/languages/csharp';

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
});
