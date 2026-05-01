# Changelog

All notable changes to `@vyuhlabs/dxkit` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Ruby language pack** (Phase 10k.2 — recipe stress test #2). 8th
  language, fully dynamic outside the JVM family. Detection is
  source-presence-driven (G9 — requires `.rb` files within depth 5,
  not bare `Gemfile`). Capabilities land incrementally in subsequent
  10k.2.x commits (imports + testFramework, coverage via SimpleCov,
  lint via RuboCop, depVulns via bundler-audit + osv-scanner
  Gemfile.lock). Cross-ecosystem matrix wired with the standard 4
  benchmark fixtures (Secrets/BadLint/Duplications/UntestedModule —
  G4-scaffolded with Ruby-specific syntax).

### Recipe v3 (final installment)

- **G4** — scaffolder writes templated benchmark fixtures with
  per-language syntax tokens (PascalCase vs snake_case filenames,
  comment markers, AKIA constant placement). Saves ~30 min per new
  pack. Languages without a profile fall back to TODO stubs.
- **G6** — scaffolder appends `[Unreleased]` CHANGELOG stub on
  `npm run new-lang`. Idempotent. Forces release-notes thinking at
  scaffold time, not ship-tag day.
- **G1** — class-wide gate parser robustness audit. Auto-derived
  language lists in `check-architecture.sh` (LP-A1/A2/A3 patterns no
  longer drift as new packs land). Self-test pattern documented:
  every gate parsing TS declarations exits 1 with explicit failure
  when its parser produces an empty list. Surfaced its own bug —
  the scaffolder's `LANGUAGES` registry update produced a double
  comma under Prettier multi-line shape; fixed in the same series.

## [2.4.5] - 2026-04-29

### Fixed (high-severity, discovered during 2.4.5 pre-ship regression)

- **`osv-scanner fix` was THREE bugs in one** (5-month-old bug shipped
  since 2.4.0 / Phase 10h.6). osv-scanner v2's `fix` subcommand invokes
  `npm install` internally to compute upgrade patches. dxkit was
  invoking it in the user's project cwd, which caused all three of the
  following:

  1. **Data mutation** — `npm install` wipes / reinstalls the cwd's
     `node_modules` (often with `--legacy-peer-deps` fallback when
     peer-deps don't resolve cleanly). Visible to users running
     back-to-back commands: `dxkit vulnerabilities` followed by `npm
     test` or any other step depending on stable `node_modules` would
     fail cryptically. Discovered when dxkit-on-dxkit crashed mid-run
     with `Cannot find module 'hosted-git-info'`.

  2. **Process orphan leak** — osv-scanner's `npm install` grandchildren
     outlived dxkit's 120s `execSync` budget. `execSync(..., {timeout})`
     SIGTERMs only the immediate child; npm install + its node-package
     subprocesses orphaned to PID 1 and kept eating CPU/memory until
     they finished or the shell exited. Each `dxkit vulnerabilities`
     invocation could leak 1-3 orphans; in CI this polluted subsequent
     steps.

  3. **Silent BoM under-reporting** — when osv-scanner's npm install
     left a partially-broken `node_modules` (peer-dep mismatches that
     `--legacy-peer-deps` couldn't fully resolve), dxkit's BoM
     aggregator subsequently couldn't enumerate the affected
     dependencies. Root-project deps got silently dropped from the
     BoM. On dxkit-on-dxkit comparison, 2.4.4 reported only 7 BoM
     entries (sub-fixture deps) vs 2.4.5's 24 (sub-fixtures + dxkit's
     own 17 root deps including `hosted-git-info`, `eslint`,
     `typescript`, etc.). `unfilteredTotalPackages` 22 → 353. The
     analyzed project's own deps were missing from BoM whenever the
     bug hit. Most repos that resolve peer-deps cleanly under
     `--legacy-peer-deps` weren't affected (vyuhlabs-platform's BoM
     stayed correct at 145 packages); repos with subtle peer-dep
     issues silently lost root-dep enumeration.

  **Fix** (split across 10k.1.5b and 10k.1.5c):

  - **Temp-dir isolation (10k.1.5b)**: stage `package.json` +
    `package-lock.json` in a fresh temp dir before invoking osv-scanner,
    discard the temp dir after parsing JSON output. Project's tree is
    now read-only treatment (the contract dxkit's analyzers always
    claimed). Stops bug #1 (mutation) and #3 (BoM under-reporting,
    since `node_modules` no longer gets clobbered).

  - **Process-group SIGKILL on timeout (10k.1.5c)**: new
    `runDetached(cmd, args, opts)` helper in `src/analyzers/tools/runner.ts`
    spawns the child in its own process group via
    `spawn({ detached: true })` and `process.kill(-pid, 'SIGKILL')` on
    timeout — kills grandchildren atomically. Stops bug #2 (orphan
    leak). Reusable for any future tool that may fork grandchildren
    (PMD's JVM, mvn, gradle).

  Regression tests added: `test/osv-scanner-fix.test.ts` for the
  isolation contract; `test/runner.test.ts` for the process-group
  group-kill semantics (sleep-30-grandchild + 200ms timeout asserts
  elapsed < 2s — would block 30s if process-group regressed). Caught
  by the discipline the user pushed for: "never ship broken;
  understand the root cause and fix properly". The discipline was
  validated end-to-end — the same scan that found bug #1 also
  surfaced #2 and #3 once we knew where to look.

  **Forensic evidence preserved** at
  `tmp/regression/2.4.4/dxkit/bom.json` (gitignored — 2.4.4 baseline
  with under-reported BoM) vs `tmp/regression/2.4.5-fixed/dxkit/bom.json`
  (full enumeration after the fix).



Phase 10k.1 — Java language pack (recipe stress test #1, JVM-cousin
shape). 7th language pack lands the cross-ecosystem matrix at
**8 active language packs** including Java with full capability
coverage. Recipe v3 makes substantial progress (G2 + G5 + G9
delivered; G1 partial; G4/G6/G7 deferred). D008 + D011 + a vitest
hookTimeout flake closed in pre-flight commits.

No breaking changes for end users. New depVulns/lint/coverage/
imports/testFramework data on Java/Maven projects; existing analyzer
commands produce identical output for non-Java projects.

### Added

- **Java language pack** (Phase 10k.1) with five capability providers:
  - **depVulns** via `osv-scanner` against `pom.xml` /
    `gradle.lockfile` / `gradle/verification-metadata.xml`.
    Implementation lives in the new shared
    `src/analyzers/tools/osv-scanner-maven.ts` module that both
    kotlin and java packs delegate to (CLAUDE.md rule #2 SSOT).
  - **lint** via PMD 7.x with `rulesets/java/quickstart.xml`.
    `parsePmdOutput` tiers PMD's 1-5 priority into dxkit's
    critical/high/medium/low scheme via `mapPmdRuleSeverity`.
    Real-fixture-driven parser tests against captured PMD 7.24.0
    output at `test/fixtures/raw/java/pmd-output.json`.
  - **coverage** via JaCoCo XML — reuses the kotlin pack's parser
    unchanged (the parser was source-language-agnostic from day 1
    and is now hosted in `src/analyzers/tools/jacoco.ts`). Path
    candidates extended for Maven (`target/site/jacoco/jacoco.xml`,
    `target/site/jacoco-aggregate/jacoco.xml`) alongside the existing
    Gradle paths.
  - **imports** via regex extraction over `import [static]
    <fqn>(.<Class>|.*)?;` after stripping line + block comments.
    Best-effort resolution (matches kotlin/rust pack semantics —
    Java package paths don't 1:1 map to filesystem paths in all
    build layouts).
  - **testFramework** via build-file substring scan of pom.xml +
    build.gradle{,.kts} for canonical artifact names. Order honors
    mixed-state migration: junit-jupiter > spock > testng > junit4.
- **PMD (`pmd`) in TOOL_DEFS**. PMD 7.x as the canonical Java linter,
  with brew on macOS / GitHub releases zip on Linux / scoop on
  Windows. CI install step added.
- **Java cross-ecosystem benchmark fixture**
  (`test/fixtures/benchmarks/java/`) — five files (Secrets.java with
  fake AWS key, BadLint.java with PMD violations, Duplications.java
  with jscpd clone pair, UntestedModule.java for filename-match
  test-gap, pom.xml with `commons-collections:3.2.1` for the original
  "Mad Gadget" CVE-2015-7501 deserialization advisory + log4j-core
  for Log4Shell). Matrix wins on all four dimensions (secret/dup/
  test-gaps run unconditionally; lint matrix activates with
  `requires: 'pmd'`).
- **`scripts/check-docs-coverage.sh` (Recipe v3 / G5).** Pre-commit +
  CI gate that asserts every `LanguageId` in `src/languages/index.ts`
  appears in canonical doc anchors (CLAUDE.md path glob; README.md
  ecosystem coverage table row count + ID substring mention). Closes
  the kotlin-PR-#23 follow-up class of failure where a pack ships in
  main but docs go stale because nobody remembered to update them.
- **`vyuh-dxkit tools install <name>` and `--all` (D011).** Single-tool
  install for cross-stack development (e.g. installing `spotbugs` /
  `pmd` on a Node-only repo); `--all` enumerates every TOOL_DEFS
  entry. Unknown names fail loudly with an "Unknown tool" message +
  pointer to `tools list`. Used during this phase's PMD harvest.
- **CLAUDE.md merge-strategy guidance**. Codifies when PRs should
  squash-merge (single logical unit) vs rebase-merge (multiple
  independently-meaningful commits with prose-quality messages —
  what this PR did to preserve D008/D011/G2/G5/G9 + 5 capability
  commits as discrete history).

### Refactored (architectural improvement)

- **`src/analyzers/tools/jacoco.ts`** — extracted from kotlin pack
  in 10k.1.2. Owns `parseJaCoCoXml`, `findJaCoCoReport`,
  `gatherJaCoCoCoverageResult`. Both JVM packs delegate. Parser was
  always source-language-agnostic; just relocating to the right home.
- **`src/analyzers/tools/osv-scanner-maven.ts`** — extracted from
  kotlin pack in 10k.1.4. Same pattern. Owns
  `parseOsvScannerMavenFindings` + `gatherOsvScannerMavenDepVulnsResult`.
  Both JVM packs delegate. Parser was already ecosystem-filtered to
  Maven (not Kotlin-coupled); just relocating.
- **Capabilities contract is genuinely optional (Recipe v3 / G2).**
  `capabilities-contract.test.ts:117` previously asserted
  `providers.length === LANGUAGES.length` for the depVulns capability,
  forcing packs without depVulns to register null-stub providers.
  Now: `expect(providers.length).toBe(LANGUAGES.filter((l) =>
  l.capabilities?.depVulns).length)` — precise contract, packs can
  omit. Unblocks Swift's eventual graceful-degradation pattern.
  Java's null-stub from intermediate commits retired.
- **`detectJava` is source-presence-driven, not manifest-driven
  (Recipe v3 / G9).** Initial detection activated on bare `pom.xml`,
  which broke kotlin's matrix lint test because kotlin's fixture has
  pom.xml (for osv-scanner Maven). Both packs activated → lintTool
  came back as `'detekt, pmd'`. Fix: require either `src/main/java/`
  directory OR actual `.java` source within depth 5. Mixed Kotlin +
  Java projects still activate both packs (correct). G9 noted as a
  scaffolder-template fix candidate — the scaffolded `detect()` stub
  currently suggests "manifest signals" which is the bug we just hit.

### Fixed

- **D008 — stale test-fixture types + missing contract test.** 21 type
  errors surfaced when `tsc --noEmit` runs against `src + test`
  together (`DimensionScore.details` / `DuplicationStats.totalLines`
  field drift; `DepVulnFinding.source` → renamed to `.tool`;
  `mapLintSeverity` contract was narrower than every impl reality;
  spread-duplication cleanups). Adds `tsconfig.test.json` +
  `npm run typecheck:test` + wires into `.husky/pre-push` and
  `.github/workflows/ci.yml`. The contract test paid for itself in the
  same session — caught a `Record<LanguageId, boolean>` literal
  regression introduced 30 minutes earlier.
- **`scripts/check-cross-ecosystem-coverage.sh` Prettier robustness
  (Recipe v3 / G1, partial).** Auto-derive parser assumed single-line
  `LANGUAGES = [...]`. Prettier reformatted to multi-line at the 7th
  entry (line-length budget) and the gate parsed 0 entries silently.
  Switched to awk block extract — robust to both shapes. One
  instance fixed; class-wide audit of similar parsers deferred.
- **Vitest `hookTimeout` default of 10s caused C# `beforeAll` flakes.**
  `dotnet restore` against a cold NuGet cache routinely takes 18-44s
  on WSL2. Now matches `testTimeout` at 180s.

### Phase 10k roadmap

After 10k.1 (Java) ships in 2.4.5, **10k.2 (Ruby) ships in 2.4.6** as
recipe stress test #2 — fully dynamic language outside the JVM family.
Then **2.5.0 (Phase 10i — fingerprints + exec summary across 8-language
matrix)**. Phase 10j.2 (Swift/iOS) is **deferred to post-10rr / pre-3.0.0
opportunistic slot** because Linux/WSL2 development can't validate the
xcodeproj-shape majority without macOS access. See
`tmp/phase-10k-backend-langs-roadmap.md` for the full phase plan.

## [2.4.4] - 2026-04-27

Phase 10j.1 — first mobile language pack (Kotlin/Android), Recipe v2
scaffolder enhancements driven by lessons from adding it, and a fix
for D010 (inactive-pack provider invocation) which surfaced as a
test-suite performance regression.

No breaking changes for end users. New depVulns/lint/coverage data on
Kotlin/Maven projects; existing analyzer commands produce identical
output for non-Kotlin projects.

### Added

- **Kotlin (Android) language pack.** Full LP-recipe implementation with
  five capability providers:
  - **depVulns** via `osv-scanner` against `pom.xml` /
    `gradle.lockfile` (Maven ecosystem filtered out of polyglot scans
    so npm/PyPI findings stay attributed to their own packs).
  - **lint** via detekt's Checkstyle XML report — severity tiering
    derived from detekt's source-of-truth `CheckstyleOutputReportSpec`
    (error → high, warning → medium, info → low).
  - **coverage** via JaCoCo XML at the standard Gradle/Android paths
    (`app/build/reports/jacoco/...`, `build/reports/jacoco/test/...`).
  - **imports** via regex extraction (no resolver — Kotlin packages
    don't 1:1 map to file paths; mirrors the rust pack's choice).
  - **testFramework** via gradle build-deps text scan (Kotest > Spek >
    JUnit precedence).

  Standard cross-ecosystem benchmark fixture under
  `test/fixtures/benchmarks/kotlin/` with `gson:2.8.5` (alias
  CVE-2022-25647) + `log4j-core:2.14.0` known-vulnerable pinned
  deps. Matrix row + `cross-ecosystem benchmarks — Kotlin` describe
  block. detekt registry entry (`TOOL_DEFS`) ships brew + Linux-zip
  install commands. (`src/languages/kotlin.ts`,
  `test/languages-kotlin.test.ts`,
  `test/fixtures/{benchmarks,raw}/kotlin/`,
  `src/analyzers/tools/tool-registry.ts`)

- **CI: Java 17 (Temurin) + detekt installed on the Linux runner.**
  Kotlin matrix lint row now runs end-to-end in CI alongside Python /
  Go / Rust / C# rows. Java 17 toolchain is opt-in for contributors
  (`it.skipIf(!commandExists('java'))` gates the matrix lint test
  locally). (`.github/workflows/ci.yml`,
  `CONTRIBUTING.md` — toolchain table extended with three rows:
  `osv-scanner`, `java`, `detekt`)

- **Recipe v2 — scaffolder enhancements driven by Kotlin's pain.**
  `npm run new-lang <id> "<displayName>"` now also generates:
  - parser-test stubs in `test/languages-<id>.test.ts` with the
    fixture-loading helper, the C# defect provenance docstring, and
    commented-out test patterns for `parse<Tool>{Lint,Coverage,DepVulns}Output`,
    `map<Lang>Severity`, `extract<Lang>ImportsRaw`.
  - `test/fixtures/raw/<id>/HARVEST.md` template documenting the
    capture commands for real tool-output bytes (the parser-vs-real-output
    discipline that closes the C# defect class).
  - Richer `test/fixtures/benchmarks/<id>/README.md` with the standard
    5-file convention (manifest / BadLint / Duplications / Secrets /
    UntestedModule) and a TODO checklist.
  - Updated next-steps checklist surfaces the harvest step before
    parser implementation. (`scripts/scaffold-language.js`)

- **LP-A4 architecture rule.** Pre-commit + CI grep that catches
  hardcoded multi-language extension globs of the
  `'**/*.{ts,tsx,js,jsx,py,go,rs,cs}'` shape — the JSCPD_PATTERN bug
  that silently dropped the kotlin matrix duplication test until
  caught by the cross-ecosystem fixture run. Future regressions land
  with a clear error pointing at `LANGUAGES.flatMap(l => l.sourceExtensions)`
  as the right derivation. (`scripts/check-architecture.sh`)

### Fixed

- **D010 — inactive-pack provider invocation.** `providersFor()` now
  filters by `lang.detect(cwd)` when given a cwd (per-pack capabilities
  only; globals stay unconditional). Module-level memoization caches
  the active-pack list per cwd so 9 capability dispatches incur one
  detect-walk per pack instead of nine. Threaded through 16 analyzer
  callsites. **Intentionally NOT filtered**: the BoM's reachability
  pass in `gatherDepVulns` calls `providersFor(IMPORTS)` without a
  cwd, because the BoM aggregates findings across multiple project
  roots and reachability needs to walk every pack's source files
  regardless of outer-cwd activation. Filtering there silently
  dropped cross-language reachability and zeroed the "This Week's
  Triage" risk scoring — caught during the regression-check pass
  on dxkit's own BoM diff. Cross-ecosystem.test.ts: 444s peak →
  174s wall-clock after Recipe v2 (-228s, 51% reduction). Closes
  D010 (`tmp/known-defects.md`). (`src/languages/capabilities/index.ts`,
  `src/analyzers/{health,licenses,quality,security,tests}/...`)

- **`JSCPD_PATTERN` was hardcoded** with `'ts,tsx,js,jsx,py,go,rs,cs'`
  baked in at module load — adding a new pack required this exact
  cross-cutting edit and the kotlin matrix duplication test silently
  dropped for two commits because we forgot to add `kt`. The pattern
  now derives from `LANGUAGES.flatMap(l => l.sourceExtensions)` on
  every call. LP-A4 (above) catches future re-introductions.
  (`src/analyzers/tools/jscpd.ts`)

- **`detekt-cli` zip ships the binary as `bin/detekt-cli`, not
  `bin/detekt`** — the original `TOOL_DEFS.detekt` install command
  symlinked the wrong path and `chmod +x` errored out. Caught by the
  `vyuh-dxkit tools install` flow during real-tool harvest. Both
  binary names now declared in `binaries[]` and both symlinks created
  on Linux install. (`src/analyzers/tools/tool-registry.ts`)

### Changed

- **`DetectedStack.versions` migrated to
  `Partial<Record<LanguageId | 'node', string>>`** from the legacy
  fixed shape `{ python?, go?, node?, rust?, csharp? }`. Adding a new
  language pack no longer requires editing this field — the type
  auto-grows with `LanguageId`. The `'node'` carve-out preserves the
  legacy `NODE_VERSION` template-variable compat without forcing a
  breaking template rename (deferred to a future major).
  (`src/types.ts`)

- **`CoverageSource` union consolidated.** `src/analyzers/tests/types.ts`
  now extends `src/analyzers/tools/coverage.ts:CoverageSource` (with
  test-only `'filename-match'` / `'import-graph'` additions) instead
  of duplicating the artifact-source list. Adding a new coverage
  format means editing one place. Added `'jacoco'` for the kotlin
  pack. (`src/analyzers/tools/coverage.ts`,
  `src/analyzers/tests/types.ts`)

- **`scripts/check-cross-ecosystem-coverage.sh` auto-derives expected
  language count.** Reads `LANGUAGES.length` from
  `src/languages/index.ts` instead of a hardcoded constant. New packs
  no longer need to bump `EXPECTED_LANGUAGES` by hand.
  (`scripts/check-cross-ecosystem-coverage.sh`)

### Internal

- Tests: 849 → 895 (+46 from kotlin parser tests, cross-ecosystem
  matrix kotlin row, and indirect coverage of new pack-iterating
  consumers). Wall-clock: 122s → 174s — net +52s for kotlin's
  legitimate test work, after D010 fix recovered ~228s of
  inactive-pack overhead.

- Recipe-playbook test's synthetic id renamed from `'kotlin'` to
  `'playbook'` (a non-LanguageId placeholder that won't collide with
  any future real pack). The collision was the LP architecture's
  predicted "first real pack stress-test" — fix took five lines.

- `import-graph.test.ts` setup now writes a minimal `package.json` so
  the typescript pack's `detect()` activates — reflects post-D010
  production semantics where inactive packs' gathers don't run.

## [2.4.3] - 2026-04-26

Phase 10i.0-LP — language-pack architectural refactor. Two user-visible
fixes (graphify + dotnet auto-discovery), one developer-experience win
(test suite from 30 min flaky to 2 min deterministic), and an
architectural cleanup that makes adding a new language pack a one-command
scaffold (`npm run new-lang <id> "<displayName>"`) instead of a
13-file scavenger hunt. Closes audit items #1–#7 and #9–#14 (12 items)
plus **D009** and a doctor-check gap that had no D-id.

No breaking changes for end users. Internal architecture only — every
analyzer command (`health`, `vulnerabilities`, `bom`, etc.) produces
identical output before and after.

### Fixed

- **`graphify` "failed to run" in `health` and `quality` reports.** The
  graphifyy@0.5.0 release renamed the result-dict key of `god_nodes()`
  from `"edges"` to `"degree"` (same NetworkX node-degree semantic). The
  Python script in `buildGraphifyScript` raised `KeyError: 'edges'`,
  suppressed by the runner's `2>/dev/null`, surfacing only as
  `Unavailable: graphify (failed to run)` in every health/quality
  report — degrading complexity/cohesion/maintainability scoring
  silently. One-line key rename. (`src/analyzers/tools/graphify.ts`)

- **`~/.dotnet` missing from `getSystemPaths()` auto-discovery.**
  Microsoft's recommended non-sudo path is
  `dotnet-install.sh --install-dir $HOME/.dotnet`. Without this entry
  in the system-paths probe list, contributors and customers had to
  manually export `PATH=$HOME/.dotnet:$PATH` before dxkit detected
  dotnet. Added alongside the existing `~/.cargo/bin`, `~/go/bin`
  entries. (`src/analyzers/tools/tool-registry.ts`)

- **`vyuh-dxkit doctor` was silently skipping all C# toolchain checks.**
  The pre-LP toolchain-check section in `doctor.ts` had explicit
  branches for python/go/node/rust but **no `if (manifest.config.languages.csharp)` clause** — so .NET
  projects ran `doctor` and saw a clean bill of health regardless of
  whether dotnet was installed. Pack-driven iteration (LP.1) auto-fixes
  this: csharp pack now declares `cliBinaries: ['dotnet']` and doctor
  surfaces missing dotnet on .NET projects. No D-id (discovered + fixed
  in the same commit). (`src/doctor.ts`)

- **`cross-ecosystem.test.ts` was unusable on resource-constrained
  developer machines** — 30 min wall-clock with 15 spurious failures
  per run, blocking the progressive-regression workflow. Three root
  causes:

  1. Vitest 3.x's `pool: 'threads'` birpc channel between worker and
     main starves under heavy concurrent subprocess fan-out (this suite
     spawns ~22 network-bound child processes); workers can't ack
     `onTaskUpdate` within 60s and vitest emits `Timeout calling
     onTaskUpdate`, **failing completed-and-passing tests as a side
     effect** (vitest #8164). 13 of the 15 prior "failures" were this
     spurious RPC bug, not real assertion failures. Switched to
     `pool: 'forks'` — each test file in its own child Node process,
     no shared birpc channel.
  2. `testTimeout: 60000` was tight on cold-cache machines; both real
     non-spurious failures were `pip-audit` and `cargo-audit`
     exceeding 60s on first run. Bumped to 180s.
  3. The 22 subprocess invocations were redundant — multiple `it()`
     blocks across the file invoked the same `node dxkit <report>
     <fixture>` command. Added a per-(command, fixture) Promise-cache
     so each fixture's vulnerability/quality/test-gaps report runs
     once and is shared by all assertions; concurrent racing tests
     receive the same in-flight promise. Cuts subprocess count ~50%.

  Combined effect: full suite runs from **30 min with 15 spurious
  failures** to **2:30 with zero**. (`vitest.config.ts`,
  `test/integration/cross-ecosystem.test.ts`)

### Added

- **`npm run new-lang <id> "<displayName>"`** — language-pack
  scaffolder. Generates the 7 recipe files (pack stub, test stub,
  fixture skeleton, Claude rule file, template-config dir) and
  updates `src/types.ts` (extends `LanguageId` union) plus
  `src/languages/index.ts` (registers in `LANGUAGES`). Generated code
  is type-safe by construction — no casts. Prints a next-steps
  checklist for the work scaffolding can't automate (detect logic,
  capability providers, fixture content, CI toolchain install,
  CONTRIBUTING.md row). (`scripts/scaffold-language.js`,
  `package.json`)

- **`scripts/check-architecture.sh`** — three new pre-commit + CI
  rules enforcing pack-coupling discipline:
  - LP-A1: no hardcoded `IF_<LANG>` references outside the
    constants→generator pipeline
  - LP-A2: no direct `config.languages.<id>` lookups outside the
    registry-bridge files
  - LP-A3: no hardcoded `<lang>.md` rule-file strings outside packs
- **`test/languages-contract.test.ts`** — five new per-pack tests:
  metadata completeness (`permissions`, `cliBinaries`,
  `defaultVersion`, `projectYamlBlock`) plus the **D009 reverse-direction
  contract test** (every declared tool either invoked via TOOL_DEFS, by
  shell-command literal, by `node_modules/.bin/<binary>` path, or on
  the artifact-generating allowlist).
- **`test/recipe-playbook.test.ts`** — synthetic 6th-pack injection
  test. Defines a mock `kotlin` pack, mutates the `LANGUAGES` registry
  to include it, and asserts every pack-iterating consumer
  (generator, doctor, detect, project-yaml, constants, coverage,
  generic, grep-secrets, tool-registry) picks up its contributions.
  Empirical guarantee that the architecture is pack-driven.

- **5 new `LanguageSupport` capabilities** for pack metadata that
  consumers iterate (no per-language if-chains):
  `permissions: string[]`, `ruleFile?: string`,
  `templateFiles?: { template; output }[]`, `cliBinaries: string[]`,
  `defaultVersion: string`, `versionKey?: keyof DetectedStack['versions']`,
  `projectYamlBlock?: (ctx) => string`. Plus a coverage-parser capability
  via direct ownership: per-language parsers (Istanbul, coverage.py,
  Go cover-profile) moved out of `src/analyzers/tools/coverage.ts`
  into their respective pack modules.

### Changed

- **`DetectedStack.languages`** — refactored from a fixed-shape
  interface (`{ python, go, node, nextjs, rust, csharp }`) to
  `Record<LanguageId, boolean>`. The `nextjs` flag moves out of
  `languages` and is now exclusively the framework signal under the
  top-level `framework: 'nextjs'` field — preserved in the legacy
  `IF_NEXTJS` template variable for backwards compatibility.

  Adding a 6th language pack now extends the `LanguageId` union once
  and registers in `LANGUAGES`; **no fixed-shape interface to edit**.
  This is the missing piece that makes the LP "7-file recipe" actually
  7 files.

  Programmatic consumers of the `detect()` function should note that
  `stack.languages.node` and `stack.languages.nextjs` no longer exist;
  instead, `stack.languages.typescript` is `true` for both Node and
  Next.js projects (typescript pack matches any `package.json`), and
  `stack.framework === 'nextjs'` distinguishes Next.js. The published
  template variables `IF_NODE`, `IF_NEXTJS`, `NODE_VERSION` are
  unchanged.

- **`generator.ts`, `doctor.ts`, `detect.ts`, `coverage.ts`,
  `generic.ts`, `grep-secrets.ts`, `project-yaml.ts`, `constants.ts`,
  `tool-registry.ts`** — all per-language if-chains replaced with
  iteration over the `LANGUAGES` registry. 12 of the 14 LP-audit
  items closed across these files (the audit doc lives in `tmp/` if
  curious).

### Internal

- Phase 10i.0-LP closed audit items #1–#7, #9–#13 (the per-pack
  if-chain cluster + the medium-structural cluster).
- Phase 10f.4 closed audit item #14 (`DetectedStack.languages`
  interface refactor — the type-system surgery).
- D009 (declared-vs-used tool drift contract test) closed via the
  reverse-direction test in `languages-contract.test.ts`.

## [2.4.2] - 2026-04-25

Phase 10i.0 — cross-ecosystem matrix completion. Establishes the
"matrix layer" of `test/integration/cross-ecosystem.test.ts` — a
data-driven `BENCHMARK_LANGUAGES` table that drives uniform
per-language assertions for **every** report dimension. The 2.4.1
fixtures only validated `dxkit vulnerabilities`; this release adds
matrix coverage for **secrets, lint, duplications, and test-gaps**
across all 5 benchmark languages, plus a CI-enforced parity gate so
new feature dimensions can't ship without per-language coverage.

Closes **D016** — surfaced and fixed during 10i.0.2.

### Fixed

- **C# `dotnet-format` parser returned zero violations on every real
  .NET project** since the C# pack landed. The lint provider counted
  lines containing the substring `'Formatted'` to derive violation
  count; real `dotnet format --verify-no-changes` output uses
  `path/to/File.cs(line,col): error CODE: message [project]` — the
  string `'Formatted'` never appears. Same drift shape as 2.4.1's
  D005 C# vulnerabilities defect: parser written against synthetic
  output, never validated against real tool output. Fixed by
  matching the canonical `\): error \w+:` regex. Caught by adding
  the C# row to the new lint matrix; the row failed because the
  parser returned 0 despite exit code != 0 and visible violations
  in the output. (`src/languages/csharp.ts`, **D016**)

### Added

- **Cross-ecosystem matrix layer** (`test/integration/cross-ecosystem.test.ts`).
  New `BENCHMARK_LANGUAGES` table at the top of the file is the
  single source of truth for which languages participate and where
  each fixture's deliberate findings live. Each `describe('matrix —
  <report>')` block iterates the table to produce one uniform
  assertion per language — adding a new feature is one new
  optional field per row + one new `matrix —` describe; adding a
  6th language is one row append + one fixture dir + one CI install.
  No search-and-replace across describe blocks.

- **`matrix — secrets` (Phase 10i.0.1)** — 5 hardcoded fake AWS
  access keys (`AKIA1234567890ABCDEF` — patterned digits/letters
  that pass gitleaks' `aws-access-token` regex but fail real AWS
  validation and GitHub push protection). One per benchmark
  ecosystem. Asserts `dxkit vulnerabilities` surfaces a
  `SecretFinding` (category=secret, tool=gitleaks,
  rule=aws-access-token) for each.

- **`matrix — lint` (Phase 10i.0.2)** — 5 deliberate idiomatic
  linter violations (Python ruff F401 unused-import, Go gosimple
  S1002 bool-comparison, Rust clippy unused_variables, C#
  dotnet-format whitespace × 2). Asserts `dxkit quality` reports
  the expected linter and ≥1 lint finding. CI workflow now
  installs `ruff` (pipx), `golangci-lint` (curl install script),
  and `clippy` (rustup component) alongside the existing depVulns
  toolchains; `dotnet format` ships in the .NET 8 SDK.

- **`matrix — duplications` (Phase 10i.0.3)** — two near-identical
  helpers per fixture, sized comfortably above jscpd's
  `--min-lines 5 --min-tokens 50` defaults (initial pass had
  ~30-token bodies that fell below the threshold; widened on the
  way in). Asserts `metrics.duplication.cloneCount > 0`.

- **`matrix — test-gaps` (Phase 10i.0.4)** — one untested source
  module per fixture with no matching test file. Asserts
  `dxkit test-gaps` returns the file in `gaps[]` with
  `hasMatchingTest: false`. No coverage artifact committed —
  filename-match coverage source is the matrix's canonical
  fallback.

- **`scripts/check-cross-ecosystem-coverage.sh` parity gate**
  (Phase 10i.0.5) — parses the test file and verifies every
  (report × language) cell has BOTH metadata in
  `BENCHMARK_LANGUAGES` and a matching `matrix — <report>`
  describe. Exits non-zero with a specific cell-pointer error
  message if any are missing. Wired into both `.github/workflows/ci.yml`
  and `.husky/pre-commit` so contributors catch parity gaps locally
  before push. Documented as a 4-step recipe in the script header
  for adding a new matrix dimension.

- **`.dxkit-ignore`** at repo root excludes `test/fixtures/benchmarks/`
  from dxkit's own self-scan (`vyuh-dxkit vulnerabilities .` from
  this repo) so the deliberate fixture findings don't false-positive
  in dxkit's own report. Cross-ecosystem.test.ts is unaffected — it
  scans fixture dirs as cwd, where the repo-root `.dxkit-ignore`
  doesn't apply.

### Changed

- **Bumped `vitest` 2.1.4 → 3.2.4 and `@vitest/coverage-v8` 2.1.9 →
  3.2.4 together** (matched 3.2.4 pair, peer-deps clean). vitest 3
  introduces a hardcoded 60s `onTaskUpdate` ack timeout on the
  worker→main birpc channel (vitest-dev/vitest #8164) — a sync-
  blocked test thread (`execSync` shelling out for >60s) starves the
  channel and vitest exits non-zero with an unhandled error even when
  every test passes. Refactored `cross-ecosystem.test.ts` to use
  `util.promisify(exec)` for all shell-outs (pip-audit, govulncheck,
  dotnet restore, cargo-audit) so the runner stays responsive.

- **Default `vitest.config.ts` `testTimeout` 30s → 60s.** The
  cross-ecosystem suite shells out to network-dependent registries
  (npm/pypi/crates.io/nuget); 30s was tight enough to flake on
  slow-network days (pip-audit observed at 27-34s on the
  `requests@2.20.0` fixture). Unit tests are unaffected — they fail
  fast on assertion errors; only hangs care about the timeout.

- **`.gitignore`** adds `test/fixtures/benchmarks/**/target/` so
  cargo's build dir doesn't get committed when contributors run the
  Rust matrix locally.

- **CONTRIBUTING.md toolchain table** grows a "Matrix rows" column
  and `ruff` / `golangci-lint` / `gitleaks` rows, since each is now
  a matrix-dimension toolchain (not just a depVulns one).

## [2.4.1] - 2026-04-25

Phase 10h.6.8 — cross-ecosystem benchmark validation. Builds five
committed reference projects (`test/fixtures/benchmarks/{python,go,
rust,csharp,csharp-multi}/`) with deliberately pinned vulnerable deps
and runs `dxkit vulnerabilities` against each as a regression test.
Surfaced four real defects against the 2.4.0 non-TS code paths;
this release ships fixes for all four.

Closes **D005** (no Python/Go/Rust/C# benchmark projects), open since
Phase 10h.3.

### Fixed

- **C# pack returned zero findings on real `dotnet list package
  --vulnerable` output** since 10h.3.6. The parser read
  `pkg.advisories` + `adv.advisoryUrl`; real dotnet 8 SDK output uses
  `pkg.vulnerabilities` + `adv.advisoryurl` (lowercase). Unit tests
  passed because they used the (wrong) synthetic shape. Schema
  interfaces renamed to match real output (`DotnetAdvisory` →
  `DotnetVulnerability`); existing tests updated. **Customer impact**:
  any .NET project run through `vyuh-dxkit vulnerabilities`,
  `vyuh-dxkit bom`, or the dependencies dimension of `vyuh-dxkit
  health` was silently reporting zero dep-vulns. (`src/languages/csharp.ts`)

- **Python pack emitted duplicate findings for advisories that
  pip-audit lists per affected version range.** Same `(package,
  version, id)` triple was emitted multiple times with identical
  fingerprints. Fixed by source-side dedup in the gather function.
  Surfaced by `requests==2.20.0` in the benchmark fixture, where
  `PYSEC-2023-74` and others appeared twice. (`src/languages/python.ts`)

- **Python pack left `topLevelDep` empty on direct deps when no venv
  was installed.** A `requirements.txt`-only project had no `pip show`
  graph to walk, so even the package literally listed in
  requirements.txt got no attribution. Added `requirements.txt` parser
  fallback (`parseRequirementsTxtTopLevels`) that gives direct deps
  self-attribution (`pkg → [pkg]`) when no venv is available.
  Transitives still stay unset without a venv — that's accurate to the
  data we have. (`src/languages/python.ts`)

- **Rust pack emitted comma-separated semver ranges as
  `upgradePlan.parentVersion`** instead of a clean version. cargo-audit
  emits `versions.patched` entries like `">=1.8.4, <1.9.0"` for
  patched-version-line ranges. The previous regex stripped only the
  leading `>=`, leaving `"1.8.4, <1.9.0"` — unusable as a `cargo
  update --precise <X>` argument. New helper
  `extractMinPatchedVersion` extracts the explicit `>=` floor or falls
  back to the first semver-shaped token. Surfaced by `tokio@0.1.22`
  in the benchmark fixture. (`src/languages/rust.ts`)

### Added

- **Five committed benchmark fixtures** at `test/fixtures/benchmarks/`:
  `python/` (`requests==2.20.0`), `go/` (`gin-gonic/gin v1.6.0`),
  `rust/` (`tokio = "0.1.9"`), `csharp/` (`Newtonsoft.Json 9.0.1`),
  and `csharp-multi/` (a 2-project solution validating Phase 10h.6.7's
  D003 fix on real `dotnet restore` output rather than synthetic JSON).
  Each fixture has a `README.md` documenting expected scanner output
  and the specific defect it guards against.

- **`test/integration/cross-ecosystem.test.ts`** — runs
  `dxkit vulnerabilities` against every fixture; asserts the
  hotfix-validated behaviors (no duplicates, clean parentVersion,
  correct topLevelDep, real-shape parsing, sibling-project graph
  merge). Each ecosystem's tests `skipIf(!commandExists(...))`, so
  contributors without `cargo` / `dotnet` / `go` / `pip-audit` /
  `govulncheck` see them skip locally with a clear message; CI
  installs all four toolchains and runs the full matrix. ~150s
  end-to-end.

- **CI workflow** (`.github/workflows/ci.yml`) now installs Python +
  Go + Rust + .NET + their respective audit tools (`pip-audit`,
  `govulncheck`, `cargo-audit`) ahead of the test step. cargo-audit
  is cached across runs; the others are fast enough to install per
  job.

- **CONTRIBUTING.md — "Cross-ecosystem benchmarks" section** —
  documents toolchain requirements (none required for routine dxkit
  dev; each is needed only when modifying that language's pack),
  per-fixture regeneration steps, and the local-vs-CI run model.
  Also clarifies: prefer `npm ci` over `npm install` for development
  setup, and avoid `--legacy-peer-deps` (the lockfile resolves cleanly
  without it; the flag silently bumped vitest 2.x → 3.x in earlier
  re-orient instructions).

- **Unit tests** for the four parser helpers added/changed:
  - `parseRequirementsTxtTopLevels` (7 tests in
    `test/languages-python-depvulns.test.ts`)
  - `extractMinPatchedVersion` (5 tests in
    `test/languages-rust-depvulns.test.ts`)
  - new patched-range case for `parseCargoAuditOutput` (1 test)
  - existing C# test suite re-validated against the corrected
    `vulnerabilities` / `advisoryurl` schema

### Changed

- `.gitignore` adds `test/fixtures/benchmarks/**/obj/` and
  `test/fixtures/benchmarks/**/bin/` so .NET build artifacts don't
  get committed when contributors run `dotnet restore` locally
  for inspection.

### Notes

The benchmark suite establishes the pattern for cross-language
validation as future report types (bom, licenses, quality, test-gaps,
dev-report) are made agent-ready in Phase 10i. Per the roadmap,
Phase 10i.0 (target 2.4.2) extends these fixtures with non-dep-vuln
scenarios (one secret, one lint warning, one duplication, one
untested file per language) so each 10i.x sub-commit can assert its
feature across the full language matrix.

## [2.4.0] - 2026-04-24

Phase 10h.6 complete. Tier-2 fix tools + agent-handoff types +
cross-pack upgrade-plan resolver + C# multi-project attribution.
Closes defect D003. One user-facing theme: every `DepVulnFinding`
that has a viable remediation now carries a structured
`upgradePlan` that agents can consume directly — no more parsing
free-text `upgradeAdvice` to figure out what to upgrade.

### Added — agent handoff (Phase 10h.6 kickoff)

- **Advisory fingerprint** — `DepVulnFinding.fingerprint` is a stable
  16-char hash of `(package, installedVersion, id)`, stamped by the
  cross-pack aggregator after enrichment. Identity is input-only —
  re-scoring or enrichment changes do not mint a new fingerprint.
  `BomReport.summary.fingerprints` ships the sorted-deduplicated
  manifest so external tooling (suppressions, CI gates, upgrade bots)
  can diff two reports by plain set difference. New helper
  `src/analyzers/tools/fingerprint.ts`.

- **Structured upgradePlan** — `DepVulnFinding.upgradePlan` is a typed
  sibling to the existing free-text `upgradeAdvice`:
  `{ parent, parentVersion, patches[], breaking }`. Populated by the
  Tier-2 fix tools landing in 10h.6.1–.4 (`osv-scanner fix`,
  `pip-audit --fix`, `cargo audit fix`, the cross-pack transitive
  resolver). Free-text advice stays for markdown/xlsx readability;
  autonomous upgrade bots consume the structured form. New type
  `DepVulnUpgradePlan`.

### Added — Tier-2 fix tools (Phase 10h.6.1 + 10h.6.2)

- **TypeScript `osv-scanner fix` integration** (10h.6.1) — wraps
  `osv-scanner fix --format json --manifest package.json --lockfile
  package-lock.json` and stamps structured `upgradePlan` on each
  matching `DepVulnFinding` surfaced by `npm audit`. Per-patch rollup:
  if one top-level bump resolves N advisories, every finding's
  `upgradePlan.patches[]` lists all N. Breaking detection normalizes
  pre-1.x where a minor bump (0.5 → 0.6) is treated as breaking.
- **Rust `cargo-audit` upgradePlan population** (10h.6.3) — mirrors the
  Python pattern: cargo-audit's existing JSON output already carries
  per-advisory `versions.patched[]`, so we populate
  `DepVulnFinding.upgradePlan` as a pure transformation (parent equals
  the finding's own crate; Rust has no transitive-parent remediation
  concept at the advisory level). New `isMajorBump` helper shared with
  the TS/Python packs (identical implementation — flagged for
  consolidation in 10h.6.4's cross-pack resolver). 5 new tests.
- **Python `pip-audit` upgradePlan population** (10h.6.2) — pip-audit
  already returns `fix_versions[]` per advisory; we now map the first
  (minimal-resolving) entry into `DepVulnFinding.upgradePlan` alongside
  the existing `fixedVersion`. Python's flat dep graph means
  `upgradePlan.parent` equals the finding's own package — no transitive
  parent to upgrade, just bump the vulnerable package directly. No new
  subprocess call required; pure transformation of existing output.
- **New tool in `TOOL_DEFS`** — `osv-scanner` (Node/TS pack, Tier-2).
  Installs via `go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest`
  (macOS also tries `brew install osv-scanner` first). Soft-fails when
  the binary isn't available — existing `upgradeAdvice` (free-text,
  from npm-audit) stays as the fallback and no findings are dropped.
- **New helper** — `src/analyzers/tools/osv-scanner-fix.ts` exports
  `gatherOsvScannerFixPlans(cwd)`, `parseOsvScannerFixOutput(raw)`, and
  `enrichWithUpgradePlans(findings, plans)`. 19 new tests with a real
  osv-scanner sample as fixture.
- **New helper in Python pack** — `isMajorBump(from, to)` shared
  between depVulns gather and tests. Same pre-1.x-minor-is-breaking
  convention as the TypeScript pack. 5 new tests.

### Fixed — C# multi-project attribution (Phase 10h.6.7, closes D003)

- Multi-project .NET solutions (web app + tests + shared libs) now
  get correct top-level-dep attribution from every project's graph.
  Earlier revisions walked to the **first** `obj/project.assets.json`
  they found and built the attribution index from that one file —
  advisories reachable only through sibling projects' dep chains
  ended up without a `topLevelDep`. Fix: enumerate every
  `project.assets.json` under cwd, merge the edge maps + union
  top-level sets, run BFS against the merged graph. New exports in
  `src/languages/csharp.ts`: `findAllProjectAssetsJson` and
  `mergeAssetParses`. 5 new tests covering the merge semantics + the
  concrete D003 case (advisory reachable through sibling only).

### Added — cross-pack upgrade-plan resolver (Phase 10h.6.4)

- **Shared `isMajorBump` helper** — three identical copies
  (TS/Python/Rust from 10h.6.1–.3) consolidated into
  `src/analyzers/tools/semver-bump.ts`. All three packs import from
  the shared module; 7-test suite at `test/semver-bump.test.ts`
  supersedes the inline duplicates.
- **Cross-pack resolver** — new module
  `src/analyzers/tools/upgrade-plan-resolver.ts` exposing
  `resolveTransitiveUpgradePlans(findings)`. Runs after per-pack
  Tier-2 tools and before riskScore composition. Two passes:
    1. **Reconciliation** — for every advisory id listed in any
       existing plan's `patches[]`, stamp the same plan onto the
       matching finding (by id only, case-insensitive). Fills gaps
       where a Tier-2 tool's `fixed[]` mentions an id that's carried
       by another finding with a different (package, version) tuple.
    2. **Free-text parse** — derives a plan from the npm-audit
       transitive-fix template (`"Upgrade X to Y [major] (transitive
       fix)"`) when no structured plan exists. Single-advisory scope
       (patches=[finding.id]) since the free-text doesn't carry
       cross-advisory rollup. Producer-written plans are
       authoritative; resolver never overwrites.
- **Wire-up** — `gatherDepVulns` in `src/analyzers/security/gather.ts`
  now calls `resolveTransitiveUpgradePlans` after fingerprinting and
  tier-3 enrichment, before composite `riskScore`. 11 new tests at
  `test/upgrade-plan-resolver.test.ts`.

## [2.3.2] - 2026-04-24

PM-grade bom reports. The xlsx and markdown outputs both restructure
around decision-making (what to fix, who to call, what to plan) rather
than enumeration (here are all the packages, figure it out).

### Added — markdown report

- **🎯 Executive Summary** at the top: ship-blocker count, sprint-sized
  finding count (risk ≥ 40), license exposure (copyleft-strong + unknown
  counts), staleness (> 3y old packages), highest-leverage upgrade. One
  screen, written for a PM who needs "can we ship?" without scrolling.

- **Reconciliation prose** on "Top-Level Dep Groups" explaining why the
  numbers don't sum to the Summary totals — each CVE is counted once per
  top-level parent it reaches through, by design. "Advisories" column
  renamed to "Rolled-up Advisories" to reinforce the different semantics.

### Added — xlsx report (4-sheet workbook, replaces the single `platform` sheet)

1. **`Executive Summary`** — KV grid on one screen: totals, severity
   breakdown, top ship-blocker, highest-leverage upgrade, license-class
   counts (Permissive / Copyleft weak & strong / Proprietary / Unknown),
   staleness counts, tool provenance.

2. **`Triage`** — top 10 findings ranked by composite riskScore.
   Columns: Priority / Risk / Severity / KEV / Reachable /
   Package@Version / Advisory / CVSS / EPSS / Upgrade to / Effort /
   Rationale.

3. **`Inventory`** — the legacy 15-column customer format (unchanged
   byte-for-byte on cols 1–15) with **4 columns appended** (16–19):
   Risk / KEV / Reachable / EPSS, plus a bonus col 20 for CVSS (max).
   Sort by col 16 desc for the same triage ordering sheet 2 uses.

4. **`License Breakdown`** — pivot: license type × count × risk class ×
   sample packages. Copyleft-strong licenses surface at the top; unknown
   bucket flags licenses the classifier didn't recognise (legitimate
   human-review candidates like `CC-BY-4.0`).

### Added — shared pm-signals module

New `src/analyzers/bom/pm-signals.ts` with pure helpers the markdown
and xlsx renderers both use:

- `licenseClass(licenseType)` — SPDX-id → `permissive` | `copyleft-weak` |
  `copyleft-strong` | `proprietary` | `unknown`. Handles compound
  expressions (`MIT OR GPL-3.0` classifies as `copyleft-strong`, the
  stricter class), parenthesised forms (`(Apache-2.0 OR UPL-1.0)`),
  legacy `"MIT license"` / `"Apache 2.0 license"` suffixes, and known
  proprietary markers (`UNLICENSED`, `SEE LICENSE IN ...`).

- `stalenessTier(releaseDate)` — `fresh` (< 1y) / `aging` (1–3y) /
  `stale` (≥ 3y) / `unknown`. Injectable `now` for deterministic tests.

- `effortEstimate(entry)` — `trivial` (patch bump) / `moderate` (minor
  bump) / `major` (breaking) / `blocked` (no fix available). Derived
  from semver delta; multi-vuln entries escalate to the worst tier seen.

Derivations deliberately stay in the renderer layer rather than on
`DepVulnFinding` / `LicenseFinding` so the analyzer contract is
unchanged — consumers can re-derive trivially if needed.

### Changed (breaking-ish — see note)

- Xlsx sheet layout changed from single `"platform"` sheet to a 4-sheet
  workbook. **Consumers hardcoding sheet name `"platform"` will break.**
  The legacy 15-column layout is preserved byte-for-byte on the renamed
  `"Inventory"` sheet. Appended cols 16–19 are additive.

### Validation

- 715 tests passing (+18 pm-signals cases: license class mapping,
  compound expressions, staleness thresholds, effort semver deltas).
- Typecheck + lint + format + architecture + pre-push CI-mirror gate clean.
- vyuhlabs-platform smoke: all 4 sheets render correctly, exec summary
  surfaces 3 ship-blockers + 9 sprint-risk findings + pm2 flagged
  copyleft-strong, `@loopback/rest` surfaces as highest-leverage upgrade
  (27 transitive advisories, worst CRITICAL).

## [2.3.1] - 2026-04-24

Patch release fixing three install-robustness issues reported on a
real vyuhlabs-platform install:

### Fixed

- **`@vitest/coverage-v8` install crashed with `MODULE_NOT_FOUND`** on
  repos that don't use vitest (mocha / jest / ava / lb-mocha). The
  install command called `node -e "require('vitest/package.json')"`
  to auto-detect the vitest major — unconditionally, so any non-
  vitest project hit a hard crash during `tools install --yes`.
  Now prefixed with `test -f node_modules/vitest/package.json ||
  { echo 'vitest not present — skipping'; exit 0; }` so the install
  no-ops cleanly when vitest isn't a target-repo dep.

- **Semgrep / pip-audit / ruff / pip-licenses / coverage dep pins
  colliding in the shared venv**. Pre-2.3.1 installed every Python
  CLI tool into one venv at `~/.cache/dxkit/tools-venv/`. semgrep's
  `tomli~=2.0.1` pin lost to pip-audit's newer tomli, breaking
  semgrep on repos where both tools installed. Every Python CLI
  (semgrep, ruff, pip-audit, pip-licenses, coverage) now uses
  `pipx install <tool>`, putting each in its own isolated venv
  under `~/.local/pipx/venvs/<tool>/`. Binaries symlink into
  `~/.local/bin/` which is already in `getSystemPaths()`'s probe
  list, so `findTool()` picks them up without further changes.
  Bootstrap fragment auto-installs pipx via `pip --user` when
  absent (handles PEP-668 Debian/Ubuntu with
  `--break-system-packages` fallback).

- **Graphify stays on the shared venv** — it's a Python *library*
  that our graphify.ts subprocess imports, not a CLI tool, so pipx
  doesn't apply. `TOOLS_VENV` narrows to graphify-only.

- **"Install command exited 0 without producing the binary" now
  reports as skipped, not failed**. Any install command can
  legitimately no-op (guarded installs like vitest-coverage);
  those no-ops shouldn't clutter the failure summary. Real
  failures (non-zero exit) still classify as `failed`.

### Known limitations (not blocking)

- `npm install @vyuhlabs/dxkit` still emits deprecation warnings for
  `inflight@1`, `glob@7`, `fstream`, `rimraf@2`, `lodash.isequal` —
  all transitive under `exceljs` (via `archiver` → `archiver-utils`).
  exceljs@4.4.0 is the latest available; the chain is upstream.
  Warnings only, no functional impact; would require either switching
  xlsx libraries (breaking) or upstream archiver modernization.

### Validation on vyuhlabs-platform/userserver

- `vyuh-dxkit tools` reports 12/13 tools found (vitest-coverage
  correctly listed as missing since lb-mocha is in use)
- `vyuh-dxkit tools install --yes` reports `0 installed, 1 skipped,
  0 failed` (clean)
- `vyuh-dxkit bom --xlsx --filter=top-level` completes in 17s,
  writes `.dxkit/reports/bom-YYYY-MM-DD.{md,xlsx}` cleanly

## [2.3.0] - 2026-04-24

Minor release — turns the `bom` report from enumeration (1700+ rows
of noise) into a **decision doc** (top 10 triage queue ranked by
composite exploit-risk). Every `DepVulnFinding` now carries five
exploitability signals — CVSS, EPSS, CISA KEV, reachability,
composite `riskScore` — that consumers can read individually or as
the ranked `Risk` column. `licenses` + `vulnerabilities` renders
gain parity with the new bom surface so any dxkit command shows the
same triage-relevant data.

Nine sub-commits (Phase 10h.5) landed behind PRs #4 / #5 / #6 /
#7 / #8 / #9 / #10 / #11 through the hardened 2.2.1 pipeline —
the first full release cut where every commit flowed PR → CI-green →
merge → tag → CI-publishes without deviation.

### Added — exploitability enrichers

- **EPSS** (`DepVulnFinding.epssScore`, 0.0–1.0) from FIRST.org's
  `api.first.org/data/v1/epss`. Batched (≤100 CVEs/call), session-
  cached, graceful offline fallback. Non-CVE primaries (GHSA /
  RUSTSEC / GO / PYSEC) resolve via OSV.dev alias lookup — no
  coverage gap across packs. (10h.5.1)

- **CISA KEV** (`DepVulnFinding.kev`, boolean) from the official
  catalog at `cisa.gov/.../known_exploited_vulnerabilities.json`.
  Single bulk fetch per process, O(1) lookup. Badge `⚠` in every
  render. (10h.5.2)

- **Reachability** (`DepVulnFinding.reachable`, tri-state) — does
  this repo's source actually import the vulnerable package?
  Built from per-pack `ImportsResult`'s specifier extraction;
  `specifierToPackage` handles TS scoped/bare, Python dotted
  modules, Go 3-segment module paths. Coarse name-level
  matching; undefined when no imports data available. (10h.5.3)

- **Composite riskScore** (`DepVulnFinding.riskScore`, 0–100) —
  `clamp(cvss*10 × kev? × (1+2*epss) × reach?, 0, 100)`. Formula
  documented in `src/analyzers/tools/risk-score.ts`. Null when
  CVSS missing (no fabrication from side signals). (10h.5.4)

- **"This Week's Triage"** section at the top of every bom report —
  top 10 advisories with riskScore ≥ 15, rationale composed from
  most decisive signals (KEV → reachable → CVSS → EPSS), fix
  column with "PROPOSAL:" prefix stripped. (10h.5.5)

### Added — decision-doc UX

- **`bom --filter=top-level`** drops transitive rows (1700+ → ~150
  on typical repos) while the `byTopLevelDep` rollup still reflects
  full blast radius — "upgrading `@loopback/cli` resolves 29
  advisories" survives when those 29 transitive rows are hidden.
  `BomEntry.isTopLevel` + `summary.filter` + `summary.unfilteredTotalPackages`
  ride the shape. (10h.5.0)

- **Nested-project aggregation** (default ON; `--no-nested` opts
  out). `src/analyzers/bom/discovery.ts` walks the repo,
  discovers every directory with a language manifest
  (package.json, pyproject.toml/requirements.txt/setup.py/Pipfile,
  go.mod, Cargo.toml, *.csproj/*.sln), runs per-root gather, and
  merges with dedup on `(package, version)`. `BomEntry.sources`
  unions the roots each package was found in; `isTopLevel`
  OR-merges; vulns dedup on `(id, package, installedVersion)`.
  Closes **D001a** — `bom platform/` previously missed
  `platform/userserver/` entirely. Side-benefit: naturally
  addresses **D003** (C# multi-project) since each `.csproj`
  becomes its own root. (10h.5.0b)

- **`LicenseFinding.releaseDate`** populated from the npm registry
  for every TS-ecosystem package. Closes **D006** — xlsx col 10
  ("Component Release Date") was previously empty. Bundled with
  the EPSS fetcher roundtrip. (10h.5.1)

- **`licenses` render** sorts top-level deps (⭐) first, transitive
  below. Adds `Direct` + `Released` columns. Matches bom's
  `--filter=top-level` ordering so cross-referencing the two
  reports Just Works. (10h.5.6)

- **`vulnerabilities` render (main, not --detailed)** per-advisory
  table now sorted by `riskScore` desc with `Risk` / `KEV` /
  `Reach` / `EPSS` columns alongside the existing fields. (10h.5.6)

### Fixed

- **D013** — graphify's shared Python venv moved from
  `/tmp/graphify-venv` (subject to systemd-tmpfiles sweep + race
  on first install) to `~/.cache/dxkit/tools-venv` (XDG persistent).
  Also fixed `Date.now()` script-tempfile collision class in
  graphify.ts via `fs.mkdtempSync`. Affects every Python-based
  tool dxkit installs (graphify, semgrep, ruff, pip-audit,
  pip-licenses, coverage). Legacy `/tmp/graphify-venv` path still
  probed, so existing installations aren't forced into a
  reinstall. (10f.2)

- **OSV.dev GHSA case-sensitivity** — `api.osv.dev/v1/vulns/<GHSA>`
  expects lowercase; npm-audit emits uppercase. `osv.ts`
  `DEFAULT_FETCHER` normalizes the alphabetic portion. Silently
  broke alias resolution for every TS finding pre-2.3.0.

### Changed — output directory

- **Reports moved from `.ai/reports/` to `.dxkit/reports/`**.
  Separates tool output (regenerated each run, can be gitignored)
  from AI-agent context (`.ai/sessions/`, `.ai/prompts/` —
  human-authored, version-controlled). All CLI commands + every
  scaffolded slash command / agent / template updated to the new
  path. Existing `.ai/reports/*.md` files become orphans after
  upgrade — acceptable since reports regenerate each run.

### Process

- First full release cut through the 2.2.1-hardened publish
  pipeline: 8 PRs, every one PR→CI→admin-squash-merge→main. Each
  dog-fooded the pre-push CI-mirror hooks landed in PR #3.

## [2.2.1] - 2026-04-23

Patch release hardening the publish pipeline after `v2.2.0`'s Publish
workflow failed with `403 — version already published`. The failure
was caused by a local `npm publish` that preceded the
Release-triggered CI publish, not a code defect — the tarball on npm
byte-matches main. No functional changes in this release; all work
is on the release path (tracked internally as D015).

### Added — publish pipeline guardrails

- **`scripts/require-ci.js` + `prepublishOnly` guard** — any `npm publish`
  invocation outside GitHub Actions now fails at the script hook with
  a clear error pointing to `CLAUDE.md §"Release procedure"`. Prevents
  accidental local publish before the registry is ever contacted.

- **`publishConfig.provenance: true`** — npm publishes now carry a
  GitHub Actions provenance attestation. Provenance requires an OIDC
  token that only exists inside Actions; tarball-mode publishes
  (`npm publish *.tgz`, which skips `prepublishOnly`) also fail outside
  CI. Belt-and-suspenders with the script guard.

- **Publish-workflow preflights** (`.github/workflows/publish.yml`) —
  before `npm publish` runs, the workflow now verifies (in order):
  1. tag `vX.Y.Z` matches `package.json` version `X.Y.Z`
  2. tagged commit is reachable from `origin/main` (blocks
     feature-branch tags)
  3. the `CI` workflow succeeded on the tagged commit SHA
  4. `X.Y.Z` is not already on npm (catches the exact 2.2.0 failure)

- **Explicit pack + publish + verify** — workflow packs the tarball,
  records its sha1, publishes that exact file, then fetches
  `npm view dist.shasum` and fails on mismatch. Eliminates drift
  between "what npm packed" and "what we audited."

- **Tarball workflow artifact** — every release archives the published
  `.tgz` as a workflow artifact (90-day retention) for post-mortem
  auditability.

### Documented — `CLAUDE.md`

New "Release procedure" section codifying PR → CI-green → merge → tag
→ CI publishes as the only path. Explicit "no local `npm publish`"
rule.

## [2.2.0] - 2026-04-23

Minor release adding Snyk-style top-level dep attribution across every
language pack. Answers "which direct manifest dep do I upgrade to fix
the most advisories" alongside the existing per-leaf-package reporting.
Drop-in upgrade — additive `topLevelDep?: string[]` field, no schema
bump required.

### Added — top-level dep attribution (Phase 10h.4)

- **`DepVulnFinding.topLevelDep?: string[]`** — per-advisory list of
  root manifest entries (direct + dev deps) that transitively pull the
  vulnerable package. Coarse name-level attribution (unions across
  multiple parents when the package is reachable from more than one
  top-level). Enables Snyk-style grouping: one advisory against
  `tar@7.5.9` surfaces as "under `@loopback/cli`" rather than just
  "tar has a CVE".

- **TypeScript pack** — BFS over `package-lock.json` (v2/v3) from
  each root `dependencies` / `devDependencies` entry. Pure parser
  `buildTsTopLevelDepIndex` unit-tested; benchmark on
  `vyuhlabs-platform`: 71/71 findings attributed across 31 vulnerable
  packages, `@loopback/cli` rollup = 29 advisories (matches Snyk UI).

- **Python pack** — BFS over `pip show` graph from packages with empty
  `Required-by`. Pure parsers `parsePipShowOutput` +
  `buildPyTopLevelDepIndex`. Venv detection now includes poetry
  (`poetry env info --path`), pipenv (`pipenv --venv`), and
  `$VIRTUAL_ENV` env var alongside the existing `.venv`/`venv` fast
  path — poetry with default `virtualenvs.in-project = false` now
  resolves.

- **Go pack** — BFS over `go mod graph` output, with `go.mod`'s
  `// indirect` markers filtering the seed set so only user-declared
  direct deps become top-levels. Pure parsers `parseGoModDirectDeps` +
  `buildGoTopLevelDepIndex`.

- **Rust pack** — BFS over `cargo metadata --format-version 1` resolve
  graph from each direct dep of `resolve.root`. Pure parser
  `buildRustTopLevelDepIndex`; maps package ids → names, collapses
  version variants.

- **C# pack** — **two-part expansion**. First,
  `dotnet list package --vulnerable` now uses `--include-transitive`,
  so transitive vulns (previously invisible) are surfaced. Second,
  attribution comes from walking `obj/project.assets.json` — pure
  parsers `parseProjectAssetsJson` + `buildCsharpTopLevelDepIndex`.
  Direct findings carry self-attribution; transitive findings gain
  `topLevelDep` from the assets-json graph. Degrades gracefully when
  the lockfile is absent (user hasn't run `dotnet restore`).

### Added — bom render surfaces top-level grouping

- **`BomReport.summary.byTopLevelDep: Record<string, BomTopLevelRollup>`**
  where `BomTopLevelRollup = { advisoryCount, maxSeverity, packages[] }`.
  Multi-parent advisories increment counters for each top-level they
  list, matching Snyk's rollup semantics.

- **Markdown "Top-Level Dep Groups" section** in `bom-<date>.md` —
  sorted by severity then advisory count. First row is the single
  upgrade that resolves the most critical/highest-volume issues. Caps
  at 30 top-levels, packages list truncated at 8 with "+N more".

- **Xlsx col 12 annotation** — each advisory line gains
  ` via <parent>` (single top-level) or ` via <parent> (+N more)`
  (multi-parent). Reviewer sees upgrade guidance directly in the
  spreadsheet cell. No suffix when `topLevelDep` is unset.

### Fixed — TS dep-vuln finding dedupe

- `gatherTsDepVulnsResult` now de-duplicates findings by
  `(package, installedVersion, id)`. npm-audit inlines the same
  advisory on every consumer's `via[]` across the vulnerability tree
  (e.g. minimatch's ReDoS appearing on `@loopback/cli`, `glob-parent`,
  `picomatch` simultaneously); the advisory-emission loop previously
  pushed N copies of one logical finding. Platform count 94 → 71,
  14 distinct dupe pairs → 0. Pre-existing from 2.1.0; caught during
  10h.4 evaluation.

### Notes

- Every pack degrades gracefully when its dep-graph source is missing:
  TS without `package-lock.json`, Python without a venv, Go without
  `go.mod`, Rust without `cargo metadata`, C# without
  `obj/project.assets.json`. Findings still emit; `topLevelDep` stays
  unset.

- Release validated against `vyuhlabs-platform` TypeScript benchmark.
  Python/Go/Rust/C# packs exercised via fixture-based unit tests
  (+53 new tests across the 4 non-TS language test files); real-world
  validation lands with 2.3.0's cross-ecosystem benchmark fixtures.

## [2.1.0] - 2026-04-23

Minor release adding two new analyzers and a shared XLSX converter.
Schema-compatible with 2.0.x for all pre-existing reports; introduces
two new report kinds (`licenses`, `bom`) and a schema v11 → v12 bump on
the detailed security report. Drop-in upgrade — no existing consumer
breaks.

### Added — license inventory

- **`vyuh-dxkit licenses [path]`** — per-pack dependency license
  inventory across TypeScript (license-checker-rseidelsohn), Python
  (pip-licenses), Go (go-licenses), Rust (cargo-license), and C#
  (nuget-license). Populates 11 fields per package (name, version,
  description, license type, license text, source URL, supplier,
  release date, etc.). Writes `.ai/reports/licenses-<date>.md`; with
  `--detailed` also a risk-categorized JSON + markdown flagging
  strong-copyleft, weak-copyleft, unknown-license, missing-attribution
  packages. TypeScript provider normalizes source URLs through
  `hosted-git-info` so `git+`/SCP/RFC-SSH variants collapse to canonical
  HTTPS.
- **`vyuh-dxkit bom [path]`** — Bill of Materials joining `licenses`
  with dependency vulnerabilities on `(package, version)`. One row per
  installed package-version with license metadata (cols 1-9, 15 per
  customer spec) AND per-package vulnerability rollup: max severity
  (col 11), per-advisory list with CVSS scores (col 12), and derived
  Tier-1 resolution proposal (col 13 — "Upgrade X to Y" when every
  advisory has a fixedVersion, "Upgrade <parent> (transitive fix)" when
  the fix is in a parent dep, "No fix available" otherwise). Detailed
  mode (`--detailed`) emits a risk-review markdown with 6 triage
  buckets (critical/high × no-fix/actionable, medium, low, license-
  scanner-gap). `--xlsx` / `to-xlsx` produce the 15-column workbook
  the customer's spreadsheet workflow expects, byte-identical headers.
- **`vyuh-dxkit to-xlsx <json>`** — shared converter. Reads any
  licenses or bom detailed JSON and emits the canonical 15-col XLSX.
  Lets downstream tooling stash JSON and render on demand without re-
  running the analyzer.

### Added — dependency-vulnerability per-advisory detail

- Every language pack's `depVulns` provider now populates
  `DepVulnFinding[]` alongside the existing per-severity counts. Counts
  remain per-package (for `vulnerabilities` command parity); findings
  are per-advisory with id (GHSA/CVE/PYSEC/GO/RUSTSEC), installed +
  fixed versions, CVSS score, aliases, summary, references, and tool
  attribution. `gatherDepVulns` forwards findings into
  `SecurityReport.summary.dependencies.findings` so the
  `vulnerabilities --detailed` command renders per-advisory inventory
  (previously: counts only).
- `DepVulnFinding` extended with nine optional fields for tier-layered
  enrichment: `tool` (denormalized producer, renamed from unused
  `source`), `cvssScore`, `upgradeAdvice`, `reachable`, `epssScore`,
  `kev`, `riskScore`, `breakingUpgrade`, `aliases`, `summary`,
  `references`. Per-pack Tier-1 providers populate what their native
  tools emit; Tier-2/3/4 enrichment lands in later 10h sub-phases.
- Cross-pack OSV enhancement: `enrichOsv` (renamed from
  `enrichSeverities`) now returns `{severity, cvssScore}` pairs, and
  a new `resolveCvssScores` helper does batched alias-fallback
  lookups. Fills the CVSS gap for GO-\* records (bulk of which carry
  no severity but whose CVE aliases do) and PYSEC-\* records. TS pack
  is a no-op via this path (npm-audit already ships CVSS at ~100%);
  Python cvssScore coverage jumped from 0% → 100% on the fixture,
  Go from 0% → 55% on vyuhlabs/Tickit.
- **Go pack parser fix** — `govulncheck -json` emits pretty-printed
  multi-line JSON, not single-line ndjson. Previous `split('\n')`
  parser silently failed on every invocation; new balanced-brace
  `parseJsonStream` helper in `runner.ts` handles both shapes and
  string-literal escapes. Reusable for any future tool that
  pretty-prints.
- **Python pack manifest gating** — previously `pip-audit` ran with
  no project context and silently scanned dxkit's own graphify-venv.
  Now routes by manifest: `pip-audit <cwd>` for pyproject.toml/setup.py
  projects, `pip-audit -r requirements.txt` for requirements projects,
  null otherwise. Corrected platform audit: 97 → 94 dep vulns (3
  phantom graphify-venv pip findings removed).

### Added — tool registry

- TypeScript pack: `license-checker-rseidelsohn` (license inventory)
- Python pack: `pip-licenses` (license inventory)
- Go pack: `go-licenses` (license inventory, `go install golang.org/...`)
- Rust pack: `cargo-license` (license inventory, `cargo install`)
- C# pack: `nuget-license` (license inventory, `dotnet tool install`)

All bundled into per-pack provider commits so `findTool` + provider
invocation land together (CLAUDE.md rule 1).

### Changed

- **Vulnerability report labelling** — Executive Summary now cleanly
  separates "Code Findings" (your team patches source) from
  "Dependency Vulnerabilities" (upgrade the dep) into two tables with
  a combined total. Previously a single table labelled just "Severity
  / Count" implied dep vulns were included, which they weren't. The
  shallow report also now renders a worst-first per-advisory dep-vuln
  table (50-row cap), so `vulnerabilities` without `--detailed` is
  already actionable.
- **Security detailed schema** — bumps from `"11"` → `"12"` for the
  new `summary.dependencies.findings: DepVulnFinding[]` field in the
  JSON output. Additive — consumers reading just the old keys stay
  compatible.
- **`DepVulnFinding.source` repurposed to `DepVulnFinding.tool`**.
  The former `'osv.dev' | 'tool-default' | 'tool-reported'` enum was
  dead code (declared, never written or read). Field now holds the
  producer tool name (`npm-audit` / `pip-audit` / `govulncheck` /
  `cargo-audit` / `dotnet-vulnerable`) so per-finding attribution
  survives merges across multiple providers.

### Fixed

- **npm-audit `fixAvailable` misinterpretation** — `fix.name` is the
  top-level upgrade target, not the vulnerable package itself. Prior
  code blindly assigned `fix.version` as `fixedVersion` on every
  advisory, producing absurd output like "uuid@13.0.0 → Upgrade to
  3.2.1". Now branches on `fix.name === pkgName`: direct fix sets
  `fixedVersion`; transitive fix sets `upgradeAdvice` with parent-
  package guidance ("Upgrade @loopback/cli to 5.0.0 [major]
  (transitive fix)"). Surfaced ~20 false positives on platform audit
  covering uuid/octokit/tar/undici/underscore.
- **bom xlsx col 11/12/13 fill on non-vulnerable rows** — previously
  blank, creating "scanned-clean vs not-scanned" ambiguity. Now fills
  "None" / "No action required" so reviewers see at a glance which
  rows dxkit actually processed.

### Runtime dependencies added

- `exceljs ^4.4.0` — XLSX writer. Adds ~80 transitive deps (bumps
  dxkit's own license-checker count 242 → ~325).
- `hosted-git-info ^9.0.2` + `@types/hosted-git-info ^3.0.5` — URL
  canonicalisation (source URL column of licenses/bom).

## [2.0.1] - 2026-04-22

Patch release following the 2.0.0 smoke-test. No API or schema changes —
drop-in upgrade from 2.0.0.

### Fixed

- **`HealthReport.toolsUsed` now includes every external scanner that
  actually ran.** Pre-2.0.1 the list was synthesized only from
  `capabilities.lint` + `capabilities.depVulns`, so `semgrep` (code-
  pattern scanner, `capabilities.codePatterns`) and `jscpd` (clone
  detector, `capabilities.duplication`) didn't appear in the `health`
  command's tool list even though they ran during
  `gatherCapabilityReport`. `gitleaks` and `graphify` appeared only
  because `tools/parallel.ts` pushed them separately. Now
  `toolsFromCapabilities` mirrors all six external-scanner envelopes
  (lint, depVulns, secrets, codePatterns, duplication, structural);
  Layer 2's pushes dedupe via the existing `!includes(t)` guard.
  Pseudo-tool envelopes (`imports.tool = 'ts-imports'`,
  `testFramework.tool = 'typescript'`) stay out of the list — those
  are language-pack identifiers, not external tools.

## [2.0.0] - 2026-04-22

**BREAKING RELEASE.** The deterministic analyzer architecture introduced in
1.6.0 matured through an explicit capability model during Phase 10e. Language
packs now expose data exclusively through typed capability providers
(depVulns, lint, coverage, testFramework, imports) routed through a
`CapabilityDispatcher`; global scanners (gitleaks + grep-secrets fallback,
semgrep, jscpd, graphify) register under the same model. The legacy
`gatherMetrics` channel and its aggregation helpers are removed.

### Breaking changes — JSON schema v10 → v11

- Detailed reports now emit `"schemaVersion": "11"` (was `"10c.1"`).
- `HealthReport.dimensions.*.metrics` shed all capability-data echoes
  (`lintErrors`, `lintWarnings`, `lintTool`, `secretFindings`,
  `depVulnCritical`/`High`/`Medium`/`Low`, `depAuditTool`,
  `testFramework`, `coveragePercent`, `commentedCodeRatio`,
  `maxFunctionsInFile`, `deadImportCount`, `godNodeCount`,
  `communityCount`, `avgCohesion`, `orphanModuleCount`). Consumers read
  these from `report.capabilities.*` now.
- `HealthReport.capabilities` is the new canonical sub-object carrying
  typed envelopes (`depVulns`, `lint`, `coverage`, `imports`,
  `testFramework`, `secrets`, `codePatterns`, `duplication`,
  `structural`).
- `HealthMetrics` narrowed to ~30 non-capability fields (filesystem
  counts, grep markers, doc / config flags, language breakdown).
- `QualityReport`, `SecurityReport`, `TestGapsReport`, `DevReport` shapes
  unchanged — their detailed variants still bump to v11 for release
  consistency.

### Added

- Capability dispatcher (`src/analyzers/dispatcher.ts`) with per-`(cwd,
  capId)` in-memory caching and provider-failure isolation.
- Nine capability descriptors with bespoke aggregate functions
  (depVulns/lint sum counts, coverage/testFramework last-wins,
  secrets/codePatterns union findings, duplication sums + re-weights,
  structural last-wins, imports unions per-pack graphs).
- Multi-provider support per capability: `GlobalCapabilities` slots take
  provider arrays, so fallbacks and opt-in scanners compose cleanly.
- `grep-secrets` fallback provider: 7 regex patterns (hardcoded-password,
  api-key, secret, private-key, AWS access key, GitHub token, Anthropic
  key) that activate when `gitleaks` is absent. Preserves degraded-
  environment secret coverage.
- `src/analyzers/tools/package-json.ts`: direct `fs.readFileSync` +
  `JSON.parse` helper for `npmScriptsCount` and `nodeEngineVersion`,
  replacing the prior `node -e` subprocess pair.

### Removed

- `LanguageSupport.gatherMetrics` optional method — every pack now
  exposes data through `capabilities`.
- `LangMetrics` type and `mergeMetrics` / `AGGREGATED_VULN_FIELDS`
  helpers.
- `gatherGitleaksMetrics`, `gatherGraphifyMetrics` legacy bridge
  functions (capability providers + memoized outcome helpers replace
  them).
- `getSemgrepRulesets`, `getToolDef`, `runRegisteredTool`,
  `EVOLVING_FILES`, `src/analyzers/index.ts` barrel file — all
  unreferenced after the refactor.
- Pre-2.0 child-process + bash orchestration in `tools/parallel.ts`;
  gitleaks and graphify now run in-process with per-cwd memoization.

### Changed

- Scorers consume a `ScoreInput = { metrics, capabilities }` bundle
  (was: flat `HealthMetrics`). Same byte-identical scoring formulas.
- `HealthReport.toolsUsed` synthesizes per-pack tool names
  (`eslint`, `npm-audit`, `ruff`, `pip-audit`, `golangci-lint`,
  `govulncheck`, …) directly from `capabilities.lint.tool` and
  `capabilities.depVulns.tool` rather than from the deleted per-pack
  gatherMetrics emissions.

### Migration

- Replace `report.dimensions.quality.metrics.lintErrors` →
  `(report.capabilities.lint?.counts.critical ?? 0) +
  (report.capabilities.lint?.counts.high ?? 0)`.
- Replace `report.dimensions.security.metrics.secretFindings` →
  `report.capabilities.secrets?.findings.length ?? 0`.
- Replace `report.dimensions.security.metrics.depVulnCritical` →
  `report.capabilities.depVulns?.counts.critical ?? 0` (and similarly
  for high/medium/low).
- Replace `report.dimensions.testing.metrics.coveragePercent` →
  `Math.round(report.capabilities.coverage?.coverage.linePercent ?? 0)`.
- Replace `report.dimensions.testing.metrics.testFramework` →
  `report.capabilities.testFramework?.name`.
- Replace `report.dimensions.quality.metrics.maxFunctionsInFile` →
  `report.capabilities.structural?.maxFunctionsInFile`.
- No changes required for non-`health` commands — `vyuh-dxkit
  vulnerabilities`, `test-gaps`, `quality`, `dev-report` keep their
  report shapes unchanged.

## [1.6.1] - 2026-04-21

Patch release with two CLI bug fixes found while regenerating dxkit's own
reports. No API or schema changes — drop-in upgrade from 1.6.0.

### Fixed

- **CLI positional paths are now resolved to absolute before analyzers run.**
  Previously, `vyuh-dxkit health .` (or any other analyzer command invoked
  with `.`) propagated the literal `"."` into Layer 2 child worker processes
  (cloc, gitleaks, graphify), which run from `dist/analyzers/` rather than
  the target repo. The `.` then resolved against the worker's cwd and cloc
  happily scanned dxkit's own compiled `dist/*.js` output — producing
  bogus language breakdowns like "JavaScript 90%, TypeScript 10%" on
  TypeScript-only repos. The CLI now wraps all 6 positional-path sites
  with `path.resolve()` at the boundary, so bare `.` / `./foo` / `../bar`
  arguments work as users expect. Affects `health`, `vulnerabilities`,
  `test-gaps`, `quality`, `dev-report`, and `tools`.
- **Vulnerability report section numbers are now dynamic.** Previously,
  empty finding categories (Secrets / Code Patterns / Config Issues /
  Dependencies) were skipped but their hardcoded section numbers were
  not renumbered, so a report with only secrets + dep vulns rendered as
  `## 1.` → `## 4.` with 2 and 3 mysteriously missing. Sections are now
  numbered with a running counter that advances only when a section
  actually renders. Output is purely cosmetic-identical when all four
  categories have findings; skipped categories no longer leave holes.

### Internal

- `chore: sync package-lock.json to 1.6.0` — the 1.6.0 release commit
  bumped `package.json` but not the lockfile. Every `npm install` since
  has surfaced as `M package-lock.json`. Now consistent.

## [1.6.0] - 2026-04-18

This release transforms dxkit from a scaffolder into an analyzer-and-scaffolder.
Five native CLI commands run deterministic analyses against any repo — no LLM
required, reproducible scores, agent-consumable JSON output. The scaffolding
capability is unchanged.

### Added

#### Native analyzer CLI (new primary capability)

- **`vyuh-dxkit health [path]`** — 6-dimension score (Testing, Code Quality,
  Documentation, Security, Maintainability, Developer Experience) with
  overall grade A–F. Runs in 10–20s on mid-size repos.
- **`vyuh-dxkit vulnerabilities [path]`** — gitleaks secret scan + semgrep SAST
  + `npm audit` / `pip-audit` / `govulncheck` / `cargo-audit` dependency
  vulnerabilities. Findings grouped by rule with severity + CWE category.
- **`vyuh-dxkit test-gaps [path]`** — coverage artifact import with
  import-graph reachability fallback. Ranks untested files by risk tier
  (CRITICAL for auth/security, HIGH for large services, etc.).
- **`vyuh-dxkit quality [path]`** — Slop score (0–100) combining lint errors,
  `: any` density, console statements, TODO/FIXME, duplication % (jscpd),
  comment ratio, and hygiene markers. Ranked remediation actions.
- **`vyuh-dxkit dev-report [path]`** — git activity: commits, contributors,
  hot files, merge ratio, conventional-commit compliance, weekly velocity.
- **`--detailed` flag** on all analyzers — writes paired `<name>-detailed.md`
  + `<name>-detailed.json` with Evidence (file, line, rule, tool) and
  `RemediationAction<M>` entries ranked by projected score delta.
- **`--json` flag** — pure JSON on stdout, logs on stderr for clean piping.
- **`--verbose` flag** — per-tool timing to stderr.
- **`--no-save` flag** — skip markdown output.
- **`--since <date>`** (dev-report only) — bound the git activity window.

#### Tool registry and installer

- **`vyuh-dxkit tools`** — list detection status for all tools required by
  the detected stack. Multi-path detection (PATH → brew → npm-g → pipx →
  cargo → go → project `node_modules` → system probes).
- **`vyuh-dxkit tools install [--yes]`** — interactive or non-interactive
  install of missing tools via platform-specific commands (brew on macOS,
  user-local on Linux). No `sudo` required; tools install to `~/.local/bin`
  or equivalent.
- **21 tools integrated** across 6 languages:
  - Universal: `cloc`, `gitleaks`, `semgrep`, `jscpd`, `graphify`
  - Node/TS: `eslint`, `npm audit`, `@vitest/coverage-v8`
  - Python: `ruff`, `pip-audit`, `coverage` (coverage.py)
  - Go: `golangci-lint`, `govulncheck`
  - Rust: `clippy`, `cargo-audit`, `cargo-llvm-cov`
  - C#: `dotnet-format`
- **`nodePackage` field** on `ToolDefinition` — detects Node packages that
  have no CLI binary (e.g. vitest plugins) via `node_modules/<pkg>/package.json`.
- **`runRegisteredTool()`** — sanctioned path to run any registered tool,
  ensures all tool invocation goes through detection instead of hardcoded
  binary paths.

#### Coverage artifact import

- **Istanbul** (`coverage/coverage-summary.json` + `coverage-final.json`) —
  used by vitest, nyc, c8. Parses per-file line coverage + overall %.
- **coverage.py** (`coverage.json`) — Python.
- **Go coverprofile** (`coverage.out` / `cover.out`) — text format with
  module-prefix path resolution.
- **Cobertura XML** (`coverage.cobertura.xml`, `TestResults/<guid>/...`) —
  C# (coverlet) and Rust (`cargo llvm-cov --cobertura`).
- **lcov** (`lcov.info`) — Rust (`cargo llvm-cov --lcov`).

#### Import-graph test matching

- **TS/JS extractor** — static imports, `import(...)` dynamic, `require()`,
  `export * from` re-exports, multi-line imports, comment-stripping.
- **Python extractor** — `import X`, `from X import Y`, relative-dot imports.
- **Go extractor** — single-line `import "fmt"` + multi-line `import (...)`
  blocks with alias support. Module-based resolution via `go.mod`.
- **Rust extractor** — `use std::io`, nested paths, block `use std::{io, fs}`.
- **C# extractor** — `using X.Y;`, `using static`, `using Alias = X.Y;`.
- **Resolver** — relative-path resolution with extension fallback and
  directory-as-`index.ts` probing (TS/JS) or `__init__.py` (Python).
  Go resolves internal module paths via `go.mod` module prefix.
- **BFS walker** — up to 3 hops transitively, cycle-safe. External packages
  are correctly skipped.

#### Suppressions

- **`.dxkit-suppressions.json`** — silence known-false positives per tool
  without editing code. Format:
  ```json
  {
    "gitleaks": [
      { "rule": "generic-api-key", "paths": ["test/fixtures/**"], "reason": "..." }
    ]
  }
  ```
- Glob matcher supports `**`, `*`, `?`. A finding is suppressed when rule
  matches (exact or `*`) AND at least one path glob matches.
- Wired to gitleaks. Semgrep and slop-hook integrations follow.

#### CI + hooks hardening

- **CI enforces everything pre-push does, plus slop-vs-base diff.**
  `.github/workflows/ci.yml` now runs architecture check, slop check
  (diffing against the PR base branch via `DXKIT_SLOP_BASE`), tests with
  coverage, and coverage-threshold enforcement. `--no-verify` can no longer
  ship code that introduces slop.
- **`scripts/check-coverage.sh`** — reads `coverage/coverage-summary.json`,
  fails if line coverage below threshold (default 50%, configurable via
  `DXKIT_COVERAGE_THRESHOLD`). Wired into `.husky/pre-push` and CI.
- **`scripts/check-slop.sh` CI mode** — when `DXKIT_SLOP_BASE` env var is
  set, diffs against that ref instead of `--cached`. Pre-commit behavior
  unchanged.

#### Dogfood

- dxkit's own line coverage raised from ~19% to 59% in the course of
  building these analyzers. 423 tests across 21 files, all passing.
  Coverage threshold of 50% enforced on every push and PR.

#### Language-pack rearchitecture (10d.1.6)

- **`LanguageSupport` interface** — single-file-per-language architecture.
  Each language implements: detection, tool bindings, semgrep rulesets,
  coverage parsing, import extraction/resolution, metric gathering, and
  lint severity mapping. `src/languages/{python,typescript,csharp,go,rust}.ts`.
- **Registry dispatch** — `health.ts`, `tool-registry.ts`, `import-graph.ts`,
  `gather.ts`, and `quality/gather.ts` all dispatch through
  `detectActiveLanguages()` instead of per-language if-chains.
- **Old scattered code deleted** — `src/analyzers/tools/{node,python,go,
  rust,dotnet}.ts` removed (~583 LOC). Net reduction despite adding 5
  language packs + coverage parsers + import extractors.
- **Ruff severity mapping** — Python lint results now bucket ruff codes by
  prefix: S→critical, F/B→high, E/C→medium, W/N/D/I→low. Previously all
  results were counted as errors regardless of code.
- **C# `*Tests.cs` pattern** — test-gap analyzer now recognizes the C#
  naming convention (`FooTests.cs`, `Foo.Tests.cs`) that the old
  `*.test.*`/`*.spec.*`-only patterns missed.
- **`cargo-llvm-cov`** registered in TOOL_DEFS with detection + install.
- **Contract tests** — 46 tests validate every language pack: TOOL_DEFS
  key validity, extension format, wildcard patterns, detect() idempotency,
  completeness (all 5 required IDs registered).

#### OSV.dev severity enrichment + CVSS v4 (10d.2)

- **OSV.dev integration** — `src/analyzers/tools/osv.ts` looks up
  vulnerability IDs against `https://api.osv.dev/v1/vulns/{id}` and
  classifies them into critical/high/medium/low tiers. Session-scoped
  in-memory cache. 10s per-request timeout with offline fallback.
- **Full CVSS v4.0 calculator** — `src/analyzers/tools/cvss-v4.ts` with
  the 270-entry macrovector → base-score lookup table (BSD-2-Clause,
  ported verbatim from FIRST.ORG's reference implementation, attributed
  in `THIRD_PARTY_NOTICES.md`). Handles equivalence-class computation,
  severity-distance refinement, and rounding per spec. Critical for
  modern CVEs (2025+) that publish v4 vectors exclusively.
- **Python pack (`pip-audit`)** — previously bucketed every finding as
  medium. Now extracts vuln IDs and looks each up via OSV. Unknown or
  unreachable IDs keep the legacy medium bucket. Verified on
  CVE-2025-8869 (pip tar symlink → v4 5.9 → medium, matches NVD).
- **Go pack (`govulncheck`)** — ndjson findings reference OSV IDs.
  We now prefer the advisory's embedded severity (govulncheck inlines
  the full OSV record), only falling back to the OSV.dev API when
  severity data is missing. Unknown IDs bucket as high (govulncheck's
  legacy default).

#### Lint severity tiers across all packs

Each language pack now exposes `mapLintSeverity(ruleId)` that tiers
findings into critical/high/medium/low. `gatherMetrics` still collapses
to the legacy `lintErrors`/`lintWarnings` fields (critical+high →
errors, medium+low → warnings) for backcompat.

- **TypeScript (ESLint)** — security plugins (`security/*`,
  `security-node/*`) and code-injection built-ins (`no-eval`,
  `no-new-func`, `@typescript-eslint/no-unsafe-eval`) → critical;
  correctness bugs (`no-undef`, `no-unreachable`, `no-dupe-*`,
  `@typescript-eslint/no-unsafe-*`, `react-hooks/rules-of-hooks`) → high;
  best practices (`no-console`, `prefer-const`,
  `@typescript-eslint/no-explicit-any|no-unused-vars`,
  `react-hooks/exhaustive-deps`) → medium; style plugins
  (`prettier/*`, `import/*`, `react/*`, `jsx-a11y/*`, `unicorn/*`) → low.
  Unknown rules fall back to ESLint's severity floor.
- **Go (golangci-lint)** — tier by `FromLinter`: `gosec` → critical;
  `govet`/`staticcheck`/`typecheck`/`errorlint`/`ineffassign`/`unused`/
  `bodyclose`/`sqlclosecheck`/`noctx` → high; `errcheck`/`gocritic`/
  `revive`/`gocyclo`/`gosimple`/`unparam`/`gocognit` → medium; `gofmt`/
  `goimports`/`stylecheck`/`whitespace`/`misspell`/`lll` → low.
- **Rust (clippy)** — hand-catalogued correctness-group lints:
  15 memory-safety / UB lints (`uninit_*`, `transmuting_null`, `cast_ref_to_mut`,
  `invalid_atomic_ordering`, …) → critical; 35+ correctness-bug lints
  (`panicking_unwrap`, `never_loop`, `out_of_bounds_indexing`,
  `ifs_same_cond`, `logic_bug`, …) → high; rustc-native lints → medium;
  all other clippy groups (style, perf, pedantic, nursery, cargo) → low.
- **C#** — `mapLintSeverity` intentionally omitted: `dotnet-format` is
  a formatter, not a tiered linter. Documented in pack source with a
  TODO pointer to a future `dotnet build --verbosity quiet` integration
  that would extract CS*/CA*/IDE* diagnostic codes.

#### Dep-vuln aggregation across language packs

- **`mergeMetrics` now sums `depVuln*` counts** instead of overwriting.
  Mixed-stack repos (e.g. Node + Python) previously had whichever pack
  ran last silently clobber earlier packs' vuln counts. Now pip-audit
  and npm-audit findings add together. `depAuditTool` likewise joins
  with `, ` (e.g. `"pip-audit, npm-audit"`).
- **Meta-tool classifier fix** — `src/analyzers/security/*.ts` files
  matched `CRITICAL_PATTERNS` by name (`/security/i`) and showed up in
  test-gaps as critical untested code. They're analyzer modules, not
  app security code. Added path-prefix exception (`^src/analyzers/`,
  `^tmp/`, `^scripts/`) that downgrades these to their structural tier.
- **C# dotnet-format violations** reclassified from `lintErrors` to
  `lintWarnings` — they're formatting issues (indentation, spacing),
  not correctness errors. No longer inflates the quality/slop error
  count.

#### Async language-pack contract

- **`gatherMetrics` is now async** (`Promise<Partial<HealthMetrics>>`).
  Enables network-dependent enrichment (OSV lookups). The full analyzer
  chain — `analyzeHealth`, `analyzeQuality`, and the CLI commands —
  threads async end-to-end. Bonus: the 5 language packs now run through
  `Promise.all` in health.ts instead of sequentially.
- **`timedAsync`** helper added alongside existing `timed` in
  `src/analyzers/tools/timing.ts` for per-tool verbose timing of
  async gatherers.

### Changed

- **`vitest.config.ts`** now generates Istanbul summary + JSON reporters when
  `--coverage` is passed. Coverage output in `coverage/`.
- **Signal precedence in `test-gaps`** — coverage artifact now *overrides*
  filename match for files it measured. Previously all three signals OR'd
  together, which wrongly credited files like `cli.ts` when a test had a
  similar basename but didn't actually import the module. Now: artifact
  authoritative where present, import-graph for files it didn't see,
  filename-match as last resort.
- **`.husky/pre-push`** — now runs `npm run build && vitest run --coverage &&
  bash scripts/check-coverage.sh`. Previously ran `vitest run --changed @{u}`
  without coverage.
- **`--json` output** — clean JSON on stdout now. Previously the logger
  header (`━━━ vyuh-dxkit ...`) leaked into stdout before the JSON payload.

### Fixed

- **`--json` stdout pollution** — `logger.header/info/success/warn/fail/dim/
  detected` route to stderr when JSON mode is active.
- **Filename matcher false positives** — `cli-init.test.ts` used to credit
  `cli.ts` via basename similarity even though it doesn't import it in
  process (uses `execFileSync`). After the precedence fix and import-graph
  matcher, dxkit's `test-gaps` agrees with V8 on every measured file.
- **Unused import warnings** — cleaned up six pre-existing unused imports
  that CI's `--max-warnings 0` would now catch.

### Internal / Architecture

- New modules: `src/analyzers/tools/coverage.ts`, `tools/suppressions.ts`,
  `tests/import-graph.ts`.
- `HealthMetrics.coveragePercent` now populated from the imported artifact
  when present; the existing Testing-dimension coverage bonus fires against
  line-level truth instead of being null.
- `HealthMetrics.secretSuppressed` — count of gitleaks findings filtered by
  `.dxkit-suppressions.json`.
- `ToolDefinition.nodePackage` — optional field for Node packages detected
  via `node_modules/<pkg>/package.json` rather than a binary in `.bin`.
- `vitest.integration.config.ts` — separate config for running only the
  `test/integration/**` suite (kept for developers who want to run the slow
  integration tests without the rest of the suite).

## [1.5.1] - 2026-04-10

### Fixed
- **`make setup` no longer aborts on npm install failure.** Peer dependency
  conflicts now show a helpful message instead of killing the entire script.
- **`--stealth` flag** for `dxkit init` — gitignore only files created in
  this run.

## [1.5.0] - 2026-04-10

### Fixed
- **Node version detection** no longer returns the minimum from
  `engines.node` ranges. `">=10"` previously returned `10`; now
  prefers the installed Node version. Exact pins (`"^20"`, `"20"`)
  still work directly. Priority: `.nvmrc` > `volta.node` >
  `engines.node` (exact pin) > installed version > range minimum >
  default.

## [1.4.0] - 2026-04-09

### Added
- **`.project.yaml` config source.** When `.project.yaml` exists in the
  target directory (typically written by `@vyuhlabs/create-devstack`),
  `dxkit init` reads it and uses it as the config source — skipping
  both `detect()` and interactive prompts. This enables greenfield
  projects where no language files exist yet. If the file is malformed
  or missing `project.name`, dxkit falls back to detection + prompts.
- **Library exports**: `hasProjectYaml()` and `readProjectYaml()` from
  the `@vyuhlabs/dxkit` package entry point.
- **README**: `.project.yaml` documentation, library API section, and
  config source priority.

## [1.3.0] - 2026-04-09

### Added
- **Library entry point** (`src/lib.ts`). Exports `detect()`,
  `processTemplate()`, `TemplateEngine`, and `DetectedStack` for
  programmatic consumption by downstream packages like
  `@vyuhlabs/create-devstack`. The npm `exports` and `main` fields now
  point to `dist/lib.js` so `import { detect } from '@vyuhlabs/dxkit'`
  works. The CLI binary (`vyuh-dxkit`) is unaffected.
- **Path-scoped auto-activation** (`paths:` frontmatter) on four shipped
  skills, so they auto-load whenever Claude Code is touching a matching
  file — even if the user's prompt doesn't name the tool:
  - `gcloud` — `**/cloudbuild.{yaml,yml}`, `**/.gcloudignore`, `**/app.yaml`
  - `pulumi` — `Pulumi.{yaml,yml}` and stack variants
  - `secrets` — `**/.env*`, `**/.infisical.json`
  - `test` — common test file patterns across TypeScript, JavaScript,
    Go, Python (`**/*.test.*`, `**/*_test.go`, `**/test_*.py`,
    `**/__tests__/**`, `**/tests/**`)

  This is additive — descriptions still drive activation for everything
  else, and the eight intent-driven skills (`build`, `deploy`, `doctor`,
  `learned`, `quality`, `review`, `scaffold`, `session`) remain
  description-only, since path-scoping would over- or under-trigger them.
- **Test suite** (Vitest). Unit tests for `detect()` against fixture project
  trees, plus an integration test that runs the built CLI against a tmp dir
  and asserts on the generated `.claude/` tree.
- **Lint + format toolchain.** ESLint flat config with `typescript-eslint`,
  Prettier, and `eslint-config-prettier`. CI enforces both with
  `--max-warnings 0`.
- **Git hooks** via husky + lint-staged. Pre-commit auto-fixes staged files
  and runs `tsc --noEmit`. Pre-push runs affected tests
  (`vitest run --changed @{u}`) with a graceful fallback to the full suite.
- **`.git-blame-ignore-revs`** so formatting commits don't pollute blame.

### Changed
- **GitHub Actions Node version bumped from 20 → 22** in both `ci.yml` and
  `publish.yml`. Removes the Node 20 deprecation warning ahead of the
  2026-06-02 runner cutoff. `.nvmrc` updated to match. The package's
  `engines.node: ">=18"` constraint is unchanged — consumers on Node 18+
  are unaffected.
- **One-time Prettier baseline** applied across the existing source. The
  baseline commit is registered in `.git-blame-ignore-revs`.

### Fixed
- Removed three unused-variable / unused-import dead-code spots in
  `src/generator.ts` and `src/codebase-scanner.ts` that ESLint flagged.

## [1.2.1] - 2026-04-06

### Fixed
- Add missing `repository`, `homepage`, `bugs`, and `author` fields to
  `package.json` so npmjs.com surfaces a "Repository" link to
  https://github.com/vyuh-labs/dxkit. These fields were accidentally
  omitted from the 1.2.0 publish during the repo split.
- Include `LICENSE` and `CHANGELOG.md` in the published tarball.

## [1.2.0] - 2026-04-06

### Changed
- **Repository moved** to its own home at https://github.com/vyuh-labs/dxkit.
  Previously developed inside `vyuh-labs/codespaces-ai-template-v2`. The npm
  package name (`@vyuhlabs/dxkit`) is unchanged — `npx @vyuhlabs/dxkit init`
  works exactly as before.
- Package is now self-contained: templates live in `src-templates/` inside the
  repo instead of being copied from a parent monorepo at build time.

### Added
- `LICENSE` (MIT), `CHANGELOG.md`, `CONTRIBUTING.md`.
- GitHub Actions: `ci.yml` (typecheck + build + pack-dry on push/PR) and
  `publish.yml` (publish to npm on GitHub release).

## [1.1.0] - 2026-04-06

### Added
- Strategic planner and plan executor agents (reports → KPIs → plans → execution).
- Feature development loop: `feature-planner` and `feature-builder` agents.
- Pattern-based tasks in the planner; pattern sweep in the plan executor.
- Stealth mode, dashboard, and expanded command/agent set (26 commands, 12 agents).

## [1.0.0] - 2026-03

### Added
- Initial public release of `@vyuhlabs/dxkit`.
- `init` command with auto-detect for languages and frameworks.
- Drop-in `.claude/` generation: agents, commands, skills, rules, settings.
- `--full` mode that also seeds devcontainer, Makefile, CI, and project scripts.
- `doctor` and `update` commands.
