# CLAUDE.md — DXKit Development Rules

## Architecture Rules

### 1. Tool invocation goes through the registry

Every external tool (cloc, gitleaks, semgrep, graphify, jscpd, ruff, etc.) MUST be:

- **Defined** in `src/analyzers/tools/tool-registry.ts` (TOOL_DEFS)
- **Detected** via `findTool(TOOL_DEFS.xxx, cwd)` — never hardcode binary paths
- **Installed** via `vyuh-dxkit tools install` — never ad-hoc npx/pip calls

Builtins (grep, find, wc, git, node) are exempt — they're always available.

**CI tool discoverability is registry-derived, never a hardcoded PATH.** The
places a tool binary can live are declared once — `getSystemPaths()` plus each
tool's `probePaths` in the registry — and `findTool` probes them. The CI PATH
export (`exportToolPathsToGithubEnv`, run at the end of `tools install`) reads
the SAME sources and writes them to `$GITHUB_PATH`, so the per-language dep audit
finds its native scanner (osv-scanner / pip-audit / govulncheck / cargo-audit)
in a workflow step instead of silently falling back to a wrong-artifact scanner.
A new language pack that installs a scanner to a new directory declares it in the
tool's `probePaths` (already required for detection) and is thereby covered in CI
automatically — do NOT hardcode a per-ecosystem bin dir in a workflow template.
`test/tool-paths-ci.test.ts` pins that every tool `probePath` appears in the
export.

### 2. Never duplicate tool invocation logic

Each tool has ONE gather function (e.g., `gatherGraphifyMetrics` in `tools/graphify.ts`).
If another module needs that tool's output, it MUST call the existing function.
Do NOT rewrite the command string, JSON parsing, or error handling in a new file.

**Bad**: Copy-pasting the graphify Python script into parallel.ts
**Good**: Calling `gatherGraphifyMetrics()` from parallel.ts

#### One concept, one code path (2.30 — the recurring-bug fix)

The most persistent dogfood-bug class is a special case of Rule 2: **one concept
is computed in two independent code paths, a fix lands in the path you're
editing, and the sibling keeps misbehaving.** Real instances: the `env-in-git`
metric count vs its per-finding producer (a fix to exempt `.env.example` reached
only the count); a placeholder-secret filter added to the gitleaks provider but
not the `grep-secrets` fallback; `flow.stripUrlPrefixes` threaded into the map +
gate gathers but not the diagnose + detect gathers. Each shipped because the
duplicate path was in a different file/layer and nothing forced a single entry
point.

When a concept has multiple consumers, give it ONE entry point and route every
consumer through it (canonical examples added in 2.30):

- committed env-file detection → `trackedEnvFiles` in
  `src/analyzers/security/env-files.ts` (the only `git ls-files .env`);
- a repo's flow model WITH its policy config applied → `gatherRepoFlowModel` in
  `src/analyzers/flow/gather.ts` (loads `stripUrlPrefixes` / `specs` itself, so a
  surface cannot forget them); the raw `gatherFlowModel` is only for
  explicit-config callers (the two-ref gate, cross-repo publish, the map CLI);
- a repo's declared MODEL SET with its policy config applied →
  `gatherRepoModelSet` in `src/analyzers/model-schema/gather.ts` (loads
  `schema.specs` itself; the raw `gatherModelSet` is only for the two-ref
  gate's explicit-config sides). What schema DRIFT a diff contains →
  `diffModelSets` in `src/analyzers/model-schema/model.ts`, the ONE drift
  computation consumed by BOTH the guardrail gate and `schema diff`
  (pinned by `test/schema-gate-diff-parity.test.ts` — same
  parity-test discipline as the flow gate/join pair below);
- whether a consumed `(method, path)` is SERVED → `servedMatch` /
  `catchAllPrefixCovers` in `src/analyzers/flow/model.ts`. BOTH the join (doctor's
  `diagnoseFlow`) and the integration gate (`evaluateFlowGate`) resolve a call
  against the served set through this ONE catch-all-aware predicate. The recurring
  shape here (the flagship instance of the _semantic_-divergence variant): the gate
  held a LOSSY projection of the concept — a `Set<string>` of exact `${method}
${path}` keys, which discards catch-all structure — so it did exact membership
  only and hard-blocked every call served by a `[...slug]` / `/**` catch-all that
  doctor resolved cleanly. `buildServedMatcher` rebuilds the catch-all prefixes
  from the key set so the gate inherits the join's resolution. The consumed side's
  path-intrinsic confidence is likewise one function, `consumedPathConfidence` (a
  leading `{var}` has no anchor → warn, not block);
- benign secret / env conventions → `isPlaceholderSecret` / `isExampleEnvFile`
  (Rule 5's benign module), consulted by BOTH secret detectors.
- what dxkit OWNS vs what the user owns, for a managed file → the manifest's
  `provenance` (`created`/`overwritten`/`skipped`) + `hash`. BOTH the update
  write path (`decideUpdateDisposition` in `src/update-disposition.ts`, consumed
  by the generator) and `uninstall` (`src/uninstall/`) read them — so `update`
  refreshes a dxkit-owned unmodified file yet never clobbers a user file, on the
  same model uninstall uses. The recurring shape here (2.33): a fix landed in
  uninstall's provenance handling but update decided on "exists?" + `--force`
  alone, so it no-op'd its own fixes AND `--force` deleted user files. When you
  touch how a managed file is written or removed, both paths consult the same
  fields.
- effective branch protection → `classifyEnforcement` in `src/enforcement.ts`
  reads BOTH mechanisms (classic `/branches/{b}/protection` AND repository
  rulesets `/rules/branches/{b}`) and unions them. Reading only one (the class
  that shipped: a ruleset-protected branch 404s the classic endpoint and read as
  "unprotected") is the bug — every consumer (`doctor`, the anchor-transport
  selector, `protect`) reads this one classifier.
- which dependency scanner can read this repo → `detectLockfile`
  (`src/package-manager.ts`). A scanner must be pointed at a lockfile it
  understands (`npm audit` needs an npm lockfile; a pnpm/yarn/bun lockfile routes
  to the shared lockfile-aware `gatherOsvScannerDepVulnsResult`). Selecting a
  scanner without consulting the present lockfile is the bug. The set of
  dependency-audit ROOTS is likewise one concept: pack-declared
  `lockfilePatterns` + `discoverNestedDepRoots`
  (`src/analyzers/security/nested-dep-roots.ts`), consumed at the ONE
  dispatch primitive (`gatherDepVulnsWithAvailability`) so reports and the
  gate audit the same lockfile set — the shipped bug: root-only auditing
  read a nested sub-project's critical vuln as CLEAN.
- the set of optional SHIP surfaces dxkit installs (CI workflows, git hooks,
  the devcontainer, the loop pack, the dxkit devDependency, the ignore files) →
  `MANAGED_SHIP_SURFACES` in `src/managed-artifacts.ts`. These are NOT recorded
  in `manifest.files` (the generator's provenance covers only its own
  templates), so their lifecycle is registry-driven: uninstall's
  `managedGatedArtifacts`, update's `refreshManagedSurfaces`, and the legacy
  `detectInstallFlags` fallback ALL iterate this one list. The recurring shape
  here: a surface wired independently in each path drifts — the deep-SAST
  refresh workflow shipped installed + uninstalled but NEVER refreshed by
  update (it had no flag and no entry in update's loop). Adding a surface is one
  registry entry; it cannot silently skip update or uninstall. Files that dxkit
  MERGES into (`.gitignore`, `package.json`, `.claude/settings.json`,
  `CLAUDE.md`) are reverted by `src/uninstall/reversals.ts`, a separate
  centralized mechanism — a merge-only surface carries an empty `artifacts` list.

`scripts/check-architecture.sh` gates the first two (a second `git ls-files
.env` or a config-less `gatherFlowModel` on a single-repo surface fails CI) and
the managed-artifact registry (Rule 15: a module that writes a `.github/workflows`
/ `.githooks` / `.devcontainer` artifact outside `src/ship-installers.ts` fails
CI; annotate `// managed-write-ok` for a read-only exception). The `update`
provenance lane is pinned by `test/lifecycle/` (the update lane) and the
`test/update-disposition.test.ts` branch matrix; the ship-surface registry is
pinned by `test/managed-artifacts-playbook.test.ts` (synthetic-surface injection
— asserts uninstall + update both pick up a newly-registered surface, mirror of
`recipe-playbook.test.ts`).

**Two variants of this class, two nets.** A _lexical_ duplicate (a second `git
ls-files .env`, a config-less `gatherFlowModel`) is a copy-paste the arch-check
greps for. But the flow gate-vs-join bug was a _semantic_ divergence: two
functions computing the same concept (`servedMatch` vs an exact `Set.has`) with
no shared token to grep — one path simply held a lossy shape of the data and
re-implemented weaker logic against it. Grep cannot see that `.has(key)` is a
degenerate `servedMatch`. The only net that catches semantic divergence is a
**parity test** that runs BOTH consumers on shared fixtures and asserts they
agree (`test/flow-gate-join-parity.test.ts`: every call the join resolves must
NOT be a gate block, and vice-versa). So: when one concept has two consumers that
hold DIFFERENT data shapes (routes vs a key-set, a rich model vs a projection),
an arch-check rule is not enough — add a parity test. The lossy-projection shape
is the smell: the moment you reduce a concept to a cheaper representation for one
consumer, you have opened the door to re-deriving its logic incorrectly.

#### The fixture-repo ANALYSIS harness (`test/fixtures-analysis.test.ts`)

dxkit's own self-guardrail runs on dxkit's repo, which has no `.env.example`, no
base-URL-helper flow calls, no catch-all routes — so it is structurally BLIND to
the shapes real repos have, which is why the class above kept reaching users.
The fix is the analysis analog of the install/uninstall lifecycle net
(`test/lifecycle/`): minimal per-stack fixtures under `test/fixtures/analysis/`
that dxkit runs its user-facing gathers on, asserting cross-cutting invariants.
It is deliberately a MATRIX (TS + Python + Go), not one Payload/Next.js repo —
the language-agnostic invariants (`.env.example` is not a finding; a placeholder
secret is dropped) must hold on every stack, so a fix that only works for one
overfits and fails here. A new language pack adds a fixture dir + a row and
inherits the checks. When you fix an analysis bug a customer reports, add a
fixture that reproduces it — that is what makes the guardrail see it.

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

#### Benign-convention false positives live in one module (2.29)

Convention-based false positives — an `.env.example` (not a leaked `.env`), a
placeholder secret value (`password: 'password'`, `apiKey = 'your-api-key'`,
`<your-key>`) — are decided by ONE source of truth,
`src/analyzers/security/benign.ts` (`isExampleEnvFile`, `isPlaceholderSecret`).
Every secret / env detector consults it — BOTH secret scanners (the gitleaks
provider AND the `grep-secrets` generic-credential fallback) plus the env-in-git
count — so the floor is fixed once and a new pack's secret patterns inherit the
exemptions. When you add a secret detector, wire it to `isPlaceholderSecret` too
(the class of bug: a second detector that skips the module silently
re-introduces the floor — this shipped once, caught by the self-guardrail). Do
NOT inline a `.env.example` string or a placeholder-value list in an analyzer —
extend the module. Bias the predicates toward false NEGATIVES (never suppress a
real credential). `test/security-benign.test.ts` + `test/grep-secrets.test.ts`
pin the cases.

#### Package-manager commands route through `src/package-manager.ts` (2.26 → 2.29)

Any node devDependency install command shown to or run by a user MUST match the
repo's package manager (pnpm/yarn/bun/npm) — a raw `npm install --save-dev` on a
pnpm repo is the class of bug that shipped a 404-ing create-dxkit and npm-only
doctor hints. Build the command via `addDevCommand` / `pmAwareDevInstall`
(the canonical npm form lives only in `TOOL_DEFS`, rendered PM-aware at display
time). `scripts/check-architecture.sh` bans a raw `npm install --save-dev` /
`npm i -D` literal outside `src/package-manager.ts` + the tool registry
(annotate `// pm-aware-ok` for a justified exception).

### 6. Language capabilities live in one file per language

Every language-specific concern (detection, tool list, semgrep rulesets,
coverage parsing, import extraction/resolution, metric gathering, lint
severity mapping, dependency-manifest patterns, init-scaffold metadata,
CI runtime setup via `ciSetup` — the GitHub Actions steps that install the
pack's toolchain, unioned through `allCiSetupSteps` and rendered into the
workflow templates, so CI is never Node-only)
lives in a single
`LanguageSupport` implementation in
`src/languages/{python,typescript,go,rust,csharp,kotlin,java,ruby}.ts`. Dispatch everywhere
goes through `detectActiveLanguages()` / `activeLanguagesFromStack()` /
`activeLanguagesFromFlags()` / `getLanguage()` — never per-language
`if (stack.languages.python)` chains in report code.

Dependency-manifest patterns are a worked example: each pack's `depVulns`
capability declares its manifests + lockfiles via the **required**
`manifestPatterns` field on `DepVulnsProvider`, consumed through
`allDependencyManifestPatterns()` / `changedFilesTouchDependencyManifest()`
to drive the incremental ref-based dep-audit skip in
`runGuardrailCheck` (skip the OSV audit when a PR changed no manifest — a
net-new dep vuln requires one). A new pack that adds dep auditing but omits
the patterns **fails to compile** (required field) and **fails
`test/languages-contract.test.ts`** (non-empty assertion);
`test/recipe-playbook.test.ts` proves the union stays pack-driven via a
synthetic 6th pack.

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
   `defaultVersion`) and `tools[]` ↔ source-call parity.
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

#### Identity inputs must be tool- and environment-independent

The contract only holds if a finding's identity is **reproducible from
one environment to the next** — otherwise a committed baseline/allowlist
stops matching when the scan moves from a developer's machine to CI.
So an identity scheme may hash **only inputs dxkit derives itself**:
the source file's content/structure (read by dxkit, not captured by a
tool), the finding's location, and an intrinsic, tool-independent
classification. It MUST NOT hash:

- a **specific tool's captured text** (gitleaks' `Secret` field, a grep
  capture group, semgrep `extra.lines`, an ingested SARIF
  `region.snippet.text`) — different tools capture different text for
  the same finding;
- the **(tool, rule) pair** when a tool-independent discriminator
  exists — secrets fold onto the constant `SECRET_CANONICAL_RULE`
  (every secret is "a leaked credential", so the same leak found by
  different scanners shares one identity); code keeps its per-tool
  canonical rule only because distinct rules on one construct are
  genuinely distinct findings;
- an **environment-derived salt** (`DXKIT_BASELINE_SALT` / `.dxkit/salt`
  / root-SHA) — it differs across environments. (The salt survives only
  in the separate `secret-hmac` kind, whose anti-rainbow-table purpose
  requires it; that kind is for cross-file relocation matching, not
  per-occurrence identity.)

Known exception, tracked: **code** identity still hashes a tool-captured
span (`spanHash`) and its per-tool canonical rule, so it can drift
across engines (semgrep vs an ingested CodeQL/Snyk run) under
inconsistent multi-engine ingestion. It is stable on the bundled-semgrep
default path. A future scheme version should give code a dxkit-read
source anchor; the migration platform below makes that a non-event for
users.

#### Identity-scheme versioning (migration contract)

`identityFor` takes an `IdentitySchemeVersion` and can compute **any
shipped scheme**, not just the current one (`CURRENT_IDENTITY_SCHEME`).
That is what lets `src/baseline/migrate.ts` carry a repo's baseline +
allowlist across an upgrade automatically (`vyuh-dxkit update`) instead
of forcing a manual re-baseline + re-allowlist. Two rules keep that
mechanism working — treat them as load-bearing:

1. **Never delete a shipped scheme's id function.** When you change how a
   kind is hashed, bump `IdentitySchemeVersion` (e.g. `'v2' → 'v3'`), add
   the new branch in `identityFor`, and **keep the old formula** as a
   versioned helper (the pattern: `computeFingerprintV1` retains the
   pre-2.11 dep-vuln hash). A migration from an older scheme must be able
   to reproduce its output byte-for-byte.
2. **Keep every id input on the finding.** A scheme's id must be
   recomputable from a current finding's fields + the baseline entry's
   stored metadata (`baselineEntryToIdentityInput` is the inverse). Don't
   drop a field an older scheme needs, or that scheme becomes
   unmigratable. (`contentAnchor` is the allowed exception: it's not
   stored on the entry because only the current scheme reads it and the
   entry's `id` already IS the current id.)

Then stamp `CURRENT_IDENTITY_SCHEME` on every artifact you write
(`BaselineFile.identityScheme`, `AllowlistFile.identityScheme`) so a later
dxkit can detect the gap, and the guardrail's scheme-mismatch guard +
`update`'s auto-migration handle the rest with no new wiring.

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

### 10. Baseline producers flow through the canonical registry

Every analyzer that surfaces per-finding output MUST flow into the
baseline file via a producer registered in
`src/baseline/producers/index.ts:PRODUCERS`. The baseline-create
orchestrator iterates the registry — no per-analyzer wiring
elsewhere. Without the registry, adding a new analyzer means
remembering to also edit the orchestrator, and the bug is invisible
(guardrails pass while silently bypassing the new finding kind).

- **Register** in `src/baseline/producers/index.ts:PRODUCERS` —
  the single discovery surface. Each producer declares the
  `IdentityKind` values it contributes and supplies a pure
  `produce(ctx: ProducerContext) => BaselineEntry[]` function.
- **Defer** in `src/baseline/producers/index.ts:DEFERRED_KINDS` —
  identity kinds without an upstream gather yet land here with
  explicit `reason` + `landingPhase`. Makes architectural gaps
  discoverable from one place rather than requiring code spelunking.
- **Compute identity** via `identityFor` only from inside a
  registered producer (or from the dispatch definition itself in
  `src/baseline/finding-identity.ts`). The arch gate enforces this
  at commit time.

The registry is the durable contract between today's analyzer set
and tomorrow's guardrail check. Bypassing it means silently opting
out of the contract.

#### Producer-discipline enforcement

Three rules:

1. **`scripts/check-architecture.sh` Rule 10**: `identityFor(` is
   only callable from `src/baseline/producers/**` and from
   `src/baseline/finding-identity.ts`. Annotate
   `// rule10-producer-ok` for justified exceptions (today: zero
   needed).
2. **`test/baseline/producers-contract.test.ts`**: every
   `IdentityKind` is EITHER contributed by some registered
   producer OR present in `DEFERRED_KINDS` with non-empty
   `reason` + `landingPhase`. Never both. Every deferred entry
   references a real `IdentityKind`. Producer names are unique;
   no two producers claim the same kind.
3. **`test/baseline/producer-playbook.test.ts`**: synthetic-
   producer injection. Build a fake `BaselineProducer`, call
   `runProducers([... PRODUCERS, fake])`, assert the fake's
   sentinel entry appears in the output. Catches "orchestrator
   stopped iterating the registry" — mirror of
   `recipe-playbook.test.ts` for language packs (CLAUDE.md
   Rule 6).

### 11. Baseline mode resolution flows through one canonical resolver

The baseline mode (`committed-full` | `committed-sanitized` |
`ref-based`) decides three things at once: whether to write a
baseline file, whether to strip entries via `sanitizeFile`, and
whether the guardrail check loads its prior side from disk or
re-gathers from a git ref. Mode picking lives in a single
function — `resolveBaselineMode` in `src/baseline/modes.ts` —
with two adjacent helpers locked to the same module:

- **Visibility detection** (`gh repo view --json visibility`) is
  confined to `src/baseline/visibility.ts`. Other call sites ask
  the resolver, not re-shell to `gh`. Lets every consumer benefit
  from the per-process visibility cache and stops the "different
  modules pick different defaults" drift class before it starts.
- **Ref-based gather** (`git worktree add` / `worktree remove`)
  is confined to `src/baseline/ref-baseline.ts`. Other consumers
  go through `withRefWorktree(opts, fn)` or `gatherFromRef(opts)`
  — the temp-dir + cleanup + salt-mirroring dance lives in one
  place so future "do something at a git ref" features compose
  on the same primitive. Its **remote sibling** `withRemoteRefWorktree({repo, ref}, fn)`
  lives in the adjacent `src/baseline/remote-ref.ts` (same Rule-11 contract,
  split out only for module size — it uses clone/fetch, never `git worktree`,
  so it does not trip the worktree arch-check): it shallow-fetches a repo NOT in
  the local object DB (a cross-repo `flow publish` participant declared by `repo:` URL)
  into a temp checkout with the same try/finally cleanup. Auth is the
  ambient git env with BOTH prompt paths disabled (`GIT_TERMINAL_PROMPT=0`
  - SSH `BatchMode=yes`) and a bounded timeout, so a bad remote fails
    FAST rather than hanging a gate; `repo`/`ref` come from committed
    `workspace.json`, so an argument-injection guard rejects a leading-`-`
    value. Only `flow publish` (explicit, offline-committed) fetches —
    the per-commit gate reads the committed `served.json`, never clones.

Precedence inside the resolver (locked in 2.6 Sprint 0):

1. `--mode` / `--ref` CLI flag
2. `.dxkit/policy.json:baseline.mode` / `baseline.ref`
3. Visibility-derived default: `'public'` → `ref-based`;
   `'private'` / `'internal'` / `'unknown'` → `committed-full`.
   `committed-sanitized` is never auto-picked — it's the explicit
   opt-in for compliance-conscious private repos.

#### Mode-resolution enforcement

Two rules in `scripts/check-architecture.sh` (pre-commit + CI):

1. No `gh repo view --json visibility` calls outside
   `src/baseline/visibility.ts`. Annotate
   `// visibility-probe-ok` for justified exceptions.
2. No `git worktree add` / `git worktree remove` outside
   `src/baseline/ref-baseline.ts`. Annotate `// ref-worktree-ok`
   for justified exceptions.

### 12. Repo-explore graph access flows through two canonical entry points

Everything that reads the code graph at `.dxkit/reports/graph.json`
(the explore CLI subcommands, the dashboard graph adapter, the
per-finding enrichment adapter, the context CLI + PreToolUse hook, and
future graph consumers like reachability) goes through exactly two
modules:

- **Load** via `src/explore/load.ts:loadGraph(cwd)` (or its fail-open
  sibling `tryLoadGraph`) — the only place that may `JSON.parse` the
  artifact. It validates the wire format, handles schema-version
  migration, and builds the convenience indices.
- **Query** via `src/explore/queries.ts` — every graph traversal
  (callers/callees, file summaries, communities, the budget-bounded
  `contextQuery`, the per-finding `findingContextQuery`) is a pure
  function here. Consumers import these; they never re-walk
  `edgesFromNode` / `edgesToNode` themselves.

Higher-level adapters compose the two: `src/explore/finding-context.ts`
loads once and maps findings to `findingContextQuery` results;
analyzers receive the pre-built context and never touch the graph
(graph reliability per language comes from `LanguageSupport.callGraphReliability`,
not a hardcoded table — Rule 6).

**Bad**: `loadGraph()` in `src/cli.ts` or an analyzer; `JSON.parse(...graph.json)`
anywhere but `load.ts`; iterating `graph.edgesToNode` inside a CLI
subcommand; a second Levenshtein/BFS helper outside `queries.ts`.

**Good**: a CLI subcommand calls `buildFindingContextMap(cwd, ...)` or a
`queries.ts` function; the dashboard adapter imports `loadGraph` +
query helpers.

#### Graph-access enforcement

Four rules in `scripts/check-architecture.sh` (pre-commit + CI):

1. `loadGraph(` only in `src/explore/`, `src/dashboard/`,
   `src/explore-cli.ts`.
2. No direct `JSON.parse` of `graph.json` outside
   `src/explore/load.ts`.
3. No graph-traversal primitives (predecessor/successor edge walks)
   outside `src/explore/queries.ts`.
4. No re-implementation of canonical query helpers outside
   `src/explore/queries.ts` — extend it and import.

### 13. External-engine findings flow through the canonical ingest module

dxkit's bundled SAST (community semgrep) is intraprocedural. The
interprocedural taint class — path traversal, information exposure,
SSRF, injection — is covered by external engines (Snyk Code, CodeQL,
Semgrep Pro, or any SARIF-emitting tool). dxkit does not re-detect that
class; it **ingests** those findings and makes them first-class. Every
ingested finding MUST enter through `src/ingest/` so it inherits the one
fingerprint scheme, cross-tool dedup, baseline, guardrail, report
rendering, and graph linking that native findings get — never a parallel
pipeline.

- **Parse** SARIF only via `src/ingest/sarif.ts:parseSarif`. It is the
  single SARIF reader; every engine (CodeQL / Snyk export / Semgrep Pro
  / Bearer) funnels through it.
- **Persist** ingested findings only via
  `src/ingest/snapshot.ts` (`.dxkit/external/<engine>.json`). The
  committed snapshot is why an engine token is needed only at ingest
  time (one CI refresh job), not by every developer.
- **Normalize** to `SecurityFinding` only via
  `src/ingest/normalize.ts:externalToSecurityFindings`. Identity is NOT
  computed here — the security aggregator owns fingerprinting + dedup
  for every code finding (Rule 9), so ingested + native findings share
  one identity contract.
- **Select** the engine via
  `src/ingest/engine-resolver.ts:resolveDeepSastEngine` — the
  license-aware resolver (mirror of Rule 11). It never runs CodeQL on a
  non-public repo without `requiresConsent`.
- **Declare** per-language engine support via
  `LanguageSupport.deepSast` (Rule 6); consumers read the union through
  `activeDeepSast` / `codeqlLanguagesFromFlags` /
  `anyActivePackSupportsSnykCode` — never a per-language branch.

#### Ingestion enforcement

Two rules in `scripts/check-architecture.sh` (pre-commit + CI), plus
Rule 9's `createHash` ban covering ingested identity:

1. No `physicalLocation` SARIF walk outside `src/ingest/sarif.ts`
   (the smoking-gun shape of a hand-rolled SARIF parser). Annotate
   `// ingest-sarif-ok` for a justified exception.
2. No `.dxkit/external/` snapshot access outside
   `src/ingest/snapshot.ts`. Annotate `// ingest-snapshot-ok` for a
   justified exception.

### 14. Self-invoking artifacts flow through the canonical CLI helper + registry

Several artifacts dxkit installs shell out to the dxkit CLI _after_
install: the loop Stop hook, the `.claude` PreToolUse `context-hook`,
the git pre-push guardrail hook, and the CI guardrail workflow. Each
only works if `vyuh-dxkit` resolves in the user's environment (a
project-local devDependency or a global install); otherwise
`npx vyuh-dxkit …` 404s — `vyuh-dxkit` is a binary name, not a package.

Two facts MUST derive from the one module `src/self-invocation.ts`,
never from scattered literals or a hand-maintained flag chain:

- **Invoke** the CLI via `dxkitCli('<subcommand>')` / `DXKIT_CLI` — the
  single canonical invocation string. Every hook body, CI step, doctor
  hint, and help example builds from it.
- **Register** every artifact that auto-executes the CLI in
  `SELF_INVOCATION_SURFACES`, declaring `installedWhen(flags)`. The
  install + update devDependency wire-up reads `requiresResolvableCli`
  (derived from the registry) instead of `wantHooks || wantCi`, and
  `loop doctor` verifies the CLI actually resolves via `resolveDxkitCli`.

Adding a surface is a one-line registry entry; it cannot silently
forget the devDependency wire-up or the doctor check — the class of bug
that shipped the loop Stop hook 404-ing on pure-npx installs (it was
absent from both `||` chains).

**Bad**: `command: 'npx vyuh-dxkit hook stop-gate'`,
`fix.command: 'npx vyuh-dxkit baseline create'`, a new hook added to
`.claude/settings.json` without a `SELF_INVOCATION_SURFACES` entry,
`if (wantHooks || wantCi || wantClaudeLoop)` for the devDependency.

**Good**: `command: dxkitCli('hook stop-gate')`,
`requiresResolvableCli({ claudeLoop, gitHooks, ciGuardrails, claudeSettings })`,
a registry entry whose `installedWhen` gates the new surface.

#### Self-invocation enforcement

- **`scripts/check-architecture.sh` Rule 14**: no raw `npx vyuh-dxkit`
  string in `src/**/*.ts` outside `src/self-invocation.ts`. Annotate
  `// self-invocation-ok` for a justified exception.
- **`test/self-invocation-playbook.test.ts`**: contract (every surface
  well-formed; every gating flag flips `requiresResolvableCli`) plus a
  synthetic-surface injection test — if `requiresResolvableCli` ever
  iterates a hardcoded subset instead of its registry argument, the
  injected surface won't be picked up and the test fails. Mirror of
  `recipe-playbook.test.ts` / `producer-playbook.test.ts`.

### 15. The correctness floor (liveness gate) is pack-declared, runner-executed

The guardrail proves "no net-new FINDINGS" (secrets / CVEs / SAST /
coverage / flow) but NOT "the code is VALID and RUNS". The correctness
floor closes that gap: a **liveness** gate ("does this change still
compile, and do the tests it affects still pass?") that runs before an
autonomous loop may declare "done". A failing floor is a pass/fail
SIGNAL, not a fingerprinted, grandfathered finding — there is no
"grandfather a syntax error", so it sits OUTSIDE baseline/allowlist
(contrast Rules 9–10).

Every language-specific fact is pack-declared; the cross-cutting code
never hardcodes a per-language command (mirror of Rule 6):

- **Declared** per-pack in `src/languages/<id>.ts:correctness`
  (optional `CorrectnessProvider`) as TWO pure command builders —
  `syntaxCheck` (the cheap "does it compile/parse" check every language
  can give) and `affectedTests` (run the tests the change reaches;
  native impact-selection where the ecosystem supports it, else a
  coarser fallback with CI's `full` scope as the backstop). Each returns
  a `{ label, bin, args }` command or null. A pack NEVER shells out
  itself.
- **Dispatched** via `activeCorrectnessProviders(packs)` in
  `src/languages/index.ts`.
- **Executed** via the ONE canonical runner
  `src/analyzers/correctness/run.ts:runCorrectnessFloor`, which owns the
  load-bearing policy in one place: fail-CLOSED on a real failure
  (non-zero exit blocks), fail-OPEN on infrastructure (missing binary /
  timeout → skipped, never a block — a slow or un-installed toolchain is
  not broken code; CI is the backstop). Command execution is injected
  for tests.
- **Diff-scoped, without a baseline artifact.** The loop Stop-gate
  captures an ENTRY SNAPSHOT of the already-broken set on the pristine
  tree at activation (`src/loop/floor-state.ts`, `vyuh-dxkit loop
snapshot`), then blocks only on failures NET-NEW vs that snapshot — a
  pre-existing failure never blocks. This is testmon's insight (persist
  last-known state) scoped to one loop, so a Stop never pays a git
  worktree + install. Surfaces: loop Stop-gate (entry snapshot,
  affected), pre-push (merge-base, affected), CI (full).

**Bad**: a `tsc --noEmit` / `pytest` command string hardcoded in an
analyzer; calling a pack's `syntaxCheck`/`affectedTests` builder outside
the runner; a `src/analyzers/**/correctness.ts` that re-implements the
fail-open/timeout policy; grandfathering a compile error into the
baseline.

**Good**: `for (const { provider } of activeCorrectnessProviders(...))`
inside `run.ts`; a pack that returns `{ label, bin, args }` and lets the
runner execute it; the Stop-gate calling `runCorrectnessFloor` +
`netNewFloorFailures`.

#### Correctness-floor enforcement

1. **`scripts/check-architecture.sh` Rule (correctness floor)**: a
   pack's `.syntaxCheck(` / `.affectedTests(` builder is only invoked
   inside `src/analyzers/correctness/`. Annotate
   `// correctness-runner-ok` for justified exceptions (rare).
2. **`test/languages-contract.test.ts`**: a pack declaring
   `correctness` MUST supply both builders, each returning a well-formed
   `{ label, bin, args }` or null.
3. **`test/recipe-playbook.test.ts`**: the synthetic pack declares a
   `correctness` provider; the playbook asserts
   `activeCorrectnessProviders` + `runCorrectnessFloor` pick it up —
   catches "the runner stopped iterating the registry", the same way it
   guards `depVulns` / `architecturalShape` / fingerprinting.

`correctness` is now REQUIRED. It shipped optional (TS/JS + Python
first) and tightened once all eight built-in packs declared it — the
same optional-then-required arc `depVulns.manifestPatterns` followed.
The field is non-optional on `LanguageSupport`, so a new pack that
omits it **fails to compile** (not just at test time); the contract
test additionally asserts both builders are present and well-formed.
The `npm run new-lang` scaffold wires a DORMANT provider (both builders
return null) so a fresh pack compiles, with TODOs prompting the author
to fill in real commands before ship. The two JVM packs (Java, Kotlin)
share one `src/languages/jvm-build.ts` provider (Maven/Gradle, module-
level affected) per Rule 2 — a worked example of a shared multi-build-
system floor.

### 16. Every user-facing capability is registered for discovery

As the product broadens, feature discoverability becomes a first-class
concern: a capability nobody can find is a capability that does not exist.
Every top-level CLI command MUST declare a `CapabilityDescriptor` in
`src/discovery/commands.ts:COMMANDS` — the single source of truth for "what
capabilities exist and how a user (and an agent) discovers them." That one
registry drives every discovery surface:

- the grouped `vyuh-dxkit` help index (`renderCommandIndex`, and the
  unknown-command hint via `suggestCommand`);
- `doctor` advisor mode — a command's optional `whenToRecommend(ctx)` probe
  lets `doctor` proactively recommend an unused capability grounded in the
  repo (e.g. detect ad-hoc repo checks that aren't gated → recommend the
  gate runner);
- the agent-queryable capability catalog `vyuh-dxkit capabilities [--json]`
  (`src/discovery/capabilities-cli.ts`) — the machine-readable menu a coding
  agent reads to discover what dxkit can do here and configure it
  conversationally, each entry tagged with the `skill` that drives it;
- the agent-facing `skill` mapping;
- generated docs.

`audience` gates the requirement: `user` commands carry full discovery
metadata (`group`, `summary`, `docsBlurb`, and a real `skill` when one
exists); `internal` commands (hook bodies, loop-snapshot plumbing) are still
**registered** — nothing is invisible — but exempt from the user-facing
fields. `internal` is a **declared** status, not an omission, so an
accidentally-hidden user command cannot slip through as merely "unregistered".

Because the registry is the ground truth, a capability cannot be added
without declaring how it is discovered — discoverability is part of a
feature's definition of done, not a docs afterthought. New user-facing
features (the gate runner, `receipt`, allowlist-aware reports) ship WITH
their descriptor + skill.

**Bad**: a new top-level `case '<cmd>':` in `src/cli.ts` with no
`COMMANDS` entry; a hand-maintained command list in `printUsage` that
drifts from the switch; a descriptor naming a `skill` that was never written.

**Good**: one `CapabilityDescriptor` per command; the help index +
unknown-command hint + docs derived from the registry; `doctor` reads the
`whenToRecommend` probes.

#### Discovery-registration enforcement (the block-if-unregistered gate)

Mirror of Rule 15's managed-write gate, three escalating layers:

1. **Compile-time**: `CommandId` is the union derived from `COMMANDS`;
   code that switches over it exhaustively is checked by `tsc`. (Full
   compile-time dispatch enforcement lands when the `cli.ts` switch becomes
   table-driven off the registry — a future refactor; the contract is
   unchanged by it.)
2. **`scripts/check-architecture.sh` Rule 16**: bidirectional parity —
   every top-level `case '<id>':` in `src/cli.ts` has a registry id/alias,
   and every registry token dispatches. Runs pre-commit + CI. A new command
   that skips registration (or a stale registry entry) fails the gate.
3. **`test/discovery-playbook.test.ts`**: user-facing field completeness,
   every referenced `skill` file exists, ids/aliases are unique, and a
   **synthetic-command injection** proving the parity check still bites —
   the same empirical guard as `managed-artifacts-playbook.test.ts` /
   `recipe-playbook.test.ts`.

The above gate COMMAND discoverability. But a command can be registered while an
opt-in CONFIG KNOB it gates is discovery-invisible — `configure` never plans it
(no `planConfig`) and `doctor` / `capabilities` never surface it (no
`whenToRecommend`) — so an agent onboarding a repo via `capabilities --json`
never enables the gate and `configure --apply` silently under-initializes the
repo. That class shipped the seam gate's `duplication.mode` invisible until it
was caught by hand. The **config-knob layer** closes it: every posture / opt-in
knob is named in `src/discovery/posture-knobs.ts:POSTURE_KNOBS`, declaring per
knob which probes its owning command MUST carry (`requiresPlan` /
`requiresRecommend`), and `checkPostureKnobCoverage` turns that into a mechanical
assertion pinned by `test/discovery-posture-playbook.test.ts` (synthetic-
injection-guarded, mirror of the command playbook). A knob that deliberately
carries no probe is a **declared exemption with a reason** (`exemptionReason` —
same discipline as the `internal` audience and Rule 10's `DEFERRED_KINDS`), never
a silent omission. Guardrail-TUNING fields (`confidence`, `blockRules`,
`largeFileThreshold`) are not posture knobs — they refine an adopted gate, they
are not a capability a repo opts into, so they carry no discovery contract.

### 17. Custom checks are one seam — user checks and lint share it

A **custom check** is any repo command dxkit runs as a first-class gate
citizen: a user-declared invariant (`.dxkit/policy.json:checks` — a project
rule, an architecture script, a license audit) OR a pack-declared built-in
lint gate. There is ONE `custom-check` `IdentityKind`, and BOTH sources mint
findings into it, so a custom-check failure inherits the entire native-finding
machine (Rule 9 fingerprint → Rule 10 baseline producer → git-aware matcher →
brownfield classify → allowlist → guardrail verdict). Lint is therefore the
first **consumer** of this seam, never a parallel pipeline (this is Rule 2 —
one concept, one code path — applied to the gate runner).

The seam has one spine; every consumer routes through it:

- **Resolve** specs via the ONE entry point `resolveCustomCheckSpecs` /
  `gatherCustomCheckFindings` in `src/analyzers/custom-checks/gather.ts`. It
  merges user checks (normalized by `config.ts:normalizeCustomChecks`) with
  pack lint (`config.ts:lintGateSpecs`, driven by
  `LanguageSupport.lintGate` — Rule 6). The baseline producer (create time) and
  the guardrail (current scan) both call this, so they see the identical set
  from the identical path; `vyuh-dxkit checks list` renders exactly it.
- **Execute** via the ONE runner `runCustomChecks` in
  `src/analyzers/custom-checks/run.ts`, which shares the correctness floor's
  bounded-exec primitive (`src/analyzers/tools/bounded-exec.ts`) and owns the
  load-bearing policy: fail-OPEN on infrastructure (missing binary / timeout →
  skipped, never a block), a real non-`expectedExit` exit → findings. In regex
  mode it parses output REGARDLESS of exit code (many linters exit 0 while
  emitting diagnostics — dotnet analyzers, eslint warnings), so "clean" means
  zero matches, not exit 0.
- **Two finding shapes.** LOCATED (regex parse; identity =
  `check + file + lineWindow + rule`) is what lets a net-new lint error block
  while the repo's pre-existing lint backlog is grandfathered — always prefer
  it for linter-shaped checks. BINARY (`exit` parse; identity = the check name)
  is for a genuine whole-command pass/fail and grandfathers the whole check, so
  reserve it for commands expected to pass.
- **Gates in committed mode only.** `custom-check` is in
  `REF_UNRELIABLE_KINDS` (`src/baseline/check.ts`): a throwaway worktree at a
  git ref lacks the toolchain, so a linter would fail-open-skip on the "before"
  side and false-flag every finding as net-new. Committed/baseline mode
  captures the floor from a provisioned tree, so the diff is honest.
- **Opt-in, default-off.** `policy.json:checks[]` (user) and
  `policy.json:lint{enabled,blocking}` (pack lint) — a repo that configures
  nothing spawns nothing.

**SECURITY (load-bearing):** the runner EXECUTES commands. They come ONLY from
the repo's own committed `.dxkit/policy.json` or a pack's built-in lint command
— the same trust boundary as the repo's npm scripts / CI config. dxkit NEVER
runs a check from a CLI flag or any other untrusted source. Review a PR that
edits `checks[].command` with the scrutiny of a PR that edits a CI workflow.

**Bad**: a second `execFileSync` of a check command outside the runner; a
lint code path that fingerprints/baselines separately from user checks; a
binary lint gate (grandfathers the whole linter, so net-new errors slip
through); gating custom checks in ref-based mode; running a check command from
anything but the committed policy / a pack lint provider.

**Good**: `gatherCustomCheckFindings(...)` from `gather.ts` for every consumer;
`lintGate` declared on the pack and merged by `lintGateSpecs`; a located
(regex) lint gate; `custom-check` left in `REF_UNRELIABLE_KINDS`.

#### Custom-check enforcement

1. **`scripts/check-architecture.sh` (custom-check gate)**: `runCustomChecks(`
   is callable only from `src/analyzers/custom-checks/` and the `checks` CLI
   dry-run (`src/checks-cli.ts`); every other consumer goes through
   `gatherCustomCheckFindings`. Annotate `// custom-check-runner-ok` for a
   justified exception (rare).
2. **`test/recipe-playbook.test.ts`**: the synthetic pack declares a `lintGate`;
   the playbook asserts `lintGateSpecs` picks it up — catches "lint stopped
   being pack-driven", the same way it guards `depVulns` / `correctness` /
   fingerprinting.
3. **`test/baseline/finding-identity.test.ts`** (Rule 9 layer): the
   `custom-check` discriminant has both a located and a binary fixture row.
   **`test/checks-cli.test.ts`**: `checks list` / `checks run` resolve through
   the one entry point; the `recommendChecks` doctor probe fires on a lint
   signal and goes silent once policy opts in.

### 18. The frozen extension surface lives in `packages/dxkit-sdk`

`@vyuhlabs/dxkit-sdk` is the extension SDK: the descriptor language
(`HttpFlowSupport`, `FileRouteSupport`, `ModelSchemaSupport`), grammar-shape
access types (`GrammarShape`, `GrammarModelShape`, `ResolvedCall`), the
extension wire schemas (`contract.v1` / `inventory.v1` / `findings.v1` /
`export.v1` + `ExtensionManifest`), the ONE URL/method normalizer
(`normalizePath`, `normalizeMethod`, `bindingKey`, catch-all helpers), and
the AST access shapes (`ParsedFile`, `walk`). The main package DEPENDS on
the SDK and re-exports (`src/languages/types.ts`, `src/ast/grammar-shape.ts`,
`src/ast/grammar-model-shape.ts`, `src/analyzers/flow/normalize.ts`,
`src/ast/parse.ts` are the bridges) — so dxkit and every extension share one
definition of every frozen shape, and the freeze is structural, not
documentation.

Rules, both directions:

- **The SDK is self-contained.** Nothing under `packages/dxkit-sdk/src`
  imports main-package internals or node builtins (`web-tree-sitter` types
  and same-package relative imports only). If the surface needs a concept,
  MOVE it into the SDK and re-export from main — never leak internals in.
- **One definition per frozen name.** A frozen type or helper re-declared in
  `src/` (instead of imported + re-exported) forks the concept; the arch
  gate catches the declaration shape and the freeze test catches the
  reference identity.
- **Additive-only within an SDK major.** Removing/renaming a frozen export
  is an SDK major bump. Growing the surface = updating the freeze test's
  export list + a changelog entry, deliberately.
- **Deliberate non-exports stay out**: `DepVulnsProvider` freezes IN PLACE
  (a pack contract entangled with the internal `LanguageId` union — pinned
  structurally by the freeze test; extensions contribute dep findings via
  `findings.v1`); finding identity/fingerprints are computed only by dxkit
  (Rule 9), never by an extension; the pack-id union and registries stay
  internal.
- **Release ordering**: the main package's SDK dependency must resolve on
  npm before a main release that raises its floor. The ordering is
  STRUCTURAL, not remembered: bumping `packages/dxkit-sdk/package.json` in a
  reviewed PR is the publish intent — when the bump reaches main with green
  CI, `publish-dxkit-sdk.yml` auto-creates the `dxkit-sdk@vX.Y.Z` tag +
  Release and publishes (already-on-npm → silent no-op; the manual Release
  path remains for recovery). `publish.yml` refuses to publish dxkit while
  the SDK range doesn't resolve, and the release-prep arch gate blocks a
  main bump when SDK content changed without an SDK bump. CI smokes the
  tarball PAIR so PRs never depend on unpublished registry state.

#### SDK-boundary enforcement

1. **`scripts/check-architecture.sh` Rule 18**: (a) no import in
   `packages/dxkit-sdk/src` beyond `web-tree-sitter` + same-package
   relatives; (b) no line-start re-declaration of a frozen name in `src/`.
   Annotate `// rule18-sdk-ok` for justified exceptions (rare).
2. **`test/sdk-surface-freeze.test.ts`**: exact runtime export-name
   snapshot, reference-identity of main's re-exports (one code path),
   compile-time structural pins for every frozen type including the
   in-place `DepVulnsProvider` fields, wire-schema id registry pinned
   append-only, and `SDK_MAJOR` ↔ package version agreement.

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
     (working docs, memory pointers, future checkpoints)?" → if yes,
     rebase to preserve them.

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

<!-- dxkit:loop:start -->

## Autonomous loop safety (dxkit dogfoods its own loop Stop-gate)

This repo runs its own loop Stop-gate. The Claude Code Stop hook in
`.claude/settings.json` invokes `node dist/index.js hook stop-gate` — the local
build, mirroring how `dxkit-self-guardrail.yml` invokes `node dist/index.js`
(this repo IS `@vyuhlabs/dxkit`, so `npx vyuh-dxkit` cannot resolve it). When
active, it re-runs the guardrail (ref-based vs `origin/main`) on Stop and blocks
completion if the change introduced net-new findings, handing them back for repair.

- The gate is **loop-scoped** (2.13.3): it is an instant no-op on interactive
  turns. It auto-activates when the Stop payload's `permission_mode` is
  `bypassPermissions` (a headless `claude --dangerously-skip-permissions` run),
  or when `DXKIT_LOOP_ACTIVE=1` / a `.dxkit/loop/active` sentinel is set. So an
  ordinary interactive agent session here is NOT gated; run an unattended
  self-improvement loop (or set `DXKIT_LOOP_ACTIVE=1`) to exercise it.
  Interactive work is covered by review + the CI self-guardrail
  (`dxkit-self-guardrail.yml`), which always runs.
- Build first (`npm run build`) so `dist/` exists, or the hook cannot run.
- Posture is `loop.preset` in `.dxkit/policy.json` (`security-only`): net-new
  secrets + crit/high security + reachable dep-vulns block; test-gap + quality
  warn only.
- Fix the net-new finding the gate reports. Do NOT refresh the baseline to clear
  a block, and do NOT fix unrelated pre-existing debt.
- `node dist/index.js loop doctor` verifies the wiring.

<!-- dxkit:loop:end -->
