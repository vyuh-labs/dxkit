# Changelog

All notable changes to `@vyuhlabs/dxkit` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
