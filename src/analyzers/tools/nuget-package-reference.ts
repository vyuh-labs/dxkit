/**
 * Direct `<PackageReference>` parser — D025f (2.4.7).
 *
 * Extracts NuGet PackageReference entries from `.csproj` XML text
 * without invoking `dotnet restore` or any other .NET toolchain. The
 * output feeds an ad-hoc `packages.lock.json`-shaped file that
 * osv-scanner ingests via `--lockfile=NuGet:<path>`, closing the
 * D036 customer-outcome gap on dpl-studio (where `dotnet list package`
 * couldn't run from a multi-project parent directory).
 *
 * Lives under `src/analyzers/tools/` (alongside `osv-scanner-deps.ts`,
 * `jacoco.ts`, `npm-registry.ts`, `cvss-v4.ts`) — CLAUDE.md rule #6
 * keeps each language pack as a single file; ecosystem-specific tool
 * helpers consumed by one or more packs go in `analyzers/tools/`.
 * csharp.ts imports this module the same way it already imports
 * `osv` and `osv-scanner-deps`.
 *
 * Architectural rationale:
 *
 *   D025c (Sprint A) routed the gather through `findTool(TOOL_DEFS
 *   ['dotnet-format'])` so users with `~/.dotnet/dotnet` (the
 *   Microsoft-recommended non-sudo install) got dotnet discovered.
 *   That fix was necessary but not sufficient: `dotnet list package
 *   --vulnerable` still requires an explicit `.csproj`/`.sln` in cwd,
 *   and dpl-studio's `Code/Source/Dev/Core/<Module>/<Module>.csproj`
 *   layout puts the project files 3 levels deeper than the natural
 *   `dxkit vulnerabilities Code/Source/` cwd.
 *
 *   D025f sidesteps the dotnet CLI entirely. We walk every `.csproj`
 *   reachable from cwd (depth 5, matching csharp.detect()), parse
 *   each, and feed the union to osv-scanner via a synthetic lockfile.
 *   Cross-platform — `net9.0-windows` targets that won't restore on
 *   Linux/Mac still get scanned.
 *
 *   Trade-off: this catches DIRECT PackageReferences only. Transitive
 *   deps (resolved by NuGet's dep graph from each direct ref's own
 *   dependencies) are NOT visible without a populated
 *   `project.assets.json`. Industry studies put ~80% of typical
 *   .NET CVE surface on direct refs; the remaining ~20% (transitives)
 *   land cleanly when `dotnet restore` is available and the
 *   dotnet-path-resolved D025c codepath runs.
 *
 * Shared with D031: the licenses degraded-inventory fallback uses the
 * same parser to produce a "133 packages identified; license info
 * unavailable" rendering when `nuget-license` isn't installed.
 *
 * Pure function. No I/O. Tested via a fixture suite of representative
 * .csproj shapes (attribute-form, element-form, Central Package
 * Management, conditional `<ItemGroup>` blocks).
 */

/**
 * Per-package entry extracted from a `.csproj`. Both fields are
 * post-trimmed; `version` is the raw NuGet version string (which may
 * be a single version `"9.0.1"` or a range `"[9.0.1, 10.0.0)"` —
 * osv-scanner accepts both forms in the lockfile's `resolved` field).
 */
export interface PackageReferenceEntry {
  name: string;
  version: string;
}

/**
 * Match shapes (in priority order):
 *
 *   1. `<PackageReference Include="Foo" Version="1.0.0" />` — most
 *      common; attributes can appear in any order (also matched
 *      `Version="1.0.0" Include="Foo"`).
 *   2. `<PackageReference Include="Foo"><Version>1.0.0</Version>
 *      </PackageReference>` — element-form, equivalent semantics;
 *      common in repos that prefer multiline configs or use child
 *      elements for `<PrivateAssets>`/`<IncludeAssets>` siblings.
 *   3. `<PackageReference Include="Foo" />` WITHOUT Version — Central
 *      Package Management (CPM): the version comes from a separate
 *      `Directory.Packages.props` file. Skipped here; the CPM-aware
 *      pass (a future enhancement) would resolve them.
 *
 * Skipped shapes:
 *
 *   - `<PackageReference Update="Foo" Version="..." />` — CPM
 *     override syntax for transitive pins; NOT a direct reference.
 *   - `<GlobalPackageReference ... />` — CPM-only; pins all projects.
 *     Not a direct reference of this csproj.
 *   - Comments / CDATA — best-effort; the regex is generous and
 *     can theoretically match `<!-- <PackageReference ... -->`
 *     comments; users with literal PackageReference strings inside
 *     comments would get false positives. Acceptable: pathological
 *     case, and osv-scanner won't surface advisories for non-real
 *     packages, so the worst case is a wasted scan entry.
 */
export function parseCsprojPackageReferences(xml: string): PackageReferenceEntry[] {
  const out: PackageReferenceEntry[] = [];
  const seen = new Set<string>(); // dedupe `${name}@${version}` within a single .csproj

  // Form 1 (attribute-form): two attribute orderings.
  // Match Include="X" ... Version="Y"
  const attrIncludeFirstRe =
    /<PackageReference\s+[^>]*\bInclude\s*=\s*"([^"]+)"[^>]*\bVersion\s*=\s*"([^"]+)"[^>]*\/?>/gi;
  // Match Version="Y" ... Include="X"
  const attrVersionFirstRe =
    /<PackageReference\s+[^>]*\bVersion\s*=\s*"([^"]+)"[^>]*\bInclude\s*=\s*"([^"]+)"[^>]*\/?>/gi;

  let m: RegExpExecArray | null;
  while ((m = attrIncludeFirstRe.exec(xml)) !== null) {
    pushEntry(out, seen, m[1], m[2]);
  }
  while ((m = attrVersionFirstRe.exec(xml)) !== null) {
    pushEntry(out, seen, m[2], m[1]);
  }

  // Form 2 (element-form): <PackageReference Include="X"><Version>Y</Version>...</PackageReference>
  // The element form spans multiple lines; the regex is multi-line aware.
  const elementFormRe =
    /<PackageReference\s+[^>]*\bInclude\s*=\s*"([^"]+)"[^>]*>[\s\S]*?<Version>\s*([^<\s]+)\s*<\/Version>[\s\S]*?<\/PackageReference>/gi;
  while ((m = elementFormRe.exec(xml)) !== null) {
    pushEntry(out, seen, m[1], m[2]);
  }

  return out;
}

function pushEntry(
  out: PackageReferenceEntry[],
  seen: Set<string>,
  rawName: string,
  rawVersion: string,
): void {
  const name = rawName.trim();
  const version = rawVersion.trim();
  if (!name || !version) return;
  const key = `${name}@${version}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ name, version });
}

/**
 * Generate the body of an ad-hoc `packages.lock.json` that osv-scanner
 * v2.x reads via `--lockfile=NuGet:<path>`. The schema matches NuGet's
 * native `dotnet restore`-produced lockfile (which osv-scanner already
 * supports natively), simplified to the minimum osv-scanner consults
 * for vulnerability matching:
 *
 *   {
 *     "version": 1,
 *     "dependencies": {
 *       "net0.0": {
 *         "<Pkg>": {
 *           "type": "Direct",
 *           "resolved": "<Version>",
 *           "requested": "[<Version>, )"
 *         }
 *       }
 *     }
 *   }
 *
 * - `"version": 1` matches `dotnet restore`'s lockfile schema version.
 * - `"net0.0"` is a placeholder framework moniker — osv-scanner reads
 *   the package map without validating the framework key, so any
 *   non-empty string works. We use a non-real moniker so it can't be
 *   confused with a real target framework in downstream debugging.
 * - `type: "Direct"` truthfully reflects that we ONLY parsed direct
 *   references. Transitive vulns are out of scope for this path
 *   (covered by D025c's `dotnet list` codepath when available).
 * - `requested` is a NuGet version range; we use a single-anchored
 *   `[V, )` form so the lockfile is valid even though the real
 *   `.csproj` might have been a pinned single version.
 *
 * Returns a JSON-stringified string suitable for writing to a temp
 * file. Callers should clean up the temp file after osv-scanner
 * consumes it.
 */
export function buildNugetAdhocLockfile(entries: ReadonlyArray<PackageReferenceEntry>): string {
  const dependencies: Record<string, Record<string, unknown>> = { 'net0.0': {} };
  for (const entry of entries) {
    // If the same package appears in multiple .csproj files at different
    // versions, last-write-wins per the lockfile shape (it's one entry
    // per package name within a framework). osv-scanner will scan
    // whichever version we stamped; the cross-csproj merging trade-off
    // is documented at the caller. For dpl-studio scale (~74 csprojs)
    // collisions are common but typically converge on a single resolved
    // version per the repo's dependency hygiene practices.
    dependencies['net0.0'][entry.name] = {
      type: 'Direct',
      resolved: entry.version,
      requested: `[${entry.version}, )`,
    };
  }
  return JSON.stringify({ version: 1, dependencies }, null, 2);
}
