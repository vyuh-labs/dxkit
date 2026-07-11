# DXKit User Guide

A Stop-gate for autonomous coding loops. dxkit baselines a repo's current
findings and blocks only the net-new ones a change introduces, running
locally with no model in the gate. The same deterministic core also powers
code-health analysis across 8 language ecosystems (Python, TypeScript, Go,
Rust, C#, Kotlin, Java, Ruby).

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

| Command                                            | What it does                                                    |
| -------------------------------------------------- | --------------------------------------------------------------- |
| [`baseline create`](commands/baseline.md)          | Write per-finding identities to `.dxkit/baselines/<name>.json`  |
| [`baseline show`](commands/baseline.md)            | Pretty-print or filter the on-disk baseline                     |
| [`guardrail check`](commands/guardrail.md)         | Diff current scan vs. baseline; block on net-new regressions    |
| [`checks`](commands/checks.md)                     | List / dry-run your custom repo-invariant + built-in lint gates |
| `flow`                                             | UI→API integration map + the broken-integration gate            |
| `schema` / `schema diff`                           | Data-model inventory + the schema drift gate (preview = gate)   |
| `ingest`                                           | Bring external SAST (SARIF) findings into the same gate         |
| `extensions`                                       | Run your own extractors/sinks through the gate (any language)   |
| `receipt`                                          | Emit the PR "dxkit signals" block (verdict + allowlist + score) |
| [`allowlist add`](commands/allowlist.md)           | Suppress a specific finding (typed category + reason + expiry)  |
| [`allowlist audit`](commands/allowlist.md)         | Surface stale / soon-to-expire / orphaned / missing-rationale   |
| [`allowlist export --snyk`](commands/allowlist.md) | Propagate Snyk-originated suppressions to a `.snyk` policy      |
| [`.dxkit/policy.json`](configuration/policy.md)    | Tune which classifications block vs. warn                       |

## What you can run

Once dxkit + its tools are installed, here's the command surface. This
table is generated from the capability registry, so it is complete by
construction; commands with a linked page have a full reference under
`docs/commands/`.

<!-- dxkit:command-table:begin — generated from src/discovery/command-defs.ts by `npm run docs:commands`; do not edit by hand -->

| Command                                                          | What it does                                                                     | Typical runtime                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| [`health`](commands/health.md)                                   | Run the deterministic 6-dimension health analysis                                | 1-4 min                            |
| [`vulnerabilities`](commands/vulnerabilities.md)                 | Run the deep security scan                                                       | 1-3 min                            |
| [`test-gaps`](commands/test-gaps.md)                             | Analyze test coverage gaps                                                       | 30-90 sec                          |
| `tests`                                                          | Select tests affected by a diff via the code graph                               | < 5 sec (queries the graph)        |
| [`quality`](commands/quality.md)                                 | Code quality + slop detection                                                    | 1-8 min (jscpd is the long-pole)   |
| [`dev-report`](commands/dev-report.md)                           | Developer activity analysis                                                      | 5-30 sec                           |
| [`licenses`](commands/licenses.md)                               | Dependency license inventory                                                     | 30-60 sec                          |
| [`bom`](commands/bom.md)                                         | Bill of Materials (licenses + vulnerabilities joined)                            | 1-3 min                            |
| [`coverage`](commands/coverage.md)                               | Run per-pack test-with-coverage (materializes the artifact)                      | varies (runs your tests)           |
| [`dashboard`](commands/dashboard.md)                             | Render .dxkit/reports/ into one HTML dashboard                                   | < 5 sec (renders existing reports) |
| [`report`](commands/report.md)                                   | Full audit (report), or publish/read a score snapshot (report snapshot\|history) | 5-30 min                           |
| `metrics`                                                        | Findings the gate stopped before merge + the score-over-time trend               | < 5 sec                            |
| [`baseline`](commands/baseline.md)                               | Capture / publish / show per-finding baselines for the guardrail                 | 30 sec - 2 min                     |
| [`guardrail`](commands/guardrail.md)                             | Diff current scan vs baseline; block on net-new regressions                      | 30 sec - 2 min                     |
| `receipt`                                                        | Emit the PR "dxkit signals" block (verdict + allowlist + score delta)            | < 30 sec                           |
| [`allowlist`](commands/allowlist.md)                             | Suppress / audit individual findings with typed reasons                          | < 1 sec                            |
| `ingest`                                                         | Ingest external SAST (SARIF) findings as first-class                             | varies (reads engine SARIF)        |
| [`loop`](commands/loop.md)                                       | Autonomous-loop utilities (doctor / ledger / snapshot)                           | < 5 sec                            |
| [`checks`](commands/checks.md)                                   | List / dry-run your custom repo-invariant + lint gates                           | varies (runs your checks)          |
| `extensions`                                                     | Plug your own extractors and sinks into dxkit (any language)                     | seconds (the `dev` loop)           |
| `schema`                                                         | Data-model inventory + the schema drift gate                                     | 5-30 sec                           |
| `flow`                                                           | UI→API integration mapping + the broken-integration gate                         | 5-30 sec                           |
| [`explore`](commands/explore.md)                                 | Repo exploration via the code graph                                              | < 5 sec (queries the graph)        |
| [`context`](commands/context.md)                                 | Slim structural code slice for a query (token-efficient)                         | < 5 sec (queries the graph)        |
| [`reviewers`](commands/reviewers.md)                             | Suggest reviewers via the active-owner model                                     | < 5 sec                            |
| `demo`                                                           | Offline, no-API demonstration walkthroughs                                       | 1-2 min (interactive walkthrough)  |
| [`init`](commands/init.md)                                       | Install dxkit agent DX in this repo                                              | 5-30 sec                           |
| [`update`](commands/update.md)                                   | Re-generate managed files (preserves your edits)                                 | 5-30 sec                           |
| `uninstall`                                                      | Remove dxkit, restoring the exact pre-dxkit state                                | < 30 sec                           |
| [`doctor`](commands/doctor.md)                                   | Verify setup — and recommend capabilities you are not using                      | < 5 sec                            |
| `configure`                                                      | Compute + apply a deterministic config plan for this repo                        | < 30 sec                           |
| `capabilities`                                                   | List every dxkit capability + what this repo should adopt                        | < 5 sec                            |
| [`tools`](commands/tools.md)                                     | Show / install required analysis tools                                           | < 5 sec (list); install varies     |
| `hooks`                                                          | Activate the dxkit git hooks (core.hooksPath)                                    | < 5 sec                            |
| [`setup-branch-protection`](commands/setup-branch-protection.md) | Set up branch protection / required checks (dry-run by default)                  | < 5 sec                            |
| [`setup-prebuild`](commands/setup-prebuild.md)                   | Set up the devcontainer prebuild workflow                                        | < 5 sec                            |
| [`upgrade`](commands/upgrade.md)                                 | Plan / apply a dxkit version upgrade                                             | 1-3 min                            |
| [`issue`](commands/issue.md)                                     | Open a pre-filled GitHub issue against dxkit                                     | < 5 sec                            |
| [`to-xlsx`](commands/to-xlsx.md)                                 | Convert a dxkit JSON report to XLSX                                              | < 5 sec                            |

<!-- dxkit:command-table:end -->

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
- [The extension SDK](extension-sdk.md) — `@vyuhlabs/dxkit-sdk`, the frozen
  surface extensions build against (descriptor tables, wire schemas, the
  shared normalizer), and the effort ladder for extending dxkit

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

Issues + feedback: <https://github.com/vyuh-labs/dxkit/issues>
