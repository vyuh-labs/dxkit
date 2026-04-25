# C# benchmark fixture (single project) — `Newtonsoft.Json 9.0.1`

Pinned vulnerable dep used by `test/integration/cross-ecosystem.test.ts`
to validate the C# pack's `dotnet list package --vulnerable` invocation,
severity tiering, and `topLevelDep` attribution.

## Expected scanner output

`dotnet list package --vulnerable --include-transitive --format json`
should report **GHSA-5crp-9r3c-p9vr** (XML/JSON external entity
processing in Newtonsoft.Json < 13.0.1) on `Newtonsoft.Json@9.0.1`,
with `topLevelDep == ['Newtonsoft.Json']` (direct reference).

## obj/ is gitignored

`obj/project.assets.json` (which dxkit's C# pack reads to walk the
dep graph for `topLevelDep` attribution) is **regenerated** by
`dotnet restore` in the integration test's `beforeAll`. It is not
committed because:

- It contains absolute paths to the developer's machine
  (`/home/<user>/.nuget/packages`, project paths) that wouldn't be
  meaningful for other contributors or CI.
- `obj/` follows .NET convention and should not be source-controlled.
- The integration test gates on `commandExists('dotnet')`; if `dotnet`
  isn't available locally, the C# tests skip with a console message
  and run only in CI (where the workflow installs the .NET SDK).

## Regenerating

```bash
cd test/fixtures/benchmarks/csharp
dotnet restore   # writes obj/project.assets.json
```

The committed artifacts are just `Benchmark.csproj` (the manifest)
and `Class1.cs` (a placeholder so dotnet treats this as a real
project).
