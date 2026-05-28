# DXKit User Guide

Deterministic code-health analysis for 8 language ecosystems
(Python, TypeScript, Go, Rust, C#, Kotlin, Java, Ruby).

## Start here

**[Getting started](getting-started.md)** — install dxkit, install the
tools it drives, run your first report.

## Commit-time guardrails

Capture today's findings as a baseline; every PR after that is diffed
against the baseline so new regressions block while existing debt is
allowed to remain. Wire it into pre-push and a GitHub Actions PR-gate
in one command (pre-commit is opt-in via `--with-precommit-hook`).

```bash
npm init @vyuhlabs/dxkit        # canonical first install (since 2.5.1)
vyuh-dxkit baseline create      # capture today's state
```

Hook activation is automatic via the postinstall chain (no manual
`git config core.hooksPath .githooks` step needed). If you ever need
to re-activate manually: `vyuh-dxkit hooks activate`.

| Command                                         | What it does                                                   |
| ----------------------------------------------- | -------------------------------------------------------------- |
| [`baseline create`](commands/baseline.md)       | Write per-finding identities to `.dxkit/baselines/<name>.json` |
| [`baseline show`](commands/baseline.md)         | Pretty-print or filter the on-disk baseline                    |
| [`guardrail check`](commands/guardrail.md)      | Diff current scan vs. baseline; block on net-new regressions   |
| [`allowlist add`](commands/allowlist.md)        | Suppress a specific finding (typed category + reason + expiry) |
| [`allowlist audit`](commands/allowlist.md)      | Surface stale / soon-to-expire / missing-rationale entries     |
| [`.dxkit/policy.json`](configuration/policy.md) | Tune which classifications block vs. warn                      |

## What you can run

Once dxkit + its tools are installed, here's the command surface:

| Command                                                          | Question it answers                                           | Typical runtime                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| [`health`](commands/health.md)                                   | "What's the overall shape of this codebase?"                  | 1-4 min                            |
| [`vulnerabilities`](commands/vulnerabilities.md)                 | "What security issues are there?"                             | 1-3 min                            |
| [`test-gaps`](commands/test-gaps.md)                             | "Which untested files are riskiest?"                          | 30-90 sec                          |
| [`quality`](commands/quality.md)                                 | "Where's the technical debt + duplication?"                   | 1-8 min (jscpd is the long-pole)   |
| [`dev-report`](commands/dev-report.md)                           | "Who's working on what, where are the hot files?"             | 5-30 sec                           |
| [`licenses`](commands/licenses.md)                               | "What licenses are in my dependency tree?"                    | 30-60 sec                          |
| [`bom`](commands/bom.md)                                         | "Full dependency × license × CVE × upgrade view"              | 1-3 min                            |
| [`coverage`](commands/coverage.md)                               | "Materialize real line-coverage data"                         | varies (runs your tests)           |
| [`dashboard`](commands/dashboard.md)                             | "Single HTML view of everything I've run"                     | < 5 sec (renders existing reports) |
| [`explore`](commands/explore.md)                                 | "What does this repo do / where does X live?"                 | < 5 sec (queries the graph)        |
| [`context`](commands/context.md)                                 | "Token-budgeted structural slice for an LLM"                  | < 5 sec (queries the graph)        |
| [`report`](commands/report.md)                                   | "Run all of the above in one shot"                            | 5-30 min                           |
| [`tools`](commands/tools.md)                                     | "What tools are detected / missing?"                          | < 5 sec                            |
| [`doctor`](commands/doctor.md)                                   | "Why is X not working?"                                       | < 5 sec                            |
| [`init`](commands/init.md)                                       | "Scaffold a new project with dxkit pre-configured"            | 5-30 sec                           |
| [`update`](commands/update.md)                                   | "Re-generate scaffolded files, preserving customizations"     | 5-30 sec                           |
| [`upgrade`](commands/upgrade.md)                                 | "Plan + execute a dxkit version upgrade (binary + scaffold)"  | 1-3 min                            |
| [`to-xlsx`](commands/to-xlsx.md)                                 | "Convert a licenses/bom JSON report to 15-col XLSX"           | < 5 sec                            |
| [`baseline create`](commands/baseline.md)                        | "Capture today's findings as a brownfield anchor"             | 30s-2m                             |
| [`baseline show`](commands/baseline.md)                          | "Inspect/filter the on-disk baseline"                         | < 1 sec                            |
| [`guardrail check`](commands/guardrail.md)                       | "Block on net-new regressions vs. the baseline"               | 30s-2m                             |
| [`setup-branch-protection`](commands/setup-branch-protection.md) | "Mark `dxkit-guardrails` as required check on default branch" | < 5 sec                            |
| [`setup-prebuild`](commands/setup-prebuild.md)                   | "Configure Codespaces prebuild (cold-start ~7 min → ~30s)"    | < 5 sec                            |
| [`allowlist`](commands/allowlist.md)                             | "Suppress a specific finding with typed reason + expiry"      | < 1 sec                            |
| [`issue`](commands/issue.md)                                     | "Open a pre-filled GitHub Issue against dxkit"                | < 5 sec                            |

## Configuration

- [`.dxkit-ignore`](configuration/dxkit-ignore.md) — exclude paths from
  analysis (same syntax as `.gitignore`)
- [`dxkit.yml`](configuration/dxkit-yml.md) — per-project overrides
  (force-activate a pack, pin a language version)
- [`.dxkit/policy.json`](configuration/policy.md) — brownfield policy
  for `guardrail check`: which classifications block, confidence
  thresholds, per-finding-kind block rules
- [Language packs](configuration/language-packs.md) — how dxkit detects
  your stack and which tools it activates per language

## Scoring methodology

dxkit's 0-100 dimension scores and A/B/C/D/E letter ratings follow
an open, deterministic, anchored methodology — every threshold and
penalty has a citation back to an underlying international standard.

**[Scoring methodology](SCORING.md)** — full per-dimension breakdown,
cap-tier taxonomy, citations (ISO/IEC 25010, ISO/IEC 5055, SQALE,
CVSS v4, CWE, OpenSSF Scorecard), and reproducibility guide.

If you script against dxkit's JSON report output, the
**[2.4.7 scoring migration guide](MIGRATING-TO-2.4.7-SCORING.md)**
documents the new optional fields and the `grade` → `rating` rename.

## Reading the output

Most commands produce two artifacts in `.dxkit/reports/`:

- `<name>.md` — short summary, designed to be read by humans
- `<name>-detailed.md` + `<name>-detailed.json` — full evidence,
  ranked remediation actions, machine-readable shape

Run `vyuh-dxkit dashboard` after a few reports exist to assemble them
into a single browsable HTML view (`.dxkit/reports/dashboard.html`).

## Getting help

```bash
vyuh-dxkit --help          # top-level command list
vyuh-dxkit doctor          # diagnose missing tools or misconfig
```

Issues + feedback: <https://github.com/anthropics/claude-code/issues>
