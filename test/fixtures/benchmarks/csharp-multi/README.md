# C# benchmark fixture (multi-project) — D003 validator

Multi-project .NET solution used by `test/integration/cross-ecosystem.test.ts`
to validate **Phase 10h.6.7's fix for D003** — C# multi-project solution
attribution.

## D003 background

Before 2.4.0, the C# pack's `findProjectAssetsJson` returned the **first**
`obj/project.assets.json` found in a depth-4 walk. For a solution with
N projects, only one project's dep graph was visible — so transitive
vulnerabilities reachable only through sibling projects were missed
entirely. The fix (commit `1327364`) walks every `obj/project.assets.json`
under cwd and merges the dep graphs.

## Fixture shape

```
csharp-multi/
├── Solution.sln              # references both projects
├── ProjectA/
│   ├── ProjectA.csproj       # references Microsoft.Extensions.Logging.Abstractions 8.0.0 (clean)
│   └── Class1.cs
└── ProjectB/
    ├── ProjectB.csproj       # references Newtonsoft.Json 9.0.1 (vulnerable)
    └── Class1.cs
```

When `dotnet restore Solution.sln` runs, two `obj/project.assets.json`
files are produced — one per project. Pre-fix dxkit found only one
(unpredictable which one) and either reported the Newtonsoft.Json
advisory or didn't, depending on file-walk order. Post-fix dxkit
finds both, merges them, and **always** surfaces the Newtonsoft.Json
advisory with `topLevelDep == ['Newtonsoft.Json']`.

## Expected dxkit output

`vyuh-dxkit vulnerabilities <fixture-root> --json` should report:

- At least one finding for `Newtonsoft.Json@9.0.1` with id matching
  `GHSA-5crp-9r3c-p9vr` (extracted from `advisoryurl`)
- `topLevelDep == ['Newtonsoft.Json']` (it's directly declared in
  ProjectB.csproj)
- `tool == 'dotnet-vulnerable'`

## Regenerating

```bash
cd test/fixtures/benchmarks/csharp-multi
dotnet restore Solution.sln   # creates obj/ dirs in both projects
```

`obj/` is gitignored (see `.gitignore` rule for
`test/fixtures/benchmarks/**/obj/`); the integration test runs `dotnet
restore` in `beforeAll`.
