# Architecture

A short tour of how `@vyuhlabs/dxkit` is organized. For the
authoritative rule set, read [`CLAUDE.md`](../CLAUDE.md) — this
document is an entry point, not the contract.

## What dxkit does

dxkit is two things in one CLI:

1. **Analyze** any repository deterministically — six health
   dimensions, vulnerabilities, test gaps, code quality, developer
   activity, BoM/licenses — without an LLM in the loop.
2. **Scaffold** `.claude/` agents, skills, commands, and hooks
   tuned to a project's detected stack.

The analyzer half is the heavier code surface and the focus of
this document.

## High-level data flow

```
┌─────────────┐    ┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│   detect    │ →  │   gather    │ →  │   score +    │ →  │   render     │
│  the stack  │    │  (capabili- │    │   aggregate  │    │  (markdown,  │
│             │    │   ties)     │    │              │    │  json, xlsx) │
└─────────────┘    └─────────────┘    └──────────────┘    └──────────────┘
                          │                                       ↑
                          ↓                                       │
                   ┌─────────────┐                          ┌──────────────┐
                   │   tools     │                          │ AnalysisResult│
                   │  registry   │                          │     cache    │
                   └─────────────┘                          └──────────────┘
```

Every CLI subcommand follows this shape: detect the active language
packs in the cwd, dispatch capability gathers to the relevant
providers, build a cached `AnalysisResult`, then read from the cache
to produce one or more reports. The cache is the single source of
truth — `vyuh-dxkit health`, `quality`, `test-gaps`, etc. all read
the same numbers.

## Three core architectural patterns

dxkit is built around three patterns that you'll see repeated
across the codebase. CLAUDE.md formalizes them as rules; this
section is the elevator pitch.

### 1. Language packs (`src/languages/`)

Every per-language concern — detection, tool list, source-file
extensions, semgrep rulesets, coverage parsing, import-graph
extraction, lint-severity mapping, init-scaffold metadata,
architectural shape — lives in a single
[`LanguageSupport`](../src/languages/types.ts) implementation
in `src/languages/<id>.ts`.

Files today:

- `python.ts`
- `typescript.ts` (covers JS/JSX/TSX)
- `go.ts`
- `rust.ts`
- `csharp.ts`
- `kotlin.ts`
- `java.ts`
- `ruby.ts`

Adding a new language is a one-command scaffold:
`npm run new-lang <id> "<displayName>"`. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for the full walkthrough.

Cross-cutting consumers (analyzers, generators, registries) iterate
the `LANGUAGES` registry in
[`src/languages/index.ts`](../src/languages/index.ts) and dispatch
through the contract. **No `if (stack.languages.python)` chains in
analyzer code** — that is a CLAUDE.md Rule 6 violation enforced by
the pre-commit arch gate.

### 2. Scoring specs (`src/scoring/`)

Every health dimension (Security, Code Quality, Tests, Documentation,
Maintainability, Developer Experience) is scored by a declarative
[`DimensionScoringSpec`](../src/scoring/spec.ts) consumed by the
shared pure-function evaluator in
[`src/scoring/evaluator.ts`](../src/scoring/evaluator.ts).

Each spec lives in `src/scoring/dimensions/<id>.ts` and is anchored
to a Layer-1 methodology citation in
[`STANDARDS.md`](../src/scoring/STANDARDS.md). Rating thresholds
(A ≥ 80, B ≥ 60, …) and cap ceilings (trust-broken, unmeasured,
uncertainty, …) live in
[`thresholds.ts`](../src/scoring/thresholds.ts) — every consumer
reads from there, no magic numbers in dimension code.

If a renderer is computing a score, it's a bug. Renderers consume
the evaluator's `ScoreResult` shape.

### 3. Centralized exclusions + tool registry

Two singletons every tool wrapper consults:

- **[`exclusions.ts`](../src/analyzers/tools/exclusions.ts)** —
  loads the union of bundled defaults + project `.gitignore` +
  project `.dxkit-ignore`. Tool-specific flag builders
  (`getFindExcludeFlags`, `getGrepExcludeDirFlags`,
  `getClocExcludeFlags`, `getSemgrepExcludeFlags`,
  `getJscpdIgnorePatterns`, `getPythonExcludeFilter`) all derive
  from the same resolved set. Drift between tools is impossible by
  construction.
- **[`tool-registry.ts`](../src/analyzers/tools/tool-registry.ts)** —
  defines every external tool dxkit invokes (cloc, gitleaks,
  semgrep, graphify, jscpd, eslint, npm-audit, …) including the
  install command and the detection probe. `findTool(TOOL_DEFS.xxx,
cwd)` is the only way analyzer code resolves a binary path. No
  hardcoded paths anywhere.

## Subprocess invocation: `runDetached`

Long-running tools (jscpd, semgrep, graphify, osv-scanner) are
spawned via
[`runDetached`](../src/analyzers/tools/runner.ts) rather than
`execSync`. This gives us:

- Atomic process-group kill on timeout (no orphan workers).
- Native stderr capture.
- A single-resolve safety deadline that prevents the rare
  abandoned-Promise hang when the OS doesn't deliver the child's
  exit event.

When a subprocess fails, the gather helper returns a discriminated
`{ kind: 'unavailable', reason: '...' }` outcome. The dispatcher
captures the reason into `DispatchOutcome.skipReasons`. The renderer
splits the resulting `toolsUnavailable` list into "Tools not
installed" vs "Tools that failed at runtime" so users can act on the
right thing.

## The AnalysisResult cache

Every analyzer command builds (or reads) a cached
[`AnalysisResult`](../src/analysis-result.ts) keyed by
`{ cwd, commitSha }`. The cache holds:

- `stack` — output of `detectActiveLanguages(cwd)`.
- `capabilities` — every capability envelope the dispatcher
  populated, plus per-capability availability metadata
  (`lintAvailability`, `duplicationAvailability`, etc.).
- `metrics` — pre-computed sums and rollups consumed by scorers
  and renderers.
- `securityAggregate` — the canonical aggregate that every
  security consumer reads, built by
  [`buildSecurityAggregate`](../src/analyzers/security/aggregator.ts).

Two analyzer commands run in the same shell on the same commit
produce reports with identical `analyzedAt` timestamps and
identical numbers. The cache enforces that consistency.

## Report rendering

All reports are produced from the cached `AnalysisResult` by pure
formatter functions. Each analyzer module exports a
`format<Analyzer>Report(report, elapsed) → string` pair:

- `health-audit-<date>.md` + `health-audit-<date>-detailed.{md,json}`
- `vulnerability-scan-<date>.md` + detailed companions
- `test-gaps-<date>.md` + detailed companions
- `quality-review-<date>.md` + detailed companions
- `developer-report-<date>.md` + detailed companions
- `bom-<date>.md` / `bom-<date>-detailed.json` / xlsx
- `licenses-<date>.md` / xlsx
- `dashboard.html` — interactive single-file dashboard

The `vyuh-dxkit report` orchestrator runs all eight steps serially,
asserts each step wrote its expected markdown, and renders the final
dashboard.

## Release flow

Releases go through CI exclusively — local `npm publish` is blocked
by [`scripts/require-ci.js`](../scripts/require-ci.js) and the
`publishConfig.provenance: true` setting. Tag → GitHub Release fires
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml),
which preflights tag/main/version/CI agreement before
`npm publish --provenance`. See the "Release procedure" section of
[`CLAUDE.md`](../CLAUDE.md) for the full sequence.

## Where to go next

- **[`CLAUDE.md`](../CLAUDE.md)** — the architectural rules and
  their enforcement gates. Read this before opening a PR that
  touches scoring, language packs, tool invocation, or exclusions.
- **[`docs/SCORING.md`](SCORING.md)** — the scoring rubric:
  dimensions, weights, thresholds, caps, and how rating bands map
  to scores.
- **[`CONTRIBUTING.md`](../CONTRIBUTING.md)** — local setup, the
  pre-commit hook stack, test conventions, and the
  "Adding a new language" walkthrough.
- **[`src/languages/types.ts`](../src/languages/types.ts)** — the
  `LanguageSupport` interface contract. Required reading before
  authoring a pack.
- **[`src/scoring/STANDARDS.md`](../src/scoring/STANDARDS.md)** —
  the Layer-1 methodology citations each dimension spec anchors to.
