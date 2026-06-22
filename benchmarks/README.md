# dxkit deterministic benchmark harnesses

These are the offline, no-API-key harnesses behind the deterministic tier of
[`docs/benchmarks.md`](../docs/benchmarks.md). They establish that the gate
behaves correctly on controlled, seeded cases: it blocks net-new regressions,
passes clean edits, grandfathers pre-existing debt, isolates a single net-new
finding against a large baseline, and does not false-block on mechanical churn.

Three harnesses are included.

- `bench-guardrail.mjs` seeds known regressions (a SAST eval injection, a command
  injection, and a private-key secret) and clean edits, then builds a confusion
  matrix of the gate's verdicts.
- `bench-netnew-isolation.mjs` grandfathers all pre-existing debt, introduces
  exactly one net-new finding, and checks that the gate isolates that one finding
  rather than losing it in the noise of the existing debt.
- `bench-matcher.mjs` applies churn that introduces no finding (line shifts and
  file renames) and checks that no finding is falsely re-flagged as net-new.

The agent-driven studies in the report (loop safety, the LLM-as-gate comparison,
and the graph-context sessions) require a model API or subscription and the
pinned repository checkouts. Their harnesses are published in
[`agentic/`](agentic/) with their own README and verbatim prompts; see that
directory for how to run them and which numbers each produces.

## Requirements

- Node.js 20 or newer.
- A dxkit binary. If you have built this repository (`npm run build`), the
  harnesses use `dist/index.js` automatically. Otherwise they fall back to the
  published CLI via `npx --yes @vyuhlabs/dxkit`. You can override the binary with
  the `DXKIT` environment variable.
- A target git repository, checked out at a fixed commit. The numbers in the
  report come from two public repositories: OWASP NodeGoat at commit `c5cb68a`,
  and `strapi/strapi` at commit `dc49217`. The harnesses are repository-agnostic,
  so any git repository with a dxkit baseline will run.

## Running

Copy `config.example.json` to `config.json` and set `repoDir` to your checkout
and `pinnedCommit` to the commit to baseline against. Then run a harness with the
config path as its only argument.

```bash
# Reproduce the report's NodeGoat numbers.
git clone https://github.com/OWASP/NodeGoat /tmp/nodegoat
git -C /tmp/nodegoat checkout c5cb68a

cat > config.json <<'EOF'
{ "repoDir": "/tmp/nodegoat", "pinnedCommit": "c5cb68a" }
EOF

node benchmarks/bench-guardrail.mjs config.json
node benchmarks/bench-matcher.mjs config.json
node benchmarks/bench-netnew-isolation.mjs config.json
```

Each harness prints a JSON result to stdout. The harnesses force
`committed-full` baseline mode, because dxkit auto-selects ref-based mode on a
public repository, which would re-gather the prior side on demand and defeat the
frozen-baseline design.

## Expected results

On NodeGoat at `c5cb68a` (baseline of 205 findings), with dxkit 2.13.0:

- `bench-guardrail`: `matrix` of `tp 3, fn 0, tn 2, fp 0`, so `catchRate` 1 and
  `falseBlockRate` 0.
- `bench-netnew-isolation`: `debtTotal` 205, `isolationWinRate` 1, and a
  `fixToGreenTax` of 206 with no baseline against 1 with the dxkit baseline.
- `bench-matcher`: `falseRegressionRate` 0.

On `strapi/strapi` at `dc49217` (baseline of 1,020 findings), the matcher run
shows `falseRegressionRate` 0 over a baseline that contains 15 duplication
findings, and net-new isolation shows `debtTotal` 1,020 with `isolationWinRate`
1. Strapi is a large monorepo, so its baseline creation is slow.

These are controlled regression suites, not statistical estimates of recall.
They demonstrate that the gate behaves correctly on the seeded cases, not that it
catches every possible regression in the wild.
