# csharp-nested benchmark fixture (Sprint A regression coverage)

Mirrors the shape of a deep enterprise .NET WinForms repo where the
`.csproj` files live under
`Code/Source/Dev/Core/<Module>/<Module>.csproj` — five directory
levels below the repo root.

## Defects this fixture guards (in commit order)

| Defect             | What this fixture catches                                                                                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D024**           | `csharp.detect(fixtureRoot)` returns true (depth-5 recursive walk). Pre-D024 this was depth 3 → "Stack: unknown" from the root.                                                                                                                                                                                              |
| **D030**           | `gatherHygieneMarkers(fixtureRoot)` returns non-zero TODO + FIXME + HACK counts from the `.cs` file. Pre-D030 the grep `--include` list omitted `*.cs` → 0/0/0.                                                                                                                                                              |
| **D035**           | `csharp.capabilities.depVulns.gather(fixtureRoot)` does NOT short-circuit at the preflight check. The `<PackageReference Include="Newtonsoft.Json" Version="9.0.1" />` is dormant for Sprint A (no live `dotnet` invocation in tests) but lets the gather reach the dotnet probe to confirm reachability.                    |
| **D025f** (future) | When sub-branch #3 (`feat/phase-10ux-2.4.7-nuget-direct`) lands the direct PackageReference parser, this fixture's vulnerable Newtonsoft.Json 9.0.1 ref surfaces the GHSA-5crp-9r3c-p9vr advisory via the osv-scanner adhoc lockfile path. The fixture is _ready_ for that assertion now; the CI assertion lands with D025f. |

## Composition

- `Code/Source/Dev/Core/Module/Module.csproj` — depth-5 .NET SDK
  project with `Newtonsoft.Json@9.0.1` (vulnerable). `NoWarn`
  suppresses NU1701/NU1903 so a future `dotnet restore` against this
  fixture doesn't fail on the deliberately-old pin.
- `Code/Source/Dev/Core/Module/Class1.cs` — minimal C# class with
  one `// TODO`, one `// FIXME`, one `// HACK` marker. The triple
  lets tests assert all three hygiene tiers report non-zero in one
  pass.

## Used by

- `test/languages-csharp.test.ts` — D024 detect-depth assertion.
- `test/sprint-a-fixture.test.ts` — D030 hygiene + D035 preflight
  reachability assertions (new in Sprint A).
