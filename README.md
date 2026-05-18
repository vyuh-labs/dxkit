# @vyuhlabs/dxkit

AI-native analyzer and scaffolder for any repository. Two modes in one CLI:

1. **Analyze** any repo deterministically — health, security, test gaps, code quality, developer activity — in seconds, no LLM required.
2. **Scaffold** `.claude/` agents, skills, commands, and hooks tuned to your stack.

Built so agent-written code has deterministic guardrails before it ships. Scores don't move just because an LLM had a different mood today.

## Quick Start

**Analyze an existing repo:**

```bash
cd your-repo
npx @vyuhlabs/dxkit tools install --yes      # one-time: install cloc, gitleaks, etc.
npx @vyuhlabs/dxkit health --detailed         # 6-dimension score + remediation plan
npx @vyuhlabs/dxkit vulnerabilities           # secret + SAST + dep-audit (ranked by risk)
npx @vyuhlabs/dxkit bom --filter=top-level    # Bill of Materials w/ "This Week's Triage"
npx @vyuhlabs/dxkit test-gaps                 # import-graph + coverage-aware
npx @vyuhlabs/dxkit quality                   # slop + duplication + lint
npx @vyuhlabs/dxkit licenses                  # dependency license inventory
npx @vyuhlabs/dxkit dev-report                # git activity + contributors
```

**Scaffold AI tooling into a repo:**

```bash
npx @vyuhlabs/dxkit init --detect             # auto-detect stack, minimal prompts
npx @vyuhlabs/dxkit init --full --yes         # everything: DX + quality + hooks + CI
```

The two modes are complementary. The analyzers run anywhere; the scaffolder writes `.claude/` so Claude Code and other agents have project-specific context and slash commands that delegate to the same analyzers.

> **Already installed dxkit globally?** Globals don't auto-update. If you previously ran `npm install -g @vyuhlabs/dxkit`, the `vyuh-dxkit` binary on your PATH stays pinned to whatever version was installed then; running `vyuh-dxkit` (without `npx`) keeps using the pinned version. To pick up the latest fixes, either upgrade the global or remove it and rely on `npx` (which fetches the requested version on demand):
>
> ```bash
> npm install -g @vyuhlabs/dxkit@latest
> # or:
> npm uninstall -g @vyuhlabs/dxkit
> ```

---

## Analyzer CLI (`vyuh-dxkit <command>`)

Seven deterministic analyzers + a one-shot orchestrator. Each emits a markdown report to `.dxkit/reports/` and a structured JSON file the dashboard reads.

| Command           | What it does                                                                                                                                                                                                                                                                                                          | Runtime | Output                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------- |
| `health`          | 6-dimension score (Testing, Quality, Docs, Security, Maint, DX)                                                                                                                                                                                                                                                       | 10–20s  | `.dxkit/reports/health-audit-<date>.md`       |
| `vulnerabilities` | gitleaks + semgrep + per-pack dep-audit (enriched with EPSS exploit probability, CISA KEV catalog, reachability from your source, composite riskScore; per-advisory detail in `--detailed`)                                                                                                                           | 5–30s   | `.dxkit/reports/vulnerability-scan-<date>.md` |
| `test-gaps`       | Coverage artifact → import-graph → filename (strongest wins). Headline coverage carries a `coverageFidelity` tier; banners surface heuristic-vs-line-coverage trust.                                                                                                                                                  | <1s     | `.dxkit/reports/test-gaps-<date>.md`          |
| `quality`         | Slop score + jscpd duplication + eslint/ruff + hygiene                                                                                                                                                                                                                                                                | 5–15s   | `.dxkit/reports/quality-review-<date>.md`     |
| `dev-report`      | Commits, contributors, hot files (autogen-filtered), weekly velocity (with zero-rows for empty weeks), conventional %                                                                                                                                                                                                 | <1s     | `.dxkit/reports/developer-report-<date>.md`   |
| `licenses`        | Dependency license inventory across every active pack (TS, Python, Go, Rust, C#; Kotlin + Java omitted — no canonical CLI license tool for Maven/Gradle ecosystems)                                                                                                                                                   | 5–20s   | `.dxkit/reports/licenses-<date>.md`           |
| `bom`             | **Bill of Materials** — joins licenses + vulns per package, groups by top-level manifest dep (Snyk-style), enriches with CISA KEV + EPSS + reachability, ranks by composite risk score with "This Week's Triage" summary, aggregates nested sub-projects, `--filter=top-level` collapses transitive rows, 15-col XLSX | 10–40s  | `.dxkit/reports/bom-<date>.{md,xlsx}`         |
| `coverage`        | Side-effecting — runs each active pack's `test-with-coverage` command to materialize the artifact `test-gaps` / `health` read back. Use this once before analysis, or pass `--with-coverage` to the analyzer.                                                                                                         | 1–10m   | per-pack artifact (`coverage.json` etc.)      |
| `dashboard`       | Renders every report under `.dxkit/reports/` into a single HTML page (tiles + per-report tabs + cross-cutting "Critical Issues at a Glance"). Reads `*-detailed.json` (written unconditionally as of 2.4.7).                                                                                                          | <1s     | `.dxkit/reports/dashboard.html`               |
| `report`          | **One-shot full audit** — runs every analyzer + dashboard in dependency order. `--with-coverage` materializes coverage once upfront so both `health` and `test-gaps` benefit without re-running tests per analyzer.                                                                                                   | 5–15m   | every output above + dashboard                |

Plus a converter: `vyuh-dxkit to-xlsx <json-file>` renders any `licenses` or `bom` detailed JSON as the canonical 15-column XLSX.

### Flags (apply to all analyzer commands)

| Flag              | Effect                                                                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--detailed`      | Surface the success-log line for the detailed report. (As of 2.4.7 the `-detailed.json` + `-detailed.md` files are written **unconditionally** so the dashboard always finds fresh input — this flag only controls the console-side noise.)                             |
| `--json`          | Emit pure JSON on stdout. Logs go to stderr so pipes stay clean                                                                                                                                                                                                         |
| `--verbose`       | Print per-tool timing to stderr                                                                                                                                                                                                                                         |
| `--no-save`       | Skip writing markdown; useful with `--json`                                                                                                                                                                                                                             |
| `--xlsx`          | (`licenses`, `bom` only) Also write 15-col `.xlsx` — drop-in for spreadsheet workflows                                                                                                                                                                                  |
| `-o <file>`       | (`licenses`, `bom`, `to-xlsx`) Override output path for xlsx / converted file                                                                                                                                                                                           |
| `--since <date>`  | (`dev-report` only) Analyze commits on or after `YYYY-MM-DD`                                                                                                                                                                                                            |
| `--filter`        | (`bom` only) `all` (default) or `top-level` — keep only root manifest deps; the byTopLevelDep rollup still reflects transitives                                                                                                                                         |
| `--no-nested`     | (`bom` only) Disable nested-project aggregation. Default discovers every sub-project with a language manifest under cwd and merges their BOMs                                                                                                                           |
| `--with-coverage` | (`health`, `test-gaps`, `report`) Materialize coverage artifacts via per-pack `runTests()` **before** analysis. Promotes the headline from filename-match heuristic to `line-coverage` truth. With `report`, runs once upfront — health + test-gaps share the artifact. |
| `--lang <id>`     | (`coverage`, `--with-coverage`) Restrict to one pack id when the repo is polyglot                                                                                                                                                                                       |
| `--no-fail-fast`  | (`coverage`, `--with-coverage`) Continue running coverage across remaining packs after a `failed` outcome                                                                                                                                                               |

### Detailed mode — evidence + ranked fixes

`--detailed` writes a second pair of files with:

- **Per-dimension plans** with a prioritized fix list
- **Evidence** for every finding (file, line, rule ID, tool, snippet)
- **Projected score delta** for each remediation action — so you know which fix moves the needle most
- **Canonical JSON** (`schemaVersion`) that agents or dashboards can consume

### Signal precedence (for `test-gaps` and the Testing dimension in `health`)

Three signals, strongest wins for files it covers:

1. **Coverage artifact** — Istanbul JSON (TS/JS), `coverage.json` (Python), `coverage.out` (Go), cobertura XML (C#/Rust), `lcov.info` (Rust), JaCoCo XML (Kotlin/Java), SimpleCov resultset (Ruby). If the tool measured a file, that decision is authoritative.
2. **Import-graph reachability** — files transitively imported from an active test file (up to 3 hops). Rescues integration tests + behavior-named tests the filename matcher misses.
3. **Filename match** — last-resort basename similarity.

A file counts as "tested" when the strongest available signal says so.

#### Coverage fidelity tier (2.4.7+)

Test-gap reports now carry a `coverageFidelity` tier so a 0% from a heuristic can't be confused with a 0% from a real coverage run:

| Tier             | Source                                                                     | Trust              |
| ---------------- | -------------------------------------------------------------------------- | ------------------ |
| `line-coverage`  | Any of the artifacts above                                                 | Line-level truth   |
| `import-graph`   | Test-file import edges (up to N hops)                                      | Informed heuristic |
| `filename-match` | Source files with a name-matched test (200-line file / 5-line test passes) | Pure heuristic     |

The test-gaps markdown leads with a ⚠️ / ℹ️ banner when fidelity isn't `line-coverage`, pointing at `vyuh-dxkit coverage` and `vyuh-dxkit health --with-coverage` as the install paths to ground-truth.

---

## Tool Registry

Analyzers delegate to established tools instead of reinventing them. `vyuh-dxkit tools` manages detection and installation across multiple methods (PATH, brew, npm-g, pipx, cargo, go, project `node_modules`, system probes).

```bash
vyuh-dxkit tools                              # list tool status for the detected stack
vyuh-dxkit tools install --yes                # install all missing tools
vyuh-dxkit tools install                      # interactive: prompts per tool
```

### Tools integrated

| Layer     | Tools                                                                      |
| --------- | -------------------------------------------------------------------------- |
| Universal | `cloc`, `gitleaks`, `semgrep`, `jscpd`, `graphify` (AST)                   |
| Node / TS | `eslint`, `npm audit`, `osv-scanner` (fix planner), `@vitest/coverage-v8`  |
| Python    | `ruff`, `pip-audit`, `coverage` (coverage.py)                              |
| Go        | `golangci-lint`, `govulncheck`                                             |
| Rust      | `clippy`, `cargo-audit`, `cargo-llvm-cov`                                  |
| C#        | `dotnet-format` (via SDK — formatter, not a linter)                        |
| Kotlin    | `detekt` (Checkstyle XML), `osv-scanner` (Maven), JaCoCo XML               |
| Java      | `pmd` (PMD 7.x JSON), `osv-scanner` (Maven), JaCoCo XML reuse              |
| Ruby      | `rubocop` (JSON), `bundler-audit`, `osv-scanner` (Gemfile.lock), SimpleCov |

Install commands are platform-aware (brew on macOS, user-local install on Linux, winget/scoop on Windows). Tools install into `~/.local/bin` or similar user paths — no `sudo` required.

---

## Config Files

### `.dxkit-ignore`

Plain-text `.gitignore`-style file. Lines here are added to the analyzer's exclusion set on top of the bundled defaults and project `.gitignore`.

```
# .dxkit-ignore — override project exclusions for dxkit analyzers
vendor-bundle/
*.gen.ts
```

Three layers merge: bundled defaults → repo `.gitignore` → repo `.dxkit-ignore`.

### `.dxkit-suppressions.json`

Silence known-false positives without touching code. Wired to `gitleaks` (secrets) and `semgrep` (code patterns). Slop-hook wiring remains a follow-up.

```json
{
  "gitleaks": [
    {
      "rule": "generic-api-key",
      "paths": ["test/fixtures/**", "**/*.test.ts"],
      "reason": "Fake keys in test fixtures"
    }
  ],
  "semgrep": [
    {
      "rule": "javascript.express.security.audit.express-check-directory-traversal",
      "paths": ["scripts/serve-static.js"],
      "reason": "Controlled internal tool, not user-reachable"
    }
  ]
}
```

A finding is suppressed when its rule matches (exact string, or `*` for any) AND at least one path glob matches. Globs support `**`, `*`, `?`. Suppressed counts are reported separately in the analyzer output so "zero visible" is distinguishable from "zero real".

### `.project.yaml` (optional, for scaffolding)

When present (typically written by `@vyuhlabs/create-devstack`), `dxkit init` reads it as the config source — skipping detection and prompts. See [Scaffolding mode](#scaffolding-mode) below.

---

## Language Support

Each language is a single `LanguageSupport` implementation in `src/languages/`. Detection, tools, coverage parsing, import extraction, and lint severity mapping live in one place per language.

Adding a new language is a single command followed by filling in TODO markers:

```bash
npm run new-lang kotlin "Kotlin (Android)"
```

This scaffolds the 7 recipe files (pack module, test stub, fixture skeleton, Claude rule file, template-config dir, plus `LanguageId` union extension and `LANGUAGES` registration). See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full walkthrough. Recipe enforcement (architecture greps + contract tests + synthetic 6th-pack playbook) runs in pre-commit so packs that miss required metadata fail CI.

| Language | Detection                             | Coverage import     | Import-graph                                 | Native tools                        | Lint severity tiers    | Vuln severity tiers                           |
| -------- | ------------------------------------- | ------------------- | -------------------------------------------- | ----------------------------------- | ---------------------- | --------------------------------------------- |
| TS / JS  | `package.json`                        | ✅ Istanbul         | ✅ import/require/re-export                  | eslint, npm audit, vitest-coverage  | ✅ ESLint rule ID      | ✅ npm audit native                           |
| Python   | `pyproject.toml`, `setup.py`, `*.py`  | ✅ coverage.py      | ✅ import/from                               | ruff, pip-audit, coverage           | ✅ ruff code prefix    | ✅ pip-audit + OSV.dev (CVSS v3+v4)           |
| Go       | `go.mod`                              | ✅ coverprofile     | ✅ import blocks                             | golangci-lint, govulncheck          | ✅ `FromLinter` family | ✅ govulncheck embedded + OSV.dev             |
| Rust     | `Cargo.toml`                          | ✅ lcov + cobertura | ⚠️ use statements, extracted only¹           | clippy, cargo-audit, cargo-llvm-cov | ✅ clippy group        | ✅ cargo-audit native                         |
| C#       | `*.csproj`, `*.sln`                   | ✅ cobertura XML    | ⚠️ using declarations, extracted only¹       | dotnet-format (formatter)           | ❌ (no linter yet)     | ✅ dotnet list --vulnerable                   |
| Kotlin   | gradle/`*.gradle{.kts,}`, `*.kt`      | ✅ JaCoCo XML       | ⚠️ import statements, extracted only¹        | detekt, osv-scanner (Maven)         | ✅ detekt severity     | ✅ osv-scanner + OSV.dev (Maven)              |
| Java     | `pom.xml`, `src/main/java/`, `*.java` | ✅ JaCoCo XML       | ⚠️ import statements, extracted only¹        | PMD, osv-scanner (Maven)            | ✅ PMD priority tiers  | ✅ osv-scanner + OSV.dev (Maven)              |
| Ruby     | `*.rb`                                | ✅ SimpleCov JSON   | ⚠️ require/require_relative, extracted only¹ | rubocop, bundler-audit, osv-scanner | ✅ rubocop severity    | ✅ bundler-audit + osv-scanner (Gemfile.lock) |

¹ Rust, C#, Kotlin, Java, and Ruby packs populate `imports.extracted` but the file-level resolver is a no-op — Rust's `use` paths, C#'s `using` namespaces, Kotlin's and Java's `import` package paths, and Ruby's dynamic `require` semantics don't map 1:1 to source files. Downstream analyses that need an edge graph (reachability for dep-vulns, import-graph credit for test-gaps) degrade to conservative defaults for these five languages. Resolvers are planned; see Phase 10i-L.2 in the roadmap.

✅ full support. Multi-language repos fully supported — every detected language's tools run, and dep-vuln counts aggregate across all language packs via the `depVulns` capability (pip-audit findings don't silently replace npm-audit ones).

**Severity enrichment.** Scanners that don't publish per-finding severity (pip-audit, govulncheck) are enriched via the OSV.dev API. DXKit ships a complete CVSS v4.0 base-score calculator (macrovector lookup + severity-distance refinement, ported from [FIRST's reference implementation](https://github.com/FIRSTdotorg/cvss-v4-calculator)) since modern CVEs (2025+) increasingly publish v4 vectors exclusively. Unreachable IDs keep the scanner's legacy default bucket — the analyzer never fails because OSV was slow.

**Lint severity tiering.** Every lint finding is categorized into critical/high/medium/low by rule ID, linter name, or lint group. The `lint` capability envelope carries the tiered counts; `HealthReport.dimensions.quality.details` collapses them into an `"N errors, M warnings"` rendering (critical + high → errors, medium + low → warnings) for human readability. Consumers that want finer granularity read `report.capabilities.lint.counts` directly.

---

## Scaffolding Mode

Running `init` auto-detects your tech stack and generates a complete `.claude/` directory with 4 active + 17 opt-in agents, 30 slash commands, skills, path-scoped rules, and hooks.

```
.claude/
  settings.json            # Permissions, deny list, learning hooks
  agents/                  # Active agents (auto-trigger on matching questions)
    knowledge-bot.md       # Answers codebase questions
    onboarding.md          # Interactive onboarding buddy
    quality-reviewer.md    # Reviews code before committing
    doc-writer.md          # Audits and writes documentation
  agents-available/        # 17 dormant agents (activate with /enable-agent)
  commands/                # 30 slash commands
  skills/                  # Domain knowledge
  rules/                   # Path-scoped rules (per language + framework)
CLAUDE.md                  # Main context file for Claude Code
.ai/
  sessions/                # Session checkpoints
  features/                # Feature-planning docs produced by `/feature`
.dxkit/
  reports/                 # Generated analyzer output (health, bom, licenses, …)
.dxkit-ignore              # Extra analyzer-only exclusions (on top of .gitignore)
.dxkit-suppressions.json   # Silence known-false positives (gitleaks, semgrep)
```

The `.dxkit/` directory holds analyzer state and was split out from `.ai/` in v2.3.0 so tool output (regeneratable, safe to gitignore) is separated from agent context (session history, feature plans).

### Slash commands → native CLI delegation

The scaffolded slash commands (`/health`, `/vulnerabilities`, `/test-gaps`, `/quality`, `/dev-report`) use a three-tier fallback:

1. **Check for an existing report** in `.dxkit/reports/` from today
2. **Run `vyuh-dxkit <command>`** — deterministic, fast, same output
3. **Fall back to LLM analysis** only if the CLI isn't available

This means slash commands return the same report whether invoked by a human or an agent — and the analysis is reproducible across runs.

### Init flags

| Flag         | Description                                           |
| ------------ | ----------------------------------------------------- |
| `--detect`   | Auto-detect stack, minimal prompts                    |
| `--yes`      | Accept all defaults                                   |
| `--dx-only`  | Just `.claude/` + `CLAUDE.md` (default)               |
| `--full`     | Everything: DX + quality + hooks + CI                 |
| `--force`    | Overwrite existing files (except evolving ones)       |
| `--stealth`  | Gitignore generated files (local-only, not committed) |
| `--name <n>` | Override project name                                 |
| `--no-scan`  | Skip codebase analysis                                |

### Stealth mode

`--stealth` keeps DXKit local: `.claude/`, `.ai/`, `CLAUDE.md` added to `.gitignore`, only `.githooks/` committed so all devs get the hooks without committing the scaffold.

---

## CI + Hooks

### Pre-commit (set up automatically by `init --full` or husky)

```
architecture check    → validates imports + tool-registry + exclusions rules
slop check            → blocks new console.log, `: any`, debugger, committed temp files
lint-staged           → eslint --fix + prettier --write on changed files
typecheck             → tsc --noEmit
```

### Pre-push

```
build                 → ensure dist/ is current
tests with coverage   → vitest run --coverage (or equivalent per language)
coverage threshold    → scripts/check-coverage.sh; fails below configurable threshold
```

### PR CI (`.github/workflows/ci.yml`)

Mirrors pre-push but also runs the slop check against the PR base branch, so `--no-verify` can't ship code that introduces slop. `DXKIT_SLOP_BASE=origin/<base_ref>` flips `check-slop.sh` into diff-vs-base mode.

---

## Scoring

dxkit produces a 0-100 score + A/B/C/D/E letter rating for six
dimensions of every codebase. Three properties define the scoring
model:

- **Deterministic** — pure-function evaluator over a declarative spec
  per dimension. Same `git rev-parse HEAD` + same dxkit version
  produces the identical score on every run, every machine. This is
  the moat against LLM-driven review products, where outputs drift
  run-to-run.
- **Anchored** — methodology cites underlying open international
  standards (ISO/IEC 25010, ISO/IEC 5055, SQALE method, CVSS v4,
  CWE, OWASP, OpenSSF Scorecard) rather than invented thresholds.
- **Actionable** — every score is paired with structured provenance
  so the report says what to fix and how much the score would lift.
  Customer-facing markdown surfaces a "Top actions" block per
  dimension; agents consume the same structured `ScoreResult` JSON
  directly.

The customer-facing methodology document — including the per-
dimension penalty/cap breakdown and citations — lives at
**[`docs/SCORING.md`](docs/SCORING.md)**.

---

## Quality Gates for Agent-Written Code

dxkit's guiding principle: **deterministic guardrails that catch bad output regardless of who wrote it.** Scaffolded hooks + CI give every repo:

1. **Pre-commit** — fast local checks (architecture, slop, lint, typecheck)
2. **Pre-push** — thorough local checks (full suite + coverage threshold)
3. **PR CI** — unbypassable server-side checks (everything above + slop-vs-base + pack-dry)
4. **Coverage threshold** — enforced at both local and CI tiers; agents can't silently lower it

The same pattern is what dxkit itself uses. See `scripts/check-coverage.sh` + `scripts/check-slop.sh`.

---

## Library API

dxkit exports functions for programmatic use by downstream packages (e.g. `@vyuhlabs/create-devstack`):

```typescript
import { detect, processTemplate, TemplateEngine } from '@vyuhlabs/dxkit';
import { hasProjectYaml, readProjectYaml } from '@vyuhlabs/dxkit';

const stack = detect('/path/to/project');

if (hasProjectYaml('/path/to/project')) {
  const config = readProjectYaml('/path/to/project');
}

const output = processTemplate('Hello {{PROJECT_NAME}}', vars, conditions);
```

The CLI binary (`vyuh-dxkit`) is separate; the library import is for build-time and programmatic consumers.

---

## Two Workflows

### Fix Loop: Reports → KPIs → Plans → Execution

```bash
# 1. Scaffold into an existing repo
npx @vyuhlabs/dxkit init --detect --yes

# 2. Run analyzers (any of these work standalone too)
/health                                 # Codebase health (6 dimensions)
/vulnerabilities                        # Security scan
/test-gaps                              # Untested critical code

# 3. Generate improvement plans
/plan                                   # Proposes KPIs + actionable plans

# 4. Execute plans with session management
/execute-plan security                  # Work through security fixes

# 5. Track progress
/dashboard                              # HTML dashboard with all reports
```

### Feature Loop: Description → Design → Plan → Build

```bash
/feature add user roles with admin, editor, viewer tiers
# Agent reads codebase, finds similar patterns, generates:
# .ai/features/user-roles.md with full implementation plan

/build-feature user-roles
# Agent executes tasks: model → migration → repository → service → tests → controller
# Session checkpoints after each task
```

Both loops use the session framework — checkpoints, skill evolution, progress tracking.

---

## Reports

All analyzer commands save timestamped reports to `.dxkit/reports/`.
Every command writes a summary markdown, a detailed markdown, and a
canonical detailed JSON. `bom` adds an XLSX; `licenses` adds an XLSX
when `--xlsx` is set. `dashboard` (or `report`) writes the single-file
HTML view that stitches everything together.

```
.dxkit/reports/
  health-audit-<date>.md                    # 6-dimension summary
  health-audit-<date>-detailed.md           # with per-dim plans + evidence
  health-audit-<date>-detailed.json         # agent-consumable schema

  vulnerability-scan-<date>.md
  vulnerability-scan-<date>-detailed.{md,json}

  test-gaps-<date>.md
  test-gaps-<date>-detailed.{md,json}

  quality-review-<date>.md
  quality-review-<date>-detailed.{md,json}

  developer-report-<date>.md
  developer-report-<date>-detailed.{md,json}

  bom-<date>.md                             # Bill of Materials summary
  bom-<date>-detailed.{md,json}             # full per-package rows
  bom-<date>.xlsx                           # 15-col XLSX (with --xlsx)

  licenses-<date>.md                        # license inventory
  licenses-<date>-detailed.{md,json}
  licenses-<date>.xlsx                      # with --xlsx

  dashboard.html                            # single-file HTML view
```

Export options:

- **HTML dashboard**: `vyuh-dxkit dashboard` or the `/dashboard` slash command — dark-themed sidebar navigation, reads every `*-detailed.json` under `.dxkit/reports/`
- **PDF**: `/export-pdf all` — converts every report to PDF
- **Structured JSON**: every command writes a `-detailed.json` unconditionally as of 2.4.7, so agents and dashboards always have the structured schema available

---

## Using with create-devstack

[`@vyuhlabs/create-devstack`](https://github.com/vyuh-labs/create-devstack) scaffolds dev environments (devcontainers, `.project.yaml`) and delegates to dxkit for everything else.

```bash
npm create @vyuhlabs/devstack my-project        # devcontainer + .project.yaml + dxkit init
```

When create-devstack writes `.project.yaml` before calling dxkit, detection and prompts are skipped.

---

## Smart Detection

- **Test runner** — Jest, Mocha, Vitest, Ava, Tap, pytest, go test
- **Framework** — LoopBack, Express, NestJS, FastAPI, Gin, etc. with framework-specific rules
- **Test presence** — counts + classifies (active, commented-out, empty, schema-only)
- **Multi-language** — detects all languages including Python from `.py` files (no config required)
- **Language breakdown** — file count per language via `cloc`

---

## CLI Reference

```bash
# Analyzer commands — each writes to .dxkit/reports/<name>-<date>.md + <name>-<date>-detailed.{md,json}
vyuh-dxkit health [path] [--with-coverage]     # 6-dimension score
vyuh-dxkit vulnerabilities [path]              # Security scan, ranked by composite risk
vyuh-dxkit test-gaps [path] [--with-coverage]  # Coverage + gaps + actions
vyuh-dxkit quality [path]                      # Slop + duplication + lint
vyuh-dxkit dev-report [path] [--since <date>]  # Git activity report
vyuh-dxkit licenses [path]                     # Dependency license inventory
vyuh-dxkit bom [path] [--filter=top-level]     # Bill of Materials + risk-ranked triage

# Coverage materialization (side-effecting — runs each pack's test runner)
vyuh-dxkit coverage [path] [--lang <id>] [--no-fail-fast]

# Dashboard + one-shot full audit
vyuh-dxkit dashboard [path]                    # render .dxkit/reports/ to a single HTML page
vyuh-dxkit report [path] [--with-coverage]     # run every analyzer + dashboard end-to-end

# Data conversion
vyuh-dxkit to-xlsx <json-file>        # render licenses/bom detailed JSON as 15-col XLSX

# Tool management
vyuh-dxkit tools                      # status
vyuh-dxkit tools install [--yes]      # install missing

# Scaffolding
vyuh-dxkit init [--detect|--yes|--full|--stealth|--force|--name <n>]
vyuh-dxkit update [--force|--rescan]  # re-generate (preserves evolving files)
vyuh-dxkit doctor                     # diagnose environment

# Meta
vyuh-dxkit --help
vyuh-dxkit --version
```

---

## How It Works

1. **Detection** — scans for config files, source files, and tools to determine languages, frameworks, and test runners
2. **Tool resolution** — `findTool()` checks PATH → brew → npm-g → pipx → cargo → go → project `node_modules` → system probes (first match wins)
3. **Gather metrics** — each analyzer calls its registered tools and parses structured output (JSON wherever possible)
4. **Score** — deterministic formulas map metrics to 0–100 per dimension
5. **Report** — markdown for humans, JSON for agents

No LLM in the analysis path. Scores are reproducible: same repo state → same report.

---

## Community + Contributing

- **[`CHANGELOG.md`](CHANGELOG.md)** — release notes by version,
  including methodology shifts that may change scores between
  releases (e.g. the 2.4.7 scoring foundation).
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — local setup, the
  pre-commit hook stack, test conventions, and the "Adding a new
  language" walkthrough.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — a short tour
  of the analyzer data flow, the three core patterns (language
  packs, scoring specs, centralized exclusions + tool registry),
  the subprocess discipline, and the `AnalysisResult` cache.
- **[`CLAUDE.md`](CLAUDE.md)** — the authoritative architectural
  rule set with pre-commit + CI enforcement. Required reading
  before opening a PR that touches scoring, packs, exclusions, or
  tool invocation.
- **[`docs/SCORING.md`](docs/SCORING.md)** — full scoring
  methodology: dimensions, weights, thresholds, caps, and the
  Layer-1 standards each spec anchors to.
- **[`SECURITY.md`](SECURITY.md)** — security policy, supported
  versions, response SLAs, and the [private vulnerability
  reporting](https://github.com/vyuh-labs/dxkit/security/advisories/new)
  channel.
- **[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)** — Contributor
  Covenant 2.1.

Bug reports, feature requests, and questions: file an
[issue](https://github.com/vyuh-labs/dxkit/issues/new/choose) using
one of the templates.

---

## License

MIT
