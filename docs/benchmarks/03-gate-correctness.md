# Study III — The gate is correct and reproducible

> Detailed write-up for the study summarized in
> [`docs/benchmarks.md`](../benchmarks.md). This is the **deterministic tier**:
> every number here is reproducible offline, with no API key, by anyone, using
> the harnesses already published in [`benchmarks/`](../../benchmarks/).

## Question

Does the gate reliably block net-new regressions, pass clean changes, and
grandfather pre-existing debt — every time, with the same input yielding the same
verdict?

## TL;DR

| Property            | Harness                     | Result                                  |
| ------------------- | --------------------------- | --------------------------------------- |
| Catch / false-block | `bench-guardrail.mjs`       | tp 3, fn 0, tn 2, fp 0 (catch 1, FB 0)  |
| Net-new isolation   | `bench-netnew-isolation.mjs`| 1 net-new isolated against 205 / 1,020  |
| Churn robustness    | `bench-matcher.mjs`         | 0 false regressions on shifts + renames |

These are controlled regression suites, not statistical estimates of scanner
recall. They establish correct behavior on seeded cases, not that the gate would
catch every possible regression in the wild.

## Substrate and pins

Two real, public repositories, each pinned:

- **OWASP NodeGoat** (Apache-2.0), commit `c5cb68a`. dxkit baseline: 205
  findings.
- **strapi/strapi** (community MIT, with `ee/` directories under a commercial
  Enterprise license), commit `dc49217`. dxkit baseline: 1,020 grandfathered
  brownfield items.

The harnesses are repository-agnostic; any git repository with a dxkit baseline
runs. They force `committed-full` baseline mode, because dxkit auto-selects
ref-based mode on a public repository, which would re-gather the prior side on
demand and defeat the frozen-baseline design.

## Method and results

### 1. Confusion matrix (`bench-guardrail.mjs`)

Seeds three known regressions (a SAST eval injection, a command injection, and a
private-key secret) plus two clean edits, then builds a confusion matrix of the
gate's verdicts.

Result on both repositories: **tp 3, fn 0, tn 2, fp 0** — every seeded regression
blocked, every clean edit passed. `catchRate` 1, `falseBlockRate` 0.

### 2. Net-new isolation (`bench-netnew-isolation.mjs`)

Grandfathers all pre-existing debt, then introduces exactly one net-new finding,
and checks the gate isolates that one finding rather than losing it in the noise
of the existing debt.

| Repo     | Grandfathered debt | Net-new isolated | Fix-to-green tax (no baseline → dxkit) |
| -------- | ------------------ | ---------------- | -------------------------------------- |
| NodeGoat | 205                | 1/1 (winRate 1)  | 206 → 1                                 |
| Strapi   | 1,020              | 1/1 (winRate 1)  | 1,021 → 1                              |

The "fix-to-green tax" is the number of findings a developer would have to clear
to get a green check: without a baseline, all pre-existing debt blocks (206 /
1,021 items); with the dxkit baseline, only the single net-new finding blocks (1
item). This is the brownfield value — only regressions block.

### 3. Churn robustness (`bench-matcher.mjs`)

Applies mechanical churn that introduces no finding — comment-insert line shifts
and file renames — and checks that no existing finding is falsely re-flagged as
net-new.

Result: **`falseRegressionRate` 0** on both repositories. On Strapi this held
over a baseline containing 15 duplication findings (all 15 kept their identity
through the churn); on NodeGoat, over 5 duplication findings.

## Caveats and retractions

- **These are seeded regression suites, not recall estimates.** They show the
  gate behaves correctly on the seeded cases, not that it catches every possible
  regression in the wild.
- **The matcher had a 50% defect in dxkit 2.11.1** — a duplication-identity bug.
  This bench caught it: `bench-matcher.mjs` reported `falseRegressionRate` 0.5 on
  2.11.1. Version 2.12.0 fixed it as a class, with content-anchored identity and a
  property-based contract test over every finding kind, and the rate returned to
  0. **The benchmark drove the release** — a worked example of the benchmark
  suite functioning as a product feedback loop.

## Reproduce it

These run offline today. From the repository root, with a dxkit baseline on your
checkout:

```bash
git clone https://github.com/OWASP/NodeGoat /tmp/nodegoat
git -C /tmp/nodegoat checkout c5cb68a
cat > config.json <<'EOF'
{ "repoDir": "/tmp/nodegoat", "pinnedCommit": "c5cb68a" }
EOF

node benchmarks/bench-guardrail.mjs config.json         # -> matrix tp3 fn0 tn2 fp0
node benchmarks/bench-netnew-isolation.mjs config.json  # -> debtTotal 205, winRate 1
node benchmarks/bench-matcher.mjs config.json           # -> falseRegressionRate 0
```

Full instructions, including the Strapi setup, are in
[`benchmarks/README.md`](../../benchmarks/README.md).

## Provenance

dxkit 2.13.0, harness commit `7f801a4`, June 2026. Raw data: `guardrail-2120.json`,
`netnew-isolation-2120.json` / `strapi-netnew-isolation-2120.json`,
`matcher-2120.json` / `strapi-matcher-2120.json`, plus `matcher-2111.json` for the
pre-fix 50% defect.
