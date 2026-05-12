/**
 * D025f (2.4.7) — direct `<PackageReference>` parser tests.
 *
 * Pure-function coverage of the parser + adhoc-lockfile builder; no
 * real `osv-scanner` or `.NET` toolchain involvement. The integration
 * path (parser → adhoc lockfile → osv-scanner → DepVulnResult) is
 * covered separately by the dpl-studio re-validation at sub-branch
 * close + the existing cross-ecosystem matrix's csharp-vulnerable
 * fixture (which now exercises this codepath when `dotnet` is absent).
 */

import { describe, it, expect } from 'vitest';
import {
  parseCsprojPackageReferences,
  buildNugetAdhocLockfile,
} from '../src/analyzers/tools/nuget-package-reference';

describe('parseCsprojPackageReferences', () => {
  it('extracts a single attribute-form reference (Include first, then Version)', () => {
    const xml = `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="9.0.1" />
  </ItemGroup>
</Project>`;
    expect(parseCsprojPackageReferences(xml)).toEqual([
      { name: 'Newtonsoft.Json', version: '9.0.1' },
    ]);
  });

  it('extracts attribute-form with Version listed before Include', () => {
    // Real-world csprojs occasionally order attributes the other way.
    const xml = `<PackageReference Version="13.0.3" Include="System.Text.Json" />`;
    expect(parseCsprojPackageReferences(xml)).toEqual([
      { name: 'System.Text.Json', version: '13.0.3' },
    ]);
  });

  it('extracts element-form Version (multi-line)', () => {
    const xml = `<PackageReference Include="MySql.Data">
      <Version>6.10.9</Version>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>`;
    expect(parseCsprojPackageReferences(xml)).toEqual([{ name: 'MySql.Data', version: '6.10.9' }]);
  });

  it('extracts multiple references from a real-shaped .csproj', () => {
    const xml = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="9.0.1" />
    <PackageReference Include="Serilog" Version="3.1.1" />
    <PackageReference Include="MySql.Data" Version="6.10.9" />
  </ItemGroup>
</Project>`;
    const result = parseCsprojPackageReferences(xml);
    expect(result).toHaveLength(3);
    expect(result).toContainEqual({ name: 'Newtonsoft.Json', version: '9.0.1' });
    expect(result).toContainEqual({ name: 'Serilog', version: '3.1.1' });
    expect(result).toContainEqual({ name: 'MySql.Data', version: '6.10.9' });
  });

  it('dedupes when the same package@version appears twice in one csproj', () => {
    const xml = `
      <PackageReference Include="Foo" Version="1.0.0" />
      <PackageReference Include="Foo" Version="1.0.0" />
    `;
    expect(parseCsprojPackageReferences(xml)).toEqual([{ name: 'Foo', version: '1.0.0' }]);
  });

  it('keeps both entries when the same package appears at different versions', () => {
    // Pathological but legal — e.g., conditional ItemGroup blocks for
    // different target frameworks. Parser emits both; the lockfile
    // builder's last-write-wins is the trade-off at the next layer.
    const xml = `
      <PackageReference Include="Foo" Version="1.0.0" />
      <PackageReference Include="Foo" Version="2.0.0" />
    `;
    expect(parseCsprojPackageReferences(xml)).toEqual([
      { name: 'Foo', version: '1.0.0' },
      { name: 'Foo', version: '2.0.0' },
    ]);
  });

  it('skips PackageReference WITHOUT Version (Central Package Management)', () => {
    // CPM: version comes from Directory.Packages.props; the .csproj
    // just lists Include. Out of scope for the direct parser.
    const xml = `
      <PackageReference Include="HasVersion" Version="1.0.0" />
      <PackageReference Include="NoVersion" />
    `;
    expect(parseCsprojPackageReferences(xml)).toEqual([{ name: 'HasVersion', version: '1.0.0' }]);
  });

  it('skips PackageReference Update="..." entries (CPM transitive pin)', () => {
    // CPM's `Update` attribute pins transitive versions; not a direct
    // reference of this csproj. Skip to avoid false attribution.
    const xml = `
      <PackageReference Include="DirectDep" Version="1.0.0" />
      <PackageReference Update="TransitivePin" Version="2.0.0" />
    `;
    const result = parseCsprojPackageReferences(xml);
    expect(result).toEqual([{ name: 'DirectDep', version: '1.0.0' }]);
  });

  it('returns empty array for a csproj with no PackageReferences', () => {
    const xml = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
</Project>`;
    expect(parseCsprojPackageReferences(xml)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(parseCsprojPackageReferences('')).toEqual([]);
  });

  it('handles whitespace-padded values inside attributes', () => {
    const xml = `<PackageReference Include="  Newtonsoft.Json  " Version="  9.0.1  " />`;
    expect(parseCsprojPackageReferences(xml)).toEqual([
      { name: 'Newtonsoft.Json', version: '9.0.1' },
    ]);
  });

  it('skips entries where Include or Version is whitespace-only after trim', () => {
    const xml = `
      <PackageReference Include="  " Version="1.0.0" />
      <PackageReference Include="Foo" Version="  " />
      <PackageReference Include="RealOne" Version="2.0.0" />
    `;
    expect(parseCsprojPackageReferences(xml)).toEqual([{ name: 'RealOne', version: '2.0.0' }]);
  });
});

describe('buildNugetAdhocLockfile', () => {
  it('produces a valid JSON document with the expected schema', () => {
    const adhoc = buildNugetAdhocLockfile([
      { name: 'Newtonsoft.Json', version: '9.0.1' },
      { name: 'Serilog', version: '3.1.1' },
    ]);
    const parsed = JSON.parse(adhoc);
    expect(parsed.version).toBe(1);
    expect(parsed.dependencies).toBeDefined();
    expect(parsed.dependencies['net0.0']).toBeDefined();
    expect(parsed.dependencies['net0.0']['Newtonsoft.Json']).toEqual({
      type: 'Direct',
      resolved: '9.0.1',
      requested: '[9.0.1, )',
    });
    expect(parsed.dependencies['net0.0']['Serilog']).toEqual({
      type: 'Direct',
      resolved: '3.1.1',
      requested: '[3.1.1, )',
    });
  });

  it('handles an empty entry list gracefully', () => {
    const adhoc = buildNugetAdhocLockfile([]);
    const parsed = JSON.parse(adhoc);
    expect(parsed.version).toBe(1);
    expect(parsed.dependencies['net0.0']).toEqual({});
  });

  it('last-write-wins when the same package appears twice (cross-csproj merge)', () => {
    // Documented behavior at the parser layer: cross-csproj merging
    // collapses to one entry per package name. Lockfile maintains the
    // last-stamped version. dpl-studio-shape repos with ~74 csprojs
    // hitting the same dep at the same version converge cleanly;
    // version-divergent monorepos accept the trade-off.
    const adhoc = buildNugetAdhocLockfile([
      { name: 'Foo', version: '1.0.0' },
      { name: 'Foo', version: '2.0.0' },
    ]);
    const parsed = JSON.parse(adhoc);
    expect(parsed.dependencies['net0.0']['Foo'].resolved).toBe('2.0.0');
  });
});
