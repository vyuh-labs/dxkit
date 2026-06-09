---
name: dxkit-reports
description: Run dxkit reports and explain their output, including the consolidated dashboard view. Use when the user asks "run health", "check security", "show me the dashboard", "open the dashboard", "tour the dashboard", "explain the dashboard", "what does this score mean", or anything about generating / interpreting dxkit analyzer output. Always reach for this skill even when the user names a specific subcommand (health, vulnerabilities, dashboard, bom, etc.) — running the command is only half of the value; the skill wraps the output with the right framing. Hands off to dxkit-action for fixing findings.
---

# dxkit-reports

This skill runs dxkit analyzers and reads their output back to the user. It's the "tell me how my codebase is doing" surface.

## Command map

| User asks | Command | Output |
|---|---|---|
| "Overall health" / "give me the score" | `npx vyuh-dxkit health` | 6-dimension score table + top actions per dimension |
| "Check security" / "find vulns" | `npx vyuh-dxkit vulnerabilities` | Code-level SAST + dep-vuln + secret findings, grouped by severity |
| "Test coverage gaps" | `npx vyuh-dxkit test-gaps` | Source files without matching tests, prioritized by architectural role |
| "Code quality" | `npx vyuh-dxkit quality` | Lint findings + duplication + slop score |
| "Who's been working on what" | `npx vyuh-dxkit dev-report` | Per-author activity, hot files, churn |
| "License inventory" | `npx vyuh-dxkit licenses` | Every dependency's declared license |
| "Bill of materials" | `npx vyuh-dxkit bom` | Licenses + dep vulnerabilities joined (15-col XLSX-ready output) |
| "Run everything" | `npx vyuh-dxkit report` | Every analyzer in one shot, ~3-5 min |
| "Show me the dashboard" | `npx vyuh-dxkit dashboard` | Single HTML view of all reports — opens at `.dxkit/reports/dashboard.html`, incl. an interactive **Graph** tab (code structure) |
| "What does this repo do / where is X" | `npx vyuh-dxkit explore <sub>` | Query the code graph: entry-points / hot-files / communities / file / feature / api-surface |
| "Token-efficient context for a query" | `npx vyuh-dxkit context <query>` | Slim structural slice for an LLM (also a fix-time hint via `--graph-context`) |

## Where output lands

Every analyzer writes to `.dxkit/reports/` with a date-stamped filename:

```
.dxkit/reports/
  health-2026-05-19.md
  health-2026-05-19.json
  vulnerability-scan-2026-05-19.md
  vulnerability-scan-2026-05-19-detailed.json
  ...
  dashboard.html
```

The `.md` files are human-readable; the `.json` files are machine-readable (for CI consumption or custom tooling). Reports are gitignored by default — they regenerate on every run.

## Reading the health report

The 6 dimensions each get an A-E grade. Below each grade the "top actions" list shows what would lift the score the most (sorted by potential uplift). Example:

```
Security: B (72)
  Top actions:
    1. Pin @types/node to ≥18.19.0 (closes 2 dep-vuln entries)
    2. Add gitleaks pre-commit hook (closes 1 secret-scan finding)
    3. Replace `Math.random()` in src/auth/token.ts (closes 1 SAST finding)
```

Score → rating: A ≥ 80, B ≥ 60, C ≥ 40, D ≥ 20, E < 20. **Cap tiers** can pin a score below its arithmetic value when trust is broken (e.g., uncommitted state caps at 79). The report explains the cap if one fires.

## Common patterns

### Quick health check (warm cache)

```bash
npx vyuh-dxkit health
```

Re-uses cached scanner outputs where possible. ~5-15s on warm cache, ~30-60s cold.

### Pre-merge audit (thorough)

```bash
npx vyuh-dxkit health --with-coverage   # Runs tests + materializes coverage before scoring
npx vyuh-dxkit vulnerabilities          # Always re-runs the deep security scan
npx vyuh-dxkit dashboard                 # Renders the latest reports into one HTML view
```

`--with-coverage` is slow (runs your test suite) but switches the Tests dimension from heuristic ("files match a test pattern") to real ("line coverage from your reporter"). Worth it for pre-merge audits.

### Per-PR scope

```bash
npx vyuh-dxkit guardrail check
```

Diffs the current scan vs the baseline. Exit 1 on net-new findings (the same logic the pre-push hook uses).

### Failing CI on a threshold

```bash
npx vyuh-dxkit health --fail-on-score=70                 # Exit 1 if overall score < 70
npx vyuh-dxkit vulnerabilities --fail-on-severity=high   # Exit 1 if any high-severity finding
```

Use these in CI for hard floors.

## Reading dependency findings

`vulnerabilities` (and `bom`) carry severity + CVSS where available. The severity column is computed via OSV.dev's enrichment — when OSV reports no severity, dxkit assigns one via CVSS v4.0 base-score math (see `src/analyzers/tools/cvss-v4.ts`).

When the user asks "is this CVE worth fixing today" the answer depends on:
1. **Reachability** — does the codebase actually call the vulnerable function? (Today: heuristic via graphify call-graph; reachability tiers are a roadmap item.)
2. **Exploitability** — public PoC? Authentication required? Network exposure?
3. **Patch availability** — is there a fixed version?

Surface those three when summarizing a dep-vuln finding. The detailed JSON has the OSV/GHSA reference URL — link to it.

## When the user wants to ACT on findings

Hand off to the `dxkit-action` skill — that's the workflow for prioritizing + fixing + re-baselining. This skill stops at "here's what's wrong." For a dimension-focused push, hand to the specialist generator skills instead: **dxkit-test** to close test-gaps / raise the Tests score, **dxkit-docs** to write missing documentation.

## Troubleshooting

- **"Scanner X unavailable"** → run `npx vyuh-dxkit tools list` to see status; `npx vyuh-dxkit tools install` to install missing ones.
- **"N/A for this stack"** → applicability-guard fired (e.g., vitest-coverage on a mocha repo). Not a problem; the scanner doesn't apply here.
- **Report looks stale** → `.dxkit/reports/` is keyed by date. Re-run the analyzer to get a fresh date-stamped file.
- **Numbers don't match between two reports** → check whether `--with-coverage` was used. Without it, Tests dimension uses heuristic; with it, real coverage. They legitimately differ.
