# Contributing to DXKit

Thanks for your interest in improving `@vyuhlabs/dxkit`. DXKit is a Stop-gate
for autonomous coding loops: it baselines a repo's current findings and blocks
only the net-new ones a change introduces. The same deterministic core runs
health, security, test-gap, code-quality, and dev-activity analyses against any
codebase, and generates `.claude/` agents, commands, skills, and rules tuned to
whatever language and framework you're working in.

## Repo layout

```
dxkit/
├── src/
│   ├── cli.ts                      # CLI entry, dispatches all subcommands
│   ├── detect.ts                   # Stack detection (languages, frameworks, tools)
│   ├── types.ts                    # DetectedStack, ToolRequirement, WriteResult
│   ├── generator.ts, files.ts, ... # Scaffolding machinery
│   ├── analyzers/                  # Analyzer core — the bulk of recent work
│   │   ├── health.ts               # Health orchestrator
│   │   ├── scoring.ts              # Dimension formulas
│   │   ├── security/, tests/, quality/, developer/
│   │   ├── docs/, maintainability/, dx/     # Shallow-only dimensions
│   │   └── tools/                  # Tool runners, registry, exclusions,
│   │                               # coverage, suppressions, parallel
│   └── lib.ts                      # Programmatic library export
├── src-templates/                  # SOURCE OF TRUTH for shipped .claude/ content
│   ├── .claude/                    # agents, commands, skills, rules
│   └── ...                         # configs, Makefile, CLAUDE.md.template, etc.
├── scripts/
│   ├── copy-templates.js           # Build step: src-templates/ → templates/
│   ├── check-architecture.sh       # Pre-commit + CI: enforce CLAUDE.md rules
│   ├── check-slop.sh               # Pre-commit (cached) + CI (vs base branch)
│   └── check-coverage.sh           # Pre-push + CI: coverage threshold
├── templates/                      # Build output (gitignored, shipped in tarball)
└── test/                           # Vitest tests + fixtures
    ├── *.test.ts                   # Unit tests
    └── integration/analyzers.test.ts  # Integration: analyzers on a temp repo
```

`templates/` is generated — never edit it directly. Edit `src-templates/`
and run `npm run build`.

## Local development

```bash
nvm use                # picks up .nvmrc (Node 22)
npm ci                 # bit-exact install from package-lock.json (recommended)
npm run build          # copies src-templates/ → templates/ and runs tsc
npm test               # vitest in watch mode
npm run test:run       # build + vitest run (one-shot, includes integration)
npm run test:coverage  # build + vitest run --coverage (~34s, what pre-push runs)
npm run test:integration   # only test/integration/** (~33s alone)
npm run lint           # eslint
npm run format         # prettier --write .
```

`npm ci` is the recommended install command — it reproduces `package-lock.json`
exactly and matches what CI runs (`.github/workflows/ci.yml:20`). Use
`npm install <pkg>` only when intentionally adding or changing a dependency.
Avoid `--legacy-peer-deps` — the lockfile resolves cleanly without it; the
flag can silently drift versions in `package.json` during install.

The first `npm install` registers husky hooks automatically:

- **pre-commit:**
  1. `scripts/check-architecture.sh` — enforces CLAUDE.md's 5 architecture rules
  2. `scripts/check-slop.sh` — blocks new `console.log`, `: any`, `debugger;`,
     committed `.pyc`/`.swp`, etc. Add `// slop-ok` or `# slop-ok` inline to
     suppress individual lines.
  3. `lint-staged` — `eslint --fix` and `prettier --write` on staged files
  4. `tsc --noEmit` — typecheck the whole project
- **pre-push:**
  1. `npm run build` — ensure `dist/` is current
  2. `vitest run --coverage` — full suite + coverage report
  3. `scripts/check-coverage.sh` — fails if line coverage below threshold
     (default `DXKIT_COVERAGE_THRESHOLD=50`; set the env var to override
     locally)

CI (`.github/workflows/ci.yml`) on every PR runs the same checks the local
hooks run, plus:

- Lint with `--max-warnings 0`
- Slop check in "vs base branch" mode (`DXKIT_SLOP_BASE=origin/<base_ref>`),
  so `--no-verify` can't ship code that introduces slop
- `npm pack --dry-run`

Anything the local hooks let through, CI catches.

To try the analyzers against the repo itself:

```bash
vyuh-dxkit tools install --yes         # first-time: install cloc, gitleaks, etc.
node dist/index.js health --detailed
node dist/index.js test-gaps
node dist/index.js quality
```

To try `init` against a sample repo:

```bash
mkdir /tmp/dxkit-smoke && cd /tmp/dxkit-smoke && git init -q
node ~/projects/dxkit/dist/index.js init --detect
ls .claude/
```

## Adding a new agent

1. Create a markdown file in `src-templates/.claude/agents/<name>.md` (or in
   `agents-available/` if it should be opt-in).
2. Use the existing agents as a structural reference — frontmatter with
   `name`, `description`, `tools`, plus the system prompt body.
3. Run `npm run build` and verify the new file lands in `templates/.claude/agents/`.
4. Add an entry to `CHANGELOG.md` under `[Unreleased]`.

## Adding a new command

1. Create the file in `src-templates/.claude/commands/<name>.md`. Use the
   `.md.template` extension if the command body needs variable substitution
   at `init` time (see `template-engine.ts` for available variables).
2. Build and confirm it appears in `templates/.claude/commands/`.

## Adding a new rule (path-scoped)

1. Add a file under `src-templates/.claude/rules/<lang-or-framework>/<name>.md`.
2. Rules are matched by `detect.ts` based on what the target repo contains —
   if you're adding rules for a brand-new framework, add detection logic there
   too.

## Adding analyzer functionality

### Adding a new tool to the registry

1. Define the tool in `src/analyzers/tools/tool-registry.ts` under `TOOL_DEFS`:
   binaries to look for, install commands per platform (macos/linux/windows),
   `for: 'node' | 'python' | ...`, `layer: 'universal' | 'language' | 'optional'`.
2. If the tool is a Node package without a CLI binary (e.g. a vitest plugin),
   set `nodePackage: '@scope/pkg'` instead of listing `binaries`.
3. Add it to `buildRequiredTools()` in the same file so the detected stack
   picks it up.
4. Write a gather function that calls `findTool()` / `runRegisteredTool()` —
   never hardcode binary paths.

### Adding a new analyzer dimension

Today's shape: one directory under `src/analyzers/<name>/` with `types.ts`,
`gather.ts`, `scoring.ts` (or delegate to `../scoring.ts`), `actions.ts`,
`detailed.ts`, and `index.ts`. Wire the entry function into `cli.ts`.

### Adding a new language

Adding a language follows a **7-file recipe**. The scaffolder writes
most of it for you:

```bash
npm run new-lang kotlin "Kotlin (Android)"
```

The scaffolder creates **6 new files** (Recipe v2, Phase 10j.1):

```
src/languages/<id>.ts                  # pack stub — every LanguageSupport field with TODO markers
test/languages-<id>.test.ts            # parser-test stubs + fixture-loading helper + provenance docstring
test/fixtures/benchmarks/<id>/README.md # standard 5-file convention + TODO checklist
test/fixtures/raw/<id>/HARVEST.md      # commands to capture real tool-output bytes
src-templates/.claude/rules/<id>.md    # Claude rule file stub
```

And **updates 2 existing files**:

```
src/types.ts                           # extends LanguageId union with <id>
src/languages/index.ts                 # imports + registers <id> in LANGUAGES
```

Then you fill in the TODOs. The scaffolder prints a checklist of the
remaining work — including the critical Recipe-v2 step **#4: harvest
real tool output**.

**Parser test conventions — two classes, two rules** (Recipe v4
G_v4_1, refined from 10k.2.3 surfacing). The scaffolded
`test/languages-<id>.test.ts` is split into Section A and Section B
that codify these explicitly; the rules are:

1. **Source-text parsers** (`extract<X>ImportsRaw`, `map<X>Severity`,
   anything reading source code or severity-string mappings) →
   **synthetic inline strings**, no fixture file. Language syntax is
   stable; real fixtures add toil without catching bugs at this layer.

2. **Tool-output parsers** (`parse<X>LintOutput`,
   `parse<X>CoverageOutput`, `parse<X>DepVulnsOutput`, anything
   reading JSON/XML/text from an external tool) → **REAL fixture
   file** under `test/fixtures/raw/<id>/`. Capture commands live in
   that dir's `HARVEST.md`. The C# defect (Phase 10h.6.8 — parser
   passed synthetic-JSON unit tests for 5 months while returning 0
   findings on real `dotnet list package --vulnerable` output) is
   the cautionary tale that justifies this discipline.

The split matters because the failure modes differ: source-text
parsers fail when language grammar changes (rare, loud); tool-output
parsers fail when the upstream tool ships a schema tweak (frequent,
silent). Real fixtures defend against the latter.

#### What the pack declares (`LanguageSupport`)

All non-required fields can be omitted; the dispatcher tolerates it.
Required = `id`, `displayName`, `sourceExtensions`, `testFilePatterns`,
`detect`, `tools`, `semgrepRulesets`. Recommended (LP-recipe enforcement
will fail CI if missing):

- **Detection + source** — `detect(cwd) → boolean`, `sourceExtensions[]`,
  `testFilePatterns[]` (use `tests/<glob>` for path-anchored patterns,
  bare globs for basename match), `extraExcludes?[]`
- **Tool wiring** — `tools[]` (TOOL_DEFS keys this pack uses; the
  contract test verifies every `findTool(TOOL_DEFS.X)` reference in the
  pack's source appears here, AND every entry here is referenced
  somewhere — the artifact-generating allowlist covers exceptions like
  `coverage-py` and `cargo-llvm-cov`)
- **Capabilities** — `capabilities?: { depVulns, lint, coverage,
imports, testFramework, licenses }`. Each is a `CapabilityProvider`
  with an async `gather(cwd)` method; return `null` when nothing to
  report. The dispatcher fans out across every pack.
- **Correctness floor** (2.23) — `correctness?: CorrectnessProvider`,
  the loop-safety liveness gate ("does this change still compile, and
  do the tests it affects still pass?"). TWO pure command builders:
  `syntaxCheck(ctx)` (the cheap compile/parse check every language can
  give) and `affectedTests(ctx)` (the tests the change reaches — native
  impact-selection where the ecosystem supports it, else a coarser
  fallback with CI's `full` scope as the backstop). Each returns a
  `{ label, bin, args }` command or `null`. A pack NEVER shells out
  itself — the runner (`src/analyzers/correctness/run.ts`) executes the
  command and owns the fail-open (missing tool / timeout → skip) vs
  fail-closed (non-zero exit → block) policy. Optional today; the
  contract test requires BOTH builders if you declare it. See
  `typescript.ts` (`tsc --noEmit` + vitest/jest) and `python.ts`
  (`py_compile` + pytest) for worked examples, and CLAUDE.md Rule 15.
- **Lint gate** (3.0) — `lintGate?: LintGateProvider`, the pack's standard
  zero-config linter wired as an opt-in guardrail gate (a net-new lint error
  blocks; the repo's pre-existing lint debt is grandfathered). One pure builder
  `lintCommand(ctx)` returns `{ bin, args, parse, expectedExit? }` — where
  `parse` is a regex with named groups (`file`/`line`/`rule`/`message`) so the
  finding is LOCATED (per file+line) — or `null` when the linter isn't
  resolvable in the repo. A pack NEVER shells out itself; the check runner
  (`src/analyzers/custom-checks/run.ts`) executes it and folds output into
  `custom-check` findings, exactly like a user-declared check. 7 of 8 packs
  declare a real gate (see `typescript.ts` `TS_ESLINT_UNIX_PARSE`, `python.ts`
  `PY_RUFF_CONCISE_PARSE`, `csharp.ts` `CSHARP_MSBUILD_WARNING_PARSE`); Java
  ships a dormant provider (no single zero-config standalone linter). See
  CLAUDE.md Rule 17.
- **HTTP flow** (M6) — `httpFlow?: HttpFlowSupport` +
  `treeSitterGrammars?`, the UI→API flow extraction surface. The recipe
  is DECLARATION-ONLY — the one extractor
  (`src/analyzers/flow/extract.ts`) reads any grammar through the
  per-grammar shape table (`src/ast/grammar-shape.ts`) and is never
  edited for a language:
  1. Declare `treeSitterGrammars` (extension → logical grammar name —
     the wasm ships in `tree-sitter-wasms`). If the grammar has no
     shape row yet, add one row in `src/ast/grammar-shape.ts`; most
     grammars fit the shared callee-field factory (verify node/field
     names against a real parse first — an unverified row silently
     misreads trees).
  2. Fill the descriptor from the construct families in
     `HttpFlowSupport` (`src/languages/types.ts`): `clientCallees`
     (bare `fetch(url)`), `clientMethodCallees` (`recv.get('/x')`,
     with `bases` naming TRUSTED always-HTTP receivers whose dynamic
     URLs are disclosed rather than dropped), `routeDecorators`
     (`@get('/x')`), `routeMemberDecorators` (`@app.get('/x')`),
     `routePathDecorators` (`@app.route('/x', methods=[...])`),
     `routeRouterCallees` (`app.get('/x', handler)`), `routeCallees`
     (verb-less `path(route, view)` → method-agnostic `ANY` routes),
     `fileRoutes` (file-convention routing). Worked examples:
     `typescript.ts` (fetch/axios/Express/Next.js) and `python.ts`
     (requests/httpx/FastAPI/Flask/Django).
  3. Pin it: a pack test like `test/flow-extract-python.test.ts`, plus
     a fixture dir + flow row in `test/fixtures-analysis.test.ts`.

  `test/languages-contract.test.ts` loud-fails an httpFlow pack whose
  grammar is missing, unshaped, or whose descriptor is vacuous;
  `test/recipe-playbook.test.ts` proves extraction is descriptor-driven
  end-to-end with the synthetic pack.

- **Init metadata** (LP-recipe — needed by `vyuh-dxkit init` and
  `doctor`) — `permissions[]` (Bash entries for `.claude/settings.json`),
  `ruleFile?` (filename under `src-templates/.claude/rules/`),
  `cliBinaries[]` (commands `doctor` checks for), `defaultVersion?`,
  `versionKey?` (lookup key in `DetectedStack['versions']`; defaults
  to `id` — only override for legacy template-name compat)
- **Allowlist comment syntax** (2.6) — `commentSyntax: { lineComment,
blockCommentStart?, blockCommentEnd? }`. Drives inline allowlist
  annotation insertion (`<lineComment> dxkit-allow:<category>
reason="..."`). Hash-style (`#`) for python, ruby, shell;
  slash-style (`//` + `/* */`) for typescript, go, rust, csharp,
  kotlin, java. Without it, the inline-allowlist code path can't
  render correct comments for this language.
- **Lint severity** — `mapLintSeverity?(ruleId)` if your linter has
  rule IDs you can tier into critical/high/medium/low
- **Per-pack pattern registries** (CI-enforced; the contract test
  fails when missing):
  - `autogeneratedSourcePatterns?[]` (D028) — basename globs for
    auto-generated files (`*.designer.cs`, `*.pb.go`,
    `*Generated.java`). Excluded from source-file counts, lines-over-
    500 ranking, hot-files ranking.
  - `docCommentPatterns?[]` (D027) — POSIX-compatible regex strings
    for doc-comment markers (`///`, `/**`, `def __doc__`, etc.).
    Drives the Documentation dimension's `docCommentFiles` metric.
  - `tlsBypassPatterns?[]` (D034) — regex strings for TLS / cert-
    validation bypass idioms specific to this language's HTTP stacks
    (`ServerCertificateValidationCallback`, `InsecureSkipVerify`,
    `danger_accept_invalid_certs`, ...). Each match becomes a
    Security finding.
  - `clocLanguageNames?[]` (D073, 2.4.7) — the names cloc emits in
    its `--json` output for this pack (`['TypeScript', 'JavaScript']`
    for the typescript pack, `['C#']` for csharp, etc.).
    `gatherClocMetrics` filters its language summary + `totalLines`
    aggregation to the union of every active pack's declarations, so
    JSON/XML/CSV/Markdown stop deflating quality metrics.
  - `upgradeCommand?(name, version)` (G_v4_4, 2.4.7) — per-ecosystem
    package-upgrade template surfaced under "Remediation Commands"
    in the vuln scan. `dotnet add package`, `npm install`, `pip
install`, `cargo update`, `go get`, edit-pom for Maven,
    edit-Gemfile for Bundler. Required when the pack declares a
    `depVulns` capability.
  - `exportDetection?` (2.7) — declares this pack's reliability for
    detecting which symbols are exported / public. Drives the
    `exported` flag on per-node entries in `.dxkit/reports/graph.json`
    - the `vyuh-dxkit explore api-surface` query + the dashboard viz
      "exported only" filter. Three reliability tiers: `'full'` (TS
      `export`, Go capitalization, Rust `pub`, C# / Java / Kotlin
      `public`), `'partial'` (Python `__all__` + public-name
      heuristic), `'unreliable'` (Ruby metaprogramming defeats static
      analysis — api-surface excludes the pack with an explanatory
      note). Detection itself lives in
      `src/analyzers/tools/graphify-graph.ts` (Python script).

#### Recipe enforcement (runs in pre-commit + CI)

Three layers prevent recipe drift:

1. **Architecture greps** (`scripts/check-architecture.sh`) — fail when
   pack-coupling slips into non-pack code: hardcoded `IF_<LANG>`
   references, direct `config.languages.<id>` lookups outside the
   registry bridge, hardcoded `<lang>.md` rule-file strings.
2. **Pack contract tests** (`test/languages-contract.test.ts`) — fail
   when a pack omits required metadata (`permissions`, `cliBinaries`,
   `defaultVersion`) or when declared `tools[]` drift from actual
   invocations.
3. **Synthetic 6th-pack playbook** (`test/recipe-playbook.test.ts`) —
   injects a mock pack into the registry and asserts every
   pack-iterating consumer (generator, doctor, detect, project-yaml,
   constants, coverage dispatcher, generic, grep-secrets, tool-registry)
   picks up its contributions. Catches "the architecture stopped being
   pack-driven" regressions empirically.

#### What scaffolding can't do for you

The scaffolder gives you a stub. The substantive work is:

- Implement `detect(cwd)` against your ecosystem's manifest signals
- Implement at least one capability provider (start with `coverage` —
  usually the simplest; `depVulns` is the most valuable but most
  involved)
- Add `TOOL_DEFS` entries in `src/analyzers/tools/tool-registry.ts`
  for any external tool you call
- Populate `test/fixtures/benchmarks/<id>/` with a minimal real project
  containing the matrix-dimension content (vuln, secret, lint,
  duplication, untested file)
- Register the fixture in `test/integration/cross-ecosystem.test.ts`
  `BENCHMARK_LANGUAGES`
- Add the toolchain install to `.github/workflows/ci.yml`
- Document the toolchain requirement in this file's
  [Toolchain requirements](#toolchain-requirements) table

Plan ~1 day of work for a desktop-style pack (Python/Go-shaped),
~1.5 days for mobile (Gradle/Xcode bootstrapping is more involved).

### Adding a new dimension scoring spec

dxkit's six dimension scores (Security, Code Quality, Tests,
Documentation, Maintainability, Developer Experience) are produced
by declarative `DimensionScoringSpec<T>` artifacts under
`src/scoring/dimensions/<id>.ts`, consumed by the shared evaluator
in `src/scoring/evaluator.ts`. Adding a 7th dimension follows the
same recipe used by language packs (see [Rule 7 in
CLAUDE.md](CLAUDE.md#7-dimension-scoring-lives-in-declarative-specs-under-srcscoring)).

#### What the spec declares

```typescript
import type { DimensionScoringSpec } from '../spec';

export interface NewDimScoreInput {
  /* whatever the dimension reads from gathered data */
}

export const NEW_DIM_SCORING_SPEC: DimensionScoringSpec<NewDimScoreInput> = {
  dimension: 'new-dim',
  methodology: 'iso-iec-25010-quality-characteristic-name',
  baseline: 100, // subtractive (recommended) — additive (0) also supported
  penalties: [
    {
      id: 'unique-penalty-id',
      describe: (i) => `human-readable reason citing input data`,
      applies: (i) => /* predicate */,
      delta: (i) => /* negative delta for subtractive, positive for additive */,
    },
    // ... one rule per violation class
  ],
  caps: [
    {
      id: 'unique-cap-id',
      tier: 'fixable-finding', // see CAP_TIERS taxonomy
      describe: (i) => `condition reason`,
      applies: (i) => /* predicate */,
    },
  ],
};
```

#### Recipe (5 steps)

1. **Create the spec file** at `src/scoring/dimensions/<id>.ts`.
   Cite the methodology source in the file's JSDoc + the
   `methodology` field. Add the citation to
   `src/scoring/STANDARDS.md` (Layer 1 if it's an open standard;
   Layer 3 with rationale if dxkit-specific).

2. **Register the spec** in `src/scoring/index.ts:SCORING_SPECS`.
   Export the spec + input type from the barrel.

3. **Build the adapter** at `src/analyzers/<dim>/shallow.ts`:

   ```typescript
   export function toNewDimScoreInput(input: ScoreInput): NewDimScoreInput {
     // map ScoreInput → NewDimScoreInput
   }

   export function scoreNewDimFromScoreInput(input: ScoreInput): { score: number } {
     return evaluateSpec(NEW_DIM_SCORING_SPEC, toNewDimScoreInput(input));
   }

   export function scoreNewDimDimension(input: ScoreInput): DimensionScore {
     const result = evaluateSpec(NEW_DIM_SCORING_SPEC, toNewDimScoreInput(input));
     return {
       score: result.score,
       maxScore: 100,
       rating: ratingFromScore(result.score),
       rawScore: result.rawScore,
       rawPenalty: result.rawPenalty,
       methodology: result.methodology,
       deductions: result.deductions,
       capsApplied: result.capsApplied,
       topActions: result.topActions,
       metrics: {
         /* dimension-specific renderer values */
       },
       details: `human-readable summary string`,
     };
   }
   ```

4. **Wire the dimension into the health rollup**:
   - `src/analyzers/health.ts` calls `scoreNewDimDimension(input)`
   - `src/analyzers/health/actions.ts:buildHealthPlans` adds an
     entry with `scoreNewDimFromScoreInput` for action ranking
   - `src/scoring/overall.ts:DIMENSION_WEIGHTS` + `DIMENSION_LABEL`
     get an entry; weights across all dimensions must sum to 1.0

5. **Tests**:
   - Spec-level: a unit test in `test/<dim>-scoring.test.ts`
     covering the penalty curves and cap predicates against
     synthetic `NewDimScoreInput` shapes
   - Registry-level: `test/scoring-playbook.test.ts` automatically
     picks up new specs through the `SCORING_SPECS` iteration —
     no edit needed there

#### Spec enforcement (runs pre-commit + CI)

`scripts/check-architecture.sh` bans the regression patterns:

- New `src/analyzers/**/scoring.ts` files (dimension scoring code
  lives in `src/scoring/dimensions/`, not analyzer subdirs)
- Hardcoded rating-band thresholds (`>= 80` etc.) in scoring-related
  code outside `src/scoring/thresholds.ts`
- Hardcoded cap-ceiling values (`35`/`40`/`65`/`75`/`79`) used as
  `score = N` / `final = N` outside the scoring module

Annotate `// scoring-spec-ok` on the violating line for justified
exceptions (CVSS risk-tier bands, coverage thresholds that
deliberately differ from rating thresholds, etc.).

#### What "actionable" requires

Renderers (`src/scoring/format.ts`, `src/cli.ts` health-markdown
section) read the structured `ScoreResult` fields directly:

- `deductions[]` — items the customer can fix; rendered as the
  per-dimension "Top actions" block
- `capsApplied[]` — binding cap with its uplift; rendered as a
  callout above the action list
- `rawScore` / `rawPenalty` — "severe debt" disclosure when the
  score floors at 0

If your spec is subtractive (baseline 100, deductions for missing
or problematic signals), the `deductions[]` list reads as
actions-to-take naturally. Additive specs (baseline 0, bonuses for
present signals) are supported but rarely the right choice — the
inverse "things to add" interpretation requires the renderer to
walk the spec rules separately. dxkit's six dimensions all use
subtractive specs as of 2.4.7.

### Enriching dependency-vulnerability severity

Scanners that don't publish per-finding severity tiers (pip-audit,
govulncheck) can be enriched via OSV.dev. The utility lives in
`src/analyzers/tools/osv.ts`:

```ts
import { enrichSeverities, classifyOsvSeverity } from '../analyzers/tools/osv';

// For per-ID lookup:
const severities = await enrichSeverities(['CVE-2025-X', 'GHSA-Y']);

// When the scanner already embeds the advisory (like govulncheck):
const sev = classifyOsvSeverity(embeddedOsvRecord);
```

Both paths handle CVSS v3, CVSS v4, and the `database_specific.severity`
string. Unreachable IDs fall back to `'unknown'` — callers should bucket
unknowns into their scanner's legacy default (pip-audit → medium,
govulncheck → high).

## Testing changes

Tests live in `test/` and use [Vitest](https://vitest.dev/). Three kinds:

- **Unit tests** (`test/*.test.ts`): exercise pure functions and single
  modules against fixtures or temp directories. Fast (<3s for the whole
  unit suite). Examples: `detect.test.ts`, `scoring.test.ts`,
  `coverage.test.ts`, `import-graph.test.ts`, `suppressions.test.ts`.
  Add fixtures under `test/fixtures/` when teaching `detect.ts` about a new
  language or framework.
- **Analyzer integration test** (`test/integration/analyzers.test.ts`):
  creates a minimal temp repo once, runs all 5 analyzers against it in
  `beforeAll`, and shares the reports across assertions. This is what
  gives us coverage of the shell-out code paths (gitleaks, jscpd, eslint,
  npm audit). ~18s. Included in the default suite.
- **Cross-ecosystem integration test** (`test/integration/cross-ecosystem.test.ts`):
  runs `dxkit vulnerabilities` against committed benchmark fixtures
  under `test/fixtures/benchmarks/{python,go,rust,csharp,csharp-multi}/`
  — projects with deliberately pinned vulnerable deps. Validates non-TS
  language packs against real ecosystem-tool output (pip-audit,
  govulncheck, cargo-audit, dotnet list package --vulnerable). ~150s
  end-to-end (subprocess-heavy; CI parallelizes). Each ecosystem's
  tests `skipIf` the relevant binary is not on PATH, so contributors
  without the toolchain see those tests skip locally; CI installs them
  all. See **Cross-ecosystem benchmarks** below.
- **CLI integration test** (`test/cli-init.test.ts`): builds the CLI and
  runs it against a temp directory, asserting on the files `init` writes.
  Use this when changing the generator.

Run the suite:

```bash
npm test                   # watch mode
npm run test:run           # one-shot (build + full suite)
npm run test:coverage      # + coverage + threshold check (~34s)
npm run test:integration   # only test/integration/** (~33s alone)
```

Integration tests require a built CLI — `npm run test:run` and
`npm run test:coverage` build automatically. `npm test` (watch mode) does
not; build manually if you're editing the CLI binary.

### Coverage expectations

- Keep dxkit's own line coverage above `DXKIT_COVERAGE_THRESHOLD` (default 50%).
  The pre-push hook and CI both enforce this.
- New analyzer modules should have unit tests before shipping — see the
  patterns in `test/scoring-dimensions.test.ts` (pure scoring), `test/
gather-tests.test.ts` (filesystem fixtures), and `test/actions-detailed.
test.ts` (report transformers).
- The integration test exercises the end-to-end pipeline; don't mock the
  analyzer internals in it. If you need isolated coverage for a gather
  function, write a unit test that drives the specific parser instead.

## Cross-ecosystem benchmarks

`test/fixtures/benchmarks/` holds five committed reference projects
(`python`, `go`, `rust`, `csharp`, `csharp-multi`) with deliberately
pinned vulnerable dependencies. They exist to validate dxkit's non-TS
language packs against **real** ecosystem-tool output rather than
hand-crafted JSON.

The history that motivated them: through 2.4.0, the Python / Rust / C#
packs were unit-tested only against synthetic JSON the test author
hand-wrote. Phase 10h.6.8 surfaced four real defects — including a
C# parser that returned **zero findings on every real .NET project**
because the synthetic fixture had the wrong schema shape and the
parser had drifted to match. The benchmarks are the regression net.

### Toolchain requirements

**Routine dxkit development does not require any of these toolchains.**
The cross-ecosystem suite uses `it.skipIf(!commandExists(...))(...)`
gates — locally, contributors without `cargo` / `dotnet` / `go` /
`govulncheck` / `pip-audit` see those tests skip with a clear message.
CI (`.github/workflows/ci.yml`) installs them all; that's the
canonical validation point.

If you need to run the cross-ecosystem suite locally — e.g., because
you're modifying a non-TS language pack — install the relevant
toolchain:

| Toolchain             | Matrix rows                           | Required for                                                       | Install (Linux/macOS)                                                                                                               |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pip-audit`           | Python                                | depVulns                                                           | `pipx install pip-audit` (already in TOOL_DEFS)                                                                                     |
| `ruff`                | Python                                | lint (Phase 10i.0.2)                                               | `pipx install ruff`                                                                                                                 |
| `cargo` (rustup)      | Rust                                  | depVulns + lint (clippy is bundled with rustup `clippy` component) | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh -s -- -y --profile minimal && rustup component add clippy`         |
| `cargo-audit`         | Rust                                  | depVulns                                                           | `cargo install --locked cargo-audit`                                                                                                |
| `dotnet` (.NET 8 SDK) | C# (single) + C# (multi)              | depVulns + lint (`dotnet format` is bundled)                       | `wget https://dot.net/v1/dotnet-install.sh && bash dotnet-install.sh --channel 8.0 --install-dir $HOME/.dotnet`                     |
| `go` 1.21+            | Go                                    | depVulns + lint                                                    | `apt install golang` / `brew install go`                                                                                            |
| `govulncheck`         | Go                                    | depVulns                                                           | `go install golang.org/x/vuln/cmd/govulncheck@latest`                                                                               |
| `golangci-lint`       | Go                                    | lint (Phase 10i.0.2)                                               | `curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh \| sh -s -- -b $(go env GOPATH)/bin v1.64.8` |
| `osv-scanner`         | Kotlin + Java                         | depVulns (Maven via `pom.xml` / `gradle.lockfile`)                 | `go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest`                                                                |
| `java` 17+ (Temurin)  | Kotlin + Java                         | runtime (detekt + PMD are JVM-based)                               | `apt install openjdk-17-jdk` / `brew install --cask temurin` / portable Adoptium tarball under `~/.local/share/java`                |
| `detekt`              | Kotlin                                | lint (Phase 10j.1) — Kotlin static analysis (Checkstyle XML)       | `brew install detekt` / [GitHub release zip](https://github.com/detekt/detekt/releases) (see `vyuh-dxkit tools install`)            |
| `pmd`                 | Java                                  | lint (Phase 10k.1.3) — Java source-level analyzer (PMD 7.x JSON)   | `brew install pmd` / [GitHub release zip](https://github.com/pmd/pmd/releases) (see `vyuh-dxkit tools install pmd`)                 |
| `gitleaks`            | all (matrix — secrets, Phase 10i.0.1) | secrets                                                            | `pipx install gitleaks` / `brew install gitleaks` / [GitHub release](https://github.com/gitleaks/gitleaks/releases)                 |

### Regenerating a fixture

The fixtures are committed minus `obj/` (.NET build artifacts — see
`.gitignore` rule for `test/fixtures/benchmarks/**/obj/`). Most
fixtures need no regeneration; the cases that do:

```bash
# Rust — re-resolve dependency graph
cd test/fixtures/benchmarks/rust && rm Cargo.lock && cargo generate-lockfile

# Go — re-resolve module checksums (use `tidy`, not `download` — govulncheck needs transitive sums)
cd test/fixtures/benchmarks/go && rm go.sum && go mod tidy

# C# (single + multi) — restore is automatic in the integration test's beforeAll
# To regenerate locally for inspection:
cd test/fixtures/benchmarks/csharp && dotnet restore
cd test/fixtures/benchmarks/csharp-multi && dotnet restore Solution.sln
```

Each fixture has its own `README.md` documenting expected scanner
output and the specific defect it guards against.

### Running locally

```bash
# Full cross-ecosystem suite (will skip ecosystems whose toolchains are missing):
npm run test:run -- test/integration/cross-ecosystem.test.ts

# Single ecosystem:
npm run test:run -- test/integration/cross-ecosystem.test.ts -t Rust
```

Subprocess-heavy: ~150s wall-clock end-to-end. Each test invokes
`node dist/index.js vulnerabilities <fixture>` which in turn shells
out to the real ecosystem tool. CI parallelizes the matrix; locally
they run serially.

## Releasing

Releases are handled by the maintainers via GitHub Releases, which trigger
the publish workflow. Contributors do not need to bump versions in PRs.

## Code style

- **Prettier** is the source of truth for formatting. Run `npm run format`
  before you commit, or let the pre-commit hook handle it.
- **ESLint** runs with `--max-warnings 0` in CI. Fix anything `npm run lint`
  reports — don't suppress with eslint-disable comments unless there's a
  real reason and you note it inline.
- **TypeScript** strict mode is on. `npm run typecheck` must pass.
- **No new runtime dependencies** without discussion — DXKit aims to stay
  zero-dep so it installs fast via `npx`.

A `.git-blame-ignore-revs` file is in the repo root to mask large
formatting commits from `git blame`. Configure your local git once:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

GitHub's blame view honors this file automatically.
