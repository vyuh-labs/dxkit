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

## Deep-SAST ingestion (`src/ingest/`)

dxkit's bundled SAST is intraprocedural; the interprocedural taint class
comes from external engines (Snyk Code, CodeQL, any SARIF tool) ingested
through one canonical module. The pipeline is deliberately
engine-agnostic — engines are _producers_, and nothing downstream
branches on which one ran:

```
engine → ExternalFinding (normalize) → SecurityFinding
       → security aggregate (fingerprint + cross-tool dedup, owned by
         the aggregator) → baseline / guardrail / report / graph-context
```

- **Parse** SARIF only in [`sarif.ts`](../src/ingest/sarif.ts); **read Snyk**
  only in [`snyk-api.ts`](../src/ingest/snyk-api.ts) (a quota-free REST
  read); **run CodeQL** only in [`codeql.ts`](../src/ingest/codeql.ts).
- **Persist** to a committed `.dxkit/external/<engine>.json` snapshot via
  [`snapshot.ts`](../src/ingest/snapshot.ts), so the engine token is needed
  only at ingest time — every later scan reads the snapshot.
- **Select** the engine via
  [`engine-resolver.ts`](../src/ingest/engine-resolver.ts) (license-aware:
  Snyk for private repos, CodeQL for OSS/GHAS with consent).
- Per-language engine support is declared by each pack
  (`LanguageSupport.deepSast`) and CodeQL is a guarded, opt-in tool in the
  registry — kept out of the default toolchain.

CLAUDE.md **Rule 13** + two arch-gate greps keep this path canonical:
SARIF parsing and snapshot access can't leak outside `src/ingest/`, and
ingested findings get identity from the aggregator (Rule 9), never a
parallel hash.

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

## Git-aware identity matching

A regression check is only useful if the matcher can tell an old issue
that moved from a new issue that appeared. Line numbers alone are not
stable. Adding a 20-line comment block at the top of a file shifts
every issue below it. The matcher has to look through that.

dxkit uses layered identity, in priority order:

1. **Domain fingerprints** for entities whose identity is intrinsic.
   - Dependency vulnerabilities: `(package, version, advisory-id)`
   - Secrets via `secret-hmac` kind: HMAC of the secret value, so a
     leaked token recognises itself when moved between files
   - Duplicate blocks: normalized content hash of the block
2. **Location fingerprints** with a 3-line bucket for code,
   secret, config, and hygiene findings. Bucketing absorbs small
   formatter or unrelated-edit drift.
3. **Git-aware line mapping** across commits, including `-M` file
   renames and a ±2 line fuzz window. When the baseline anchor
   commit is reachable, this is the primary matching pass for
   line-anchored kinds.
4. **Content-hash fallback** when git history is not reachable
   (shallow clones, archived snapshots, force-pushed bases).

Every match pair carries a confidence in [0, 1] and structured
reasons (`exact-id`, `git-line-exact`, `git-line-fuzz`,
`git-rename`, `content-hash`, `multiset-occurrence`). The matcher
and classifier are deterministic over normalized analyzer input.
The same inputs produce the same classifications. No LLM in the
grading path.

The matcher source lives in `src/baseline/git-aware-match.ts`. The
fingerprint helpers it consumes live in
`src/analyzers/tools/fingerprint.ts` and
`src/baseline/finding-identity.ts`. CLAUDE.md Rule 9 forbids inline
hashing of finding identity outside those canonical files.

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
