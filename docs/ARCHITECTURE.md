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

## The declarative contract gates (`src/analyzers/flow/`, `src/analyzers/model-schema/`)

Two guardrail passes go beyond findings-in-files and gate CONTRACTS the
code declares: the flow gate (a UI call must resolve to a served route)
and the model-schema drift gate (a declared data model must not change
breakingly). Both follow one architecture, layered so a new language is a
declaration and a framework surprise cannot reach the engine:

- a pack DESCRIPTOR on `LanguageSupport` says WHICH constructs matter
  (`httpFlow`: clients + routes; `modelSchema`: model markers + field
  constructors);
- a per-grammar SYNTAX table in `src/ast/` (`grammar-shape.ts`,
  `grammar-model-shape.ts`) says HOW to read a call / class / field from
  that grammar's tree;
- ONE shared extractor per pillar says WHAT they mean — it contains no
  grammar node name and no framework literal, and is never edited for a
  language;
- a pure two-ref gate core + a fail-open guardrail glue module
  (`src/baseline/{flow,schema-drift}-gate-check.ts`) fold the verdict
  into `guardrail check` additively: typed skips, trigger-skip on
  untouched surfaces, and "unknown never blocks" honesty rules.

Both pillars also accept SPEC-declared truth (OpenAPI / JSON Schema via
`flow.specs` / `schema.specs`), so any language participates before its
pack has native extraction. The design discipline (enforced by the
synthetic-pack playbook test): a framework quirk lands as a new
descriptor capability — never an `if` in the extractor.

## The extension system (`src/extensions/`, `packages/dxkit-sdk`)

Everything team-specific plugs in through one committed surface,
`.dxkit/extensions/<name>/extension.json`, on a four-rung effort ladder
(config, declared artifact, external script, TypeScript plugin). The
architecture is a set of registries, each with a synthetic-injection
playbook test, so a new format or contribution point is an entry, never
an engine edit:

- **[`contract-sources/`](../src/analyzers/flow/contract-sources/)** (rung
  2): one reader per artifact format (OpenAPI, Postman, Pact, `.http`,
  HAR) in the `CONTRACT_SOURCE_READERS` registry; `flow.sources` entries
  dispatch through it and reduce through the ONE URL normalizer.
- **[`contributions/`](../src/extensions/contributions/)** (rung 3): the
  `CONTRIBUTION_KINDS` registry maps each wire kind (`contract.v1`,
  `inventory.v1`, `findings.v1`, `export.v1`) to its versioned,
  field-precise validators. Shipped schema versions are read forever.
- **[`run.ts`](../src/extensions/run.ts)**: the ONE runner. Rung 3 speaks
  the wire protocol over stdin/stdout in a subprocess; a rung-4 producer
  is the same protocol called in-process; both share one
  validate-stamp-snapshot tail. Execution happens only on trusted context
  at refresh time; gates read committed snapshots offline via
  [`snapshot.ts`](../src/extensions/snapshot.ts) with staleness disclosed.
- **[`plugin-host.ts`](../src/extensions/plugin-host.ts)** (rung 4): the
  ONE loader for committed CommonJS plugins (`createRequire` is
  arch-banned elsewhere). Each `defineExtension` contribution point
  registers into an EXISTING registry: `httpFlowDialect` merges
  additive-only into a pack's `httpFlow` descriptor, `contractReader`
  joins the contract-source registry, `urlNormalizer` rides the
  normalizer's `rewriteUrl` hook, producers use the runner above. Under
  `--untrusted` nothing loads, symmetrically on both gate sides, so a
  degraded lens can never produce a false block.
- **[`packages/dxkit-sdk`](../packages/dxkit-sdk)**: the frozen surface
  all of this speaks (descriptor language, wire schemas, the normalizer,
  the plugin types). Additive-only within a major; pinned by the
  three-layer surface-freeze test and arch Rule 18. It publishes itself:
  a version bump reaching main with green CI triggers the tag, Release,
  and npm publish.

Extension findings enter the gate as the custom-check seam's third
consumer (`extension:<name>` labels), inheriting located identity,
grandfathering, and allowlisting with no parallel pipeline.

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
   - Flow bindings: `(method, path, consuming file)`, line-independent
   - Schema drift: `(model, field, change class)` — fully location-free,
     so the finding survives the model moving files
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
