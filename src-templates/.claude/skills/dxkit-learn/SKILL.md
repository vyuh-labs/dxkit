---
name: dxkit-learn
description: Answer questions about dxkit — what each scanner does, what a baseline is, what the 6 health dimensions score, how guardrails work. Use when the user asks "what does dxkit X do?", "what's a baseline?", "what's the slop score?", "how do hooks fit in?", or anything else about dxkit concepts.
---

# dxkit-learn

This skill explains how dxkit works. Reach for it when the user asks about dxkit concepts before they take an action.

## Mental model

dxkit measures a codebase along **6 dimensions** (Security, Code Quality, Tests, Documentation, Maintainability, Developer Experience) using deterministic scanners (gitleaks, semgrep, cloc, jscpd, graphify, ruff, eslint, …). Findings are anchored to a **baseline** (`.dxkit/baselines/main.json`) so today's pre-existing issues don't block tomorrow's PR. A **guardrail check** diffs current state against the baseline and blocks net-new regressions. Hooks + CI wire the guardrail into the developer's workflow.

The three contracts to remember:

1. **Baseline = the brownfield anchor**. Pre-existing findings are recorded once; future scans only block on *additions*.
2. **Hooks fire fast (pre-push); CI fires thorough**. Both use the same guardrail logic.
3. **Reports are deterministic** — same code + same baseline = same findings. The salt mode (`deterministic` vs `random`) controls per-finding identity stability across runs.

## The 6 dimensions

Each dimension is a 0-100 score with letter grade (A≥80, B≥60, C≥40, D≥20, E<20):

| Dimension | What scores it down |
|---|---|
| **Security** | Secret leaks (gitleaks), SAST findings (semgrep), dependency vulns (osv-scanner / npm-audit / pip-audit / etc.), TLS-bypass patterns |
| **Code Quality** | Lint findings (eslint / ruff / golangci-lint / clippy / detekt / rubocop / dotnet-format), high duplication (jscpd), code-pattern slop |
| **Tests** | Missing test coverage on primary-architecture files; missing test runner config; below-threshold line coverage |
| **Documentation** | Missing/empty README; missing doc-comments on public APIs (XML-doc/JSDoc/TSDoc/godoc/etc.); below-threshold comment ratio |
| **Maintainability** | Function/file size outliers, deep cyclomatic complexity, god-objects, high orphan-module count, dead imports |
| **Developer Experience** | Missing `.gitignore` / `.editorconfig` / `package.json` engines pin / devcontainer / hooks / CI workflow |

Run `vyuh-dxkit health` to see all six at once. Each dimension report has a "top actions" list — the changes that would lift the score the most.

## The scanner toolchain

dxkit doesn't write parsers — it orchestrates established tools and computes scores. The full list is in `TOOL_DEFS` (or run `vyuh-dxkit tools list`). Key ones:

- **gitleaks** — secret scanning (API keys, AWS credentials, GitHub tokens)
- **semgrep** — multi-language SAST (auto config picks rulesets per active language pack)
- **cloc** — language-aware line counting (excludes comments + blanks)
- **jscpd** — copy-paste detection
- **graphify** — AST-based metrics (functions, classes, cohesion, god-nodes, dead imports)
- **osv-scanner** — dependency vulnerabilities (npm/pip/cargo/go/gem/maven via OSV.dev)
- Per-language linters: eslint (TS), ruff (Python), golangci-lint (Go), clippy (Rust), dotnet-format (C#), detekt (Kotlin), pmd (Java), rubocop (Ruby)

If a tool isn't installed, dxkit degrades gracefully (the affected dimension reports a partial score with a "missing tool" note instead of crashing).

## Baselines explained

A baseline is the per-finding identity snapshot of a scan. Every finding has a **fingerprint** (SHA-1[0:16] of file+rule+line-window+content). The baseline stores those fingerprints. The guardrail diffs today's scan against the baseline:

- Fingerprint in scan + in baseline → **existing** (ignored)
- Fingerprint in scan + NOT in baseline → **added** (blocks)
- Fingerprint in baseline + NOT in scan → **removed** (silently good)

That's why "fix a critical, leave the medium" works — the medium's fingerprint stays in the baseline; only net-new findings count.

Commands:

```bash
vyuh-dxkit baseline create               # Capture current state into .dxkit/baselines/main.json
vyuh-dxkit baseline show                 # Summarize what's recorded
vyuh-dxkit baseline show --kind secret   # Drill into a specific finding kind
vyuh-dxkit guardrail check               # Diff current scan vs baseline; exit 1 on net-new
```

## Hooks

Two hooks ship under `.githooks/`:

- **pre-push** (always-on under `--full`): runs the guardrail check before code leaves the developer's machine. Fast on warm scanner caches (~10-30s).
- **pre-commit** (opt-in via `--with-precommit-hook`): same logic, fires on every commit. Slower on large repos until incremental scanning lands.

Activation is wired via `npm postinstall` so `npm install` after `git clone` sets `core.hooksPath = .githooks` automatically.

## How to learn more

- `vyuh-dxkit <subcommand> --help` — flag reference
- `vyuh-dxkit baseline show` — what your repo already has recorded
- `.dxkit/reports/` — every analyzer's markdown + JSON output from the last run
- `vyuh-dxkit dashboard` — single HTML view of every report

When the user asks specifically about a scanner or a finding type, point them at the relevant report or run the relevant analyzer command directly.
