# CLAUDE.md — DXKit Development Rules

## Architecture Rules

### 1. Tool invocation goes through the registry

Every external tool (cloc, gitleaks, semgrep, graphify, jscpd, ruff, etc.) MUST be:

- **Defined** in `src/analyzers/tools/tool-registry.ts` (TOOL_DEFS)
- **Detected** via `findTool(TOOL_DEFS.xxx, cwd)` — never hardcode binary paths
- **Installed** via `vyuh-dxkit tools install` — never ad-hoc npx/pip calls

Builtins (grep, find, wc, git, node) are exempt — they're always available.

### 2. Never duplicate tool invocation logic

Each tool has ONE gather function (e.g., `gatherGraphifyMetrics` in `tools/graphify.ts`).
If another module needs that tool's output, it MUST call the existing function.
Do NOT rewrite the command string, JSON parsing, or error handling in a new file.

**Bad**: Copy-pasting the graphify Python script into parallel.ts
**Good**: Calling `gatherGraphifyMetrics()` from parallel.ts

### 3. Language facts come from detect.ts

Anything that varies by language (semgrep rulesets, file extensions, test patterns)
MUST be derived from `DetectedStack.languages`, not hardcoded per-analyzer.

### 4. Exclusions come from exclusions.ts

Directory exclusions (node_modules, dist, vendor, etc.) have ONE source of truth:
`src/analyzers/tools/exclusions.ts`. Do not hardcode exclusion lists anywhere else.

### 5. Prefer established tools over custom parsers

Before writing a regex or grep pattern, check if an established tool handles it:

- Secrets → gitleaks (not grep)
- SAST → semgrep (not grep)
- Line counts → cloc (not wc)
- AST → graphify (not regex)
- Duplicates → jscpd (not custom)
- CVSS scoring → `src/analyzers/tools/cvss-v4.ts` (ported from FIRST's reference)

Our code only stitches tools together and computes scores.

### 6. Language capabilities live in one file per language

Every language-specific concern (detection, tool list, semgrep rulesets,
coverage parsing, import extraction/resolution, metric gathering, lint
severity mapping, init-scaffold metadata) lives in a single
`LanguageSupport` implementation in
`src/languages/{python,typescript,go,rust,csharp,kotlin,java,ruby}.ts`. Dispatch everywhere
goes through `detectActiveLanguages()` / `activeLanguagesFromStack()` /
`activeLanguagesFromFlags()` / `getLanguage()` — never per-language
`if (stack.languages.python)` chains in report code.

Reports, analyzers, generators, and tool registries **must not** grow
language-specific branches. If you find yourself writing one, the right
answer is almost always to add the capability to `LanguageSupport` and
let the pack provide it.

#### LP-recipe enforcement (Phase 10i.0-LP / 10f.4)

Three layers run pre-commit + CI to keep this rule honest:

1. **`scripts/check-architecture.sh`** — greps for hardcoded `IF_<LANG>`
   references, direct `config.languages.<id>` lookups outside the
   registry-bridge files, and hardcoded `<lang>.md` rule-file strings.
   Also enforces:
   - **G_v4_7** (2.4.7 Phase B): no `grep -r{l,n,c,E,f}` recursive
     content-scan inside `run()` / `execSync()` outside the 4-file
     walker allowlist. Canonical replacement: `walkSourceFiles` +
     `countLineMatches` in `src/analyzers/tools/walk-source-files.ts`.
   - **G_v4_8** (2.4.7 Phase C1): no `[<var>.severity]++` accumulator
     bump (or `function countBySeverity`) outside
     `src/analyzers/security/aggregator.ts`. Canonical replacement:
     `buildSecurityAggregate` produces ONE `SecurityAggregate` per
     run; every consumer reads `aggregate.codeBySeverity` /
     `aggregate.depBySeverity` / `aggregate.secretsBySeverity` by
     name. Annotate `// aggregator-ok` for legitimate exceptions
     (legacy fallback in `shallow.ts`, partition-for-deduction in
     `actions.ts`).
   - **G_v4_12** (2.4.7 Phase C6.3): no hardcoded `maxDepth = N` or
     `depth > N` in `src/languages/*.ts`. Manifest and source-file
     discovery inside language packs MUST route through the canonical
     depth-unlimited walker `walkPaths` in
     `src/analyzers/tools/walk-paths.ts`. Closes the class of
     "manifest deeper than the per-pack hardcoded cap" misses —
     real customer monorepos routinely exceed every cap any pack
     author has ever chosen (the .NET WinForms benchmark: csproj
     files at depths 6–9; the previous csharp cap was 3–5). Annotate
     `// canonical-walker-ok` for justified exceptions (the walker
     module itself, probes that explicitly target a build-output
     subtree like `TestResults/` that the canonical walker rightly
     excludes).
2. **`test/languages-contract.test.ts`** — for every `LanguageSupport`,
   verifies metadata completeness (`permissions`, `cliBinaries`,
   `defaultVersion`, `projectYamlBlock`) and `tools[]` ↔ source-call
   parity (closes D009).
3. **`test/recipe-playbook.test.ts`** — synthetic 6th-pack injection
   test. Confirms each pack-iterating consumer (generator, doctor,
   detect, project-yaml, constants, coverage, generic, grep-secrets,
   tool-registry) picks up a hypothetical new pack's contributions.
   Also asserts the canonical security aggregator picks up
   synthetic-pack depVuln + cross-tool TLS-bypass contributions
   regardless of pack identity (G_v4_8 recipe-codification).
   Catches "the architecture stopped being pack-driven" empirically.

Adding a new language pack is a one-command scaffold + filling in TODOs:
`npm run new-lang <id> "<displayName>"`. See `CONTRIBUTING.md` "Adding a
new language" for the full walkthrough.

### 7. Dimension scoring lives in declarative specs under `src/scoring/`

Every dimension's score (Security, Code Quality, Tests, Documentation,
Maintainability, Developer Experience) is produced by a declarative
`DimensionScoringSpec<T>` consumed by the shared pure-function
evaluator in `src/scoring/evaluator.ts`. The spec engine produces a
`ScoreResult` with structured deductions, the binding cap, and
top-actions sorted by potential uplift — uniform output shape that
renderers and agents consume directly.

- **Defined** in `src/scoring/dimensions/<id>.ts` (one file per
  dimension; mirror of CLAUDE.md Rule 6 applied to scoring)
- **Registered** in `src/scoring/index.ts:SCORING_SPECS`
- **Evaluated** via `evaluateSpec(SPEC, input)` — never a one-off
  score-arithmetic function
- **Anchored** to a Layer-1 methodology citation in
  `src/scoring/STANDARDS.md`. The `methodology` field on each spec
  is a token referencing that doc

Status thresholds (A≥80, B≥60, C≥40, D≥20, E<20) and cap-tier
ceilings (trust-broken=40, unmeasured=35, uncertainty=65,
partial-uncertainty=75, fixable-finding=79) live in
`src/scoring/thresholds.ts`. Every consumer routes through
`ratingFromScore` / `RATING_THRESHOLDS` / `CAP_TIERS` — never
hardcoded.

**Bad**: `if (score >= 80) return 'excellent'`, `function status(s) { ... }`,
inline penalty stacks in analyzer subdirs, `score -= 15` outside
specs, `src/analyzers/quality/scoring.ts` (or any
`src/analyzers/**/scoring.ts`).

**Good**: `rating = ratingFromScore(score)`, declarative
`PenaltyRule` + `CapRule` arrays consumed by `evaluateSpec`,
adapters in `src/analyzers/<dim>/shallow.ts` that build the
per-dimension input and dispatch through the spec.

#### Scoring-discipline enforcement

Three rules in `scripts/check-architecture.sh` (pre-commit + CI):

1. No `src/analyzers/**/scoring.ts` files (dimension scoring lives
   in `src/scoring/dimensions/<id>.ts`).
2. No hardcoded rating-band threshold integers (`>= 80` etc.) in
   scoring-related code outside `thresholds.ts`.
3. No hardcoded cap-ceiling values (40 / 35 / 65 / 75 / 79) used as
   `score = N` or `final = N` outside the scoring module.

Annotate `// scoring-spec-ok` on the violating line for justified
exceptions (CVSS risk-tier bands, coverage thresholds that
deliberately differ from rating thresholds, etc.).

The `test/scoring-playbook.test.ts` synthetic-dimension test
exercises the registry + evaluator + format helpers end-to-end with
an injected spec. Catches "the architecture stopped being
spec-driven" empirically — analogous to `test/recipe-playbook.test.ts`
for language packs.

### 8. Per-stack architectural shape lives in `LanguageSupport.architecturalShape`

Every per-stack architectural fact — primary component paths (the
surfaces a developer would test first), HTTP route handler paths,
data-model paths, prose vocabulary, and the per-bucket test-gap
priority taxonomy — is declared by each language pack and consumed
through the registry helpers in `src/languages/index.ts`. The
cross-cutting analyzer + renderer code never carries hardcoded
backend-centric path patterns or framework vocabulary.

- **Declared** per-pack in `src/languages/<id>.ts:architecturalShape`
  (optional — packs with no canonical conventions omit it)
- **Consumed** via `allPrimaryComponentPaths(flags)`,
  `allRoutePaths(flags)`, `allModelPaths(flags)`,
  `allTestGapPriorityPaths(flags)`, `dominantVocabulary(flags)` —
  every cross-cutting consumer reads from the active-pack union, so
  adding a new pack auto-extends every consumer

The class-fix replaces inline `if (path.includes('/controllers/'))`
classifier code, hardcoded `find -path "*/controllers/*"` shell
commands, and "controllers / handlers, models" prose with active-
pack-driven equivalents. Pre-extension a pure React frontend or .NET
WinForms desktop app matched none of those backend-centric defaults
and reported 0/0/0 across test-gap CRITICAL/HIGH/MEDIUM buckets;
post-extension each stack's primary surface populates correctly.

**Bad**: `'/controllers/'` / `'/services/'` literals inside
`src/analyzers/` (hardcoded paths); `type: 'controller' | 'service' |
...` closed unions (pre-extension `SourceFile.type`); inline
"controllers / handlers" prose in renderers; `find -path
"*/controllers/*" -name "*.ts"` shell commands in gather code.

**Good**: `for (const p of allPrimaryComponentPaths(flags))` in
consumers; pack-declared
`primaryComponentPaths: ['/controllers/', '/components/', '/Forms/']`
unioned across active packs; `dominantVocabulary(flags)?.components`
in renderer prose.

#### Architectural-shape enforcement

Two rules in `scripts/check-architecture.sh` (pre-commit + CI),
both scoped to `src/analyzers/`:

1. No quoted path-style framework literals — strings shaped
   `/<role>/` for roles in the architectural-shape vocabulary
   (`controllers`, `handlers`, `services`, `models`, `entities`,
   `forms`, `viewmodels`, `pages`, `views`, `components`, `hooks`,
   etc.). Path patterns belong in
   `src/languages/<id>.ts:architecturalShape.primaryComponentPaths`
   / `routePaths` / `modelPaths`.
2. No bare singular role-name string literals (`'controller'`,
   `'service'`, `'handler'`, `'interceptor'`, `'repository'`,
   `'viewmodel'`, `'viewset'`, `'router'`). The pre-extension
   `SourceFile.type` closed enum was replaced by a free string label
   drawn from `patternToLabel(matched architecturalShape pattern)`.
   Generic words (`'model'`, `'component'`, `'form'`, `'view'`,
   `'page'`) are NOT flagged — they appear too often in
   non-architectural contexts (ML data models, view-rendering libs,
   page-object test patterns).

Allowlist:

- `src/analyzers/maintainability/shallow.ts` for the generic
  vocabulary fallbacks (`'components'`, `'models'`) consumed when no
  active pack supplies a label.
- Annotate `// arch-shape-ok` on a violating line for justified
  exceptions (rare).

The `test/recipe-playbook.test.ts` synthetic 6th-pack injection test
asserts the synthetic pack's `architecturalShape` contributions flow
through the test-gap taxonomy and Maintainability prose — analogous
to its existing assertion for `depVuln` + `tlsBypass` contributions
(G_v4_8).

### 9. Per-finding identity flows through the canonical fingerprint helpers

Every actionable per-finding output dxkit surfaces (secrets,
code-pattern findings, dependency advisories, license attributions,
duplicate blocks, coverage gaps, test-gap source files, hygiene
markers, and any future kind) MUST receive its durable identity from
the canonical helpers, never an inline hash:

- **Compute** via `src/analyzers/tools/fingerprint.ts` — the home of
  every SHA-1[0:16] fingerprint scheme (`computeFingerprint` for
  dep-vulns, `computeCodeFingerprint` for code/secret/config,
  `canonicalRuleFor` for cross-tool dedup, `lineWindowFor` for the
  shared 3-line bucket).
- **Dispatch** via `src/baseline/finding-identity.ts:identityFor` —
  the single switch over `IdentityInput` discriminants. Adding a new
  finding kind is a three-line change (interface → union →
  case branch), with TypeScript's exhaustiveness check enforcing
  switch completeness.
- **Compare** via `src/baseline/finding-identity.ts:matchAcrossRuns`
  (multiset-aware set diff) or `src/baseline/git-aware-match.ts`
  (git-aware line relocation with file-rename support and
  ±2 line fuzz). Every match pair carries confidence in [0, 1]
  plus structured reasons (`exact-id`, `git-line-exact`,
  `git-line-fuzz`, `git-rename`).

The fingerprint is the durable contract between today's scan and
tomorrow's guardrail check. Bypassing the canonical helpers means
silently opting out of that contract.

#### Fingerprint-discipline enforcement

Four rules in `scripts/check-architecture.sh` + `test/`:

1. **No `createHash` for finding identity outside the canonical
   files.** Allowed in `src/analyzers/tools/fingerprint.ts`,
   `src/baseline/finding-identity.ts`, and
   `src/baseline/content-hash.ts` (content-hash fingerprints for
   the drift-tolerant matcher fallback). Annotate
   `// fingerprint-helper-ok` for justified non-identity hashing
   (today: zero needed inside `src/analyzers/` and `src/baseline/`).
2. **No inline `Math.floor(x / N) * N`-style line-bucketing**
   outside `tools/fingerprint.ts`. Forces consumers through
   `lineWindowFor()` so the 3-line constant lives in one place.
3. **Every `IdentityInput` discriminant has a fixture row in
   `test/baseline/finding-identity.test.ts`.** Asserted at test
   time: when a new kind lands in the union, a fixture must
   accompany it or the assertion fails.
4. **Synthetic-pack findings flow through the canonical helpers.**
   `test/recipe-playbook.test.ts` asserts the synthetic pack's
   code-pattern + dep-vuln contributions emerge from the aggregator
   with non-empty `fingerprint` fields matching the canonical
   format — codifies "fingerprinting is pack-driven, not
   analyzer-by-analyzer."

## Release procedure

**Every release goes through the CI pipeline. No exceptions.** Local
`npm publish` is blocked by `scripts/require-ci.js` (wired as the
`prepublishOnly` hook) and additionally disabled by
`publishConfig.provenance: true`, which requires an OIDC token that
only exists inside GitHub Actions.

Sequence for a new release:

1. Work on a `feat/<phase-or-change>` branch.
2. Open a PR against `main`. CI must pass (typecheck, lint, format, tests, coverage, architecture rules, slop check, `npm pack --dry-run`).
3. Merge via the GitHub UI — not a local `git push`. Branch protection on `main` enforces this.

   **Choose the merge strategy by branch shape:**
   - **Squash merge** when the branch is a single logical change (one
     feature, one bug fix, one refactor) regardless of how many WIP
     commits it took to get there. The collapsed message reads as a
     coherent unit; intermediate commits don't carry standalone value.
     Example: PR #22 (kotlin pack) was scoped as one unit even though
     it bundled Recipe v2 — collapsed cleanly because nobody needs to
     bisect to "kotlin pack but before Recipe v2".
   - **Rebase merge** when the branch bundles multiple independently-
     meaningful units — discrete defect closures (D008, D011),
     architectural refactors (Recipe v3 / G2 / G5 / G9), and feature
     work — each with its own prose-quality commit message. Preserving
     atomic commits is high-value because:
     1. Bisect granularity halves debug time on future regressions
     2. Recipe-vN working doc cross-references commit SHAs by gap-id
        — squashing invalidates them
     3. Defect closures grep cleanly (`git log --grep=D008`) only when
        their commits aren't buried inside a feature squash
        Example: PR for Phase 10k.1 Java pack rebase-merged so D008,
        D011, G5 (docs gate), G2 (capabilities optional), G9 (detect
        source-driven), and 5 capability commits each survive on main.
   - **Merge commit** is a fallback only when neither fits cleanly.
     Default to one of the two above.

   Two questions to disambiguate at PR-open time:
   - "Is each commit independently meaningful, or are they WIP toward
     one outcome?" → if independent, rebase. If WIP, squash.
   - "Do any commit SHAs get referenced from elsewhere
     (`tmp/recipe-vN-working-doc.md`, memory pointers, future
     checkpoints)?" → if yes, rebase to preserve them.

4. In the PR (or a follow-up), bump `package.json` + `package-lock.json` + add a `CHANGELOG.md` entry for the new version.
5. After the release commit is on `main` and CI is green there:

   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```

6. Create a GitHub Release from the tag. This fires `.github/workflows/publish.yml`, which preflights:
   - tag `vX.Y.Z` matches `package.json` version `X.Y.Z`
   - tagged commit is reachable from `origin/main` (no feature-branch tags)
   - the `CI` workflow succeeded on the tagged commit SHA
   - `X.Y.Z` is not already on npm

   Only then does it `npm pack` + `npm publish --provenance` + verify the
   registry shasum matches the locally built tarball. The tarball is
   archived as a workflow artifact for 90 days.

**Why this exists**: the v2.2.0 release shipped from a local
`npm publish` that raced the CI-driven one (CI lost with 403 — version
already taken). The code on npm matched main byte-for-byte, but the
release path was unauditable and provenance was absent. Tracked
internally as D015.

**Never run `npm publish` locally.** The guard will stop you with a
clear error message; don't try to work around it.

## Build & Test

```bash
npm run build        # TypeScript → dist/
npm run test:run     # Vitest (~850 tests, ~2 min wall-clock with cross-ecosystem matrix)
npm run lint         # ESLint
npm run format:check # Prettier
npm run new-lang <id> "<displayName>"  # Scaffold a new language pack (LP.7 / 10f.4)
```

Pre-commit hooks (husky + lint-staged) run eslint + prettier + typecheck on staged files,
plus `check-architecture.sh` (CLAUDE.md rules + LP-recipe enforcement),
`check-slop.sh`, and `check-cross-ecosystem-coverage.sh`.

## CLI Commands

```bash
vyuh-dxkit health [path]          # 6-dimension health score
vyuh-dxkit vulnerabilities [path] # Deep security scan
vyuh-dxkit test-gaps [path]       # Test coverage gaps
vyuh-dxkit quality [path]         # Code quality + slop score
vyuh-dxkit dev-report [path]      # Developer activity
vyuh-dxkit tools [list|install]   # Tool status & installation
```

## Key Files

- `src/detect.ts` — stack detection (languages, frameworks, tools)
- `src/types.ts` — `LanguageId` union + `DetectedStack` (`languages: Record<LanguageId, boolean>` post-10f.4) + `ToolRequirement`
- `src/languages/types.ts` — `LanguageSupport` interface (the contract)
- `src/languages/{python,typescript,go,rust,csharp,kotlin,java,ruby}.ts` — one file per language
- `src/languages/index.ts` — `LANGUAGES` registry; `getLanguage`, `detectActiveLanguages`, `activeLanguagesFromStack`, `activeLanguagesFromFlags`, `allSourceExtensions`, `allTestFilePatterns`, `splitTestFilePatterns`
- `src/analyzers/tools/tool-registry.ts` — tool definitions, detection, install
- `src/analyzers/tools/exclusions.ts` — centralized exclusion paths
- `src/analyzers/tools/osv.ts` — OSV.dev severity enrichment (session cache + offline fallback)
- `src/analyzers/tools/cvss-v4.ts` — CVSS v4.0 base-score calculator (FIRST reference port)
- `src/analyzers/health.ts` — health orchestrator (async, `Promise.all` over packs)
- `src/analyzers/{security,tests,quality,developer}/` — deep analyzers
- `scripts/scaffold-language.js` — `npm run new-lang <id> "<displayName>"` recipe scaffolder (LP.7 / 10f.4)
- `scripts/check-architecture.sh` — pre-commit + CI: enforces CLAUDE.md rules + LP-recipe rules
- `test/languages-contract.test.ts` — pack contract tests (D009 closure)
- `test/recipe-playbook.test.ts` — synthetic 6th-pack playbook (LP-architecture regression guard)
