# dxkit benchmarks: methodology and findings

> A sanitized public report. The claim throughout is predictability rather than
> reduction. Every headline number is presented with its caveats, and the claim
> ledger and the "what this does not prove" section appear before the evidence.
>
> This page is the overview: the summary, the claim ledger, the shared
> methodology, and a short section per study. Each study links to a detailed,
> reproducible write-up under [`docs/benchmarks/`](./benchmarks/) with its full
> method, verbatim prompts, raw result tables, caveats, and repro steps.

---

## Summary

In our loop benchmark, autonomous coding loops (an agent that keeps editing
until it decides to stop) frequently stopped with detector-backed net-new debt
still present.

- A vanilla Claude Code-style loop left net-new debt in 11 of 16 runs.
- A prompt-only self-check still left it in 9 of 16 runs.
- With dxkit's Stop-gate, we observed 0 of 16 escapes.

Each figure is n=16 per arm, from 8 repetitions on each of two tasks.

The dxkit arm did not discover a new class of bugs. On every stop it re-ran a
deterministic net-new guardrail, blocked any stop that left debt in the tree,
and returned the specific finding to the model for repair.

The claim is predictability rather than universal reduction. Three independent
measurements share one through-line.

| Layer              | What it reduces                       | Result                                                       |
| ------------------ | ------------------------------------- | ------------------------------------------------------------ |
| Deterministic gate | unsafe final states                   | vanilla 11/16, checklist 9/16, dxkit 0/16 observed escapes   |
| Code graph         | observed large-repo exploration tails | worst-case session tokens 57% lower, variance roughly halved |
| Durable identity   | false "net-new" under churn           | 0 false net-new on tested line shifts and renames            |

dxkit is not a scanner; it ingests Snyk, CodeQL, and other SARIF sources. It is
not a token-saver, because mean token counts are often flat. It is not "more
accurate than an LLM": a frontier model can be an accurate judge when given
enough baseline state. In our benchmark, Opus-with-baseline held its accuracy,
but it was not cheap, reproducible, or in-loop.

---

## Claim ledger

Each claim below is listed with its strength, its evidence, and the exact public
wording we stand behind. This table is the place to start; the rest of the
document is the supporting evidence.

| Claim                                                 | Status          | Evidence                                           | Public wording                                                                               |
| ----------------------------------------------------- | --------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The Stop-gate prevents observed loop escapes          | Strong          | loop benchmark, 8 reps × 2 tasks                   | "0/16 observed escapes in our benchmark"                                                     |
| Prompt-only self-check is insufficient                | Strong          | checklist arm, 9/16 escapes                        | "prompting reduced but did not eliminate escapes"                                            |
| Fixing in the loop is cheaper than deferring it       | Moderate        | loop benchmark deferred arm, 8 reps × 2 tasks      | "deferring the same fix cost ~49% more on the test-gap task (mean); weak on the secret task" |
| Gate identity is deterministic under tested churn     | Strong          | offline matcher benches                            | "0 false net-new on tested line-shift and rename cases"                                      |
| LLM-as-gate has cost and reproducibility issues       | Strong          | gate-vs-LLM benchmark, 5 reps × 2 models × 2 repos | "an LLM can judge, but not cheaply or reproducibly in-loop"                                  |
| Graph context reduces observed large-repo token tails | Moderate–strong | Sonnet session study, 30 sessions                  | "lower mean, tail, and variance on a large repo"                                             |
| Test-gap gating is safe as a default                  | Not claimed     | repair cost of 1.1M–1.6M tokens in validation      | default remains `security-only`; `full-debt` is opt-in                                       |
| dxkit improves every agent session                    | Not claimed     | n/a                                                | do not say this                                                                              |
| dxkit detects more vulnerabilities than scanners      | Not claimed     | n/a                                                | do not say this                                                                              |

## What this does not prove

- The 0/16 result is observed, not proven-zero. The gate blocked every
  detector-backed finding surfaced in these seeded runs, which is not a proof
  that no escape is possible.
- dxkit is not a scanner and does not claim to find more bugs than Snyk, CodeQL,
  Semgrep, or a frontier model. It ingests their findings.
- The loop benchmark uses synthetic, detector-backed tasks together with small
  real-repo validation, not a CVE corpus.
- The loop headline includes test-gap behavior, which belongs to the opt-in
  `full-debt` preset. The product default, `security-only`, gates secrets and
  high-severity vulnerabilities (see [Study I](./benchmarks/01-loop-safety.md)).
- The cost-of-deferral signal is strong on the test-gap task and weak on the
  secret task (a positive mean but a slightly negative median); see
  [Study II](./benchmarks/02-cost-of-deferral.md).
- Graph context does not guarantee fewer tokens in every session. The measured
  effect is lower mean, tail, and variance on large, connected tasks.
- Opus session results are deferred. Session numbers are from Sonnet.

---

## The thesis: predictability rather than reduction

A scanner answers the question "what is wrong?" An autonomous loop needs a
different answer: "did I just make this worse, and may I stop?" That question
has to be answered the same way every time, in seconds, locally, with feedback
the model itself can act on. It is a systems property rather than a detection
problem, and it is the gap dxkit fills, in three parts.

1. A deterministic net-new gate. The same input yields the same verdict, as one
   exit code, at no LLM cost, offline. Pre-existing debt is grandfathered by a
   baseline, so only regressions block.
2. A code graph that reduces the agent's observed worst-case exploration cost,
   rather than lowering its average cost.
3. Durable, content-anchored finding identity that survives line shifts and
   renames, so that "net-new" continues to mean net-new and a committed baseline
   keeps matching across machines and CI.

---

## What dxkit is, and is not

dxkit is a deterministic verification and governance layer. It stitches together
established tools (gitleaks, community Semgrep, OSV and npm-audit, jscpd, a
code-graph builder, and cloc) and ingests external engines (Snyk Code, CodeQL,
and any SARIF source). On top of those it adds the layer they lack: a net-new
gate, a brownfield baseline, durable identity, and graph-scoped context.

It is not a scanner. dxkit does not claim to find more bugs than Snyk or CodeQL;
it ingests their findings and makes them enforceable. It is not a claim that the
LLM is wrong: given enough baseline state, a frontier model can judge net-new
findings accurately, and in our benchmark Opus-with-baseline did so. dxkit's
advantages are determinism, no LLM cost per check, a prompt
that does not grow with the baseline, and reproducible identity, all of which
hold regardless of model capability. Finally, it is not a token-saver. On a real
session the mean token count is often flat, and the measured benefit is a lower
observed worst case rather than a smaller average.

---

## Methodology (shared across studies)

Provenance. These results were produced with dxkit version 2.13.0, at report and
harness commit `7f801a4`, during June 2026, with model pricing as of June 2026.
Agent runs were executed through a Claude Max subscription, so per-run dollar
figures are the CLI's equivalent-cost estimates. They are valid for relative
comparison between arms rather than as literal API-console charges.

"Sanitized" here means that no proprietary code or private traces are included.
Public repository names and commit pins are disclosed for reproducibility.

Models. We used Claude Sonnet 4.6 for agent-session runs, and added Claude Opus
4.8 as a steelman in the gate-vs-LLM study. Sessions ran through `claude -p
--output-format stream-json` and were parsed from the raw event stream.

Substrates. Two real, public open-source repositories, each pinned to a commit.
These benchmarks run on pinned public commits and characterize the agent's
behavior under each tool, not the quality or security of these projects. dxkit is
an independent project, not affiliated with or endorsed by OWASP, Strapi, or any
benchmarked project; trademarks belong to their owners.

| Repository                                          | Pin       | License                                                             | Role           |
| --------------------------------------------------- | --------- | ------------------------------------------------------------------- | -------------- |
| [OWASP NodeGoat](https://github.com/OWASP/NodeGoat) | `c5cb68a` | Apache-2.0                                                          | small app      |
| [strapi/strapi](https://github.com/strapi/strapi)   | `dc49217` | Community "MIT Expat"; `ee/` directories under a commercial license | large monorepo |

- NodeGoat is a deliberately vulnerable Node.js/Express training app of roughly
  2k lines; the dxkit baseline contains 205 pre-existing findings.
- Strapi is a large TypeScript monorepo of roughly 574k lines; its code graph has
  18,948 nodes and 20,012 edges, and the dxkit baseline contains 1,020
  grandfathered brownfield items (overwhelmingly test-gaps, duplication, and
  quality debt rather than vulnerabilities).
- The loop-safety study also uses synthetic repositories: small and controlled,
  with one known finding injected per task.

Determinism tier. The gate-correctness benches run offline, with no API key,
using seeded regressions together with clean and churn commits, and produce a
confusion matrix. Anyone can re-run them.

Repetitions. The safety study uses 8 repetitions per arm per task; the session
study uses 3 repetitions per cell (30 sessions); the gate-vs-LLM study uses 5
repetitions per case across 2 models and 2 repositories. Point estimates without
repetitions are flagged as such.

Process. Several headline claims were retracted mid-study once they were traced
to harness bugs or to unlucky single draws; these are noted inline in the
per-study docs. The benchmarks also fed back into the product, and two findings
shipped as releases.

---

## The studies

Each study below has a detailed, reproducible write-up. The short version here is
the question, the headline, and the method in one line; follow the link for the
full method, verbatim prompts, raw tables, caveats, and repro steps.

### I. Loop safety and the Stop-gate → [details](./benchmarks/01-loop-safety.md)

**Question.** How often does an autonomous loop declare "done" while net-new debt
is still in the tree, and does a deterministic gate prevent it where a prompt
does not?

**Headline.** Observed escapes: vanilla **11/16 (69%)**, checklist (prompt-only)
**9/16 (56%)**, dxkit **0/16**. The dxkit arm blocked, the model repaired the
specific finding, and the loop re-stopped clean.

**Method.** `bench-loop.mjs`, four arms, two seeded traps (a test-gap and a
secret), 8 reps each, Sonnet 4.6, with an identical post-hoc guardrail measuring
the final tree. Validated on real NodeGoat.

### II. Cost of deferral → [details](./benchmarks/02-cost-of-deferral.md)

**Question.** A net-new finding gets fixed eventually; the choice is _when_. Is
fixing it in the warm loop cheaper than deferring it to a cold session?

**Headline.** Holding the finding constant, deferring the test-gap repair to a
cold session cost **~49% more in equivalent cost and ~51% more turns** (means).
On the secret task the mean premium was ~19% but the signal is weak (the median
is slightly negative). A conservative floor — real deferral costs more.

**Method.** The `dxkit` (in-loop) and `deferred` (vanilla + cold fix) arms of
`bench-loop.mjs`; both reach an identical clean final state, so this isolates the
cost of _when_ the fix happens.

### III. The gate is correct and reproducible → [details](./benchmarks/03-gate-correctness.md)

**Question.** Does the gate reliably block net-new regressions, pass clean
changes, and grandfather pre-existing debt, every time?

**Headline.** Confusion matrix tp 3 / fn 0 / tn 2 / fp 0 (catch 1, false-block 0)
on both repos; exactly 1 net-new finding isolated against 205 / 1,020
grandfathered items; **0 false regressions** on line-shift and rename churn. This
is the **deterministic tier** — reproducible offline today, no API key.

**Method.** Three offline harnesses already published in
[`benchmarks/`](../benchmarks/): `bench-guardrail.mjs`,
`bench-netnew-isolation.mjs`, `bench-matcher.mjs`. The matcher bench caught a 50%
identity defect in 2.11.1 that 2.12.0 fixed as a class.

### IV. Deterministic gate versus LLM-as-the-gate → [details](./benchmarks/04-gate-vs-llm.md)

**Question.** When asking "is my change safe to stop on?", should a deterministic
gate answer, or should an LLM be the gate? (Gate vs gate, not scanner vs scanner.)

**Headline.** dxkit: **100% accuracy, 0 flips, $0**, no prompt growth, at every
scale. The naive LLM false-blocked a pure rename and flip-flopped on a line shift
(40% of reps); Sonnet missed a real regression at the 1,020 baseline; Opus held
100% but cost ~6.5× Sonnet and grew with the baseline.

**Method.** `bench-llm-gate.mjs`, 10 seeded cases, 5 reps, Sonnet 4.6 + Opus 4.8,
baselines of 1 / 205 / 1,020, ≈$51 total.

### V. Graph context and observed exploration tails → [details](./benchmarks/05-graph-context.md)

**Question.** Does the passive code-graph context help a real agent session, net
of the scaffold's overhead?

**Headline.** On the large monorepo: median tokens roughly tied, **mean −30%,
worst case −57%, variance roughly halved**. On the small app: overhead ≈ zero.
The benefit is predictable tokens, not fewer tokens — and it is size-gated (54%
of files in a slicing proxy were _not_ smaller).

**Method.** `bench-context-efficiency.mjs` (200-symbol slicing proxy) and
`bench-sessions.mjs` (30 real `claude -p` sessions, Sonnet 4.6).

### VI. When the graph pays: an Amdahl model → [details](./benchmarks/06-amdahl-model.md)

**Question.** Why does the graph benefit appear on large repos and vanish on
small ones?

**Headline.** Model session savings as `f·(1 − 1/s) − O/T`: an infinite
per-operation speedup caps whole-session savings at the orientation fraction `f`,
and a fixed overhead `O/T` dominates on small repos (a forced-graph probe cost
66% more on the small app). A falsifiable model, not yet numerically fit.

**Method.** Analytical, explaining the Study V numbers. No harness.

---

## Differentiation: why not Snyk or SonarQube?

The difference is one of architecture and tempo, not detection. Cloud scanners
are detection engines on a CI cadence, and they were never built to sit inside an
agent's stop decision.

| What a loop's Stop-gate needs            | dxkit                               | Cloud scanners (Snyk Code, SonarQube) |
| ---------------------------------------- | ----------------------------------- | ------------------------------------- |
| Fires on every stop, in seconds, locally | yes: no LLM cost, offline, instant  | no: cloud round-trip, CI/PR cadence   |
| Offline, with no egress and no auth      | yes: local and deterministic        | no: upload-to-cloud, server-side gate |
| Feedback the model can act on            | yes: a block decision plus a reason | no: dashboards and PR comments        |
| Reproducible identity offline            | yes: content-anchored               | partial: "new code" defined on server |

A note on what not to claim, so that the comparison holds up. Do not say cloud
scanners cannot detect net-new findings, because SonarQube has a new-code quality
gate and Snyk has delta concepts. Do not say in-loop gating is impossible with
them, because one could shell a cloud scan inside a Stop hook; it would simply be
slow, networked, authenticated, and untuned to the loop's baseline. The accurate
statement is that cloud scanners are not architecturally designed for
per-iteration local gating, and that they are optionally a detection source dxkit
can ingest.

---

## Why now

Coding-agent workflows are moving from one-shot prompts to persistent loops. That
creates a new control problem: when may the loop stop? Tests and linters catch
broken code, but they do not distinguish known debt from net-new regressions, and
an LLM-judge gate adds cost, latency, and non-determinism on every iteration.
dxkit focuses on that stop decision.

---

## Limitations

- The study uses two real repositories together with synthetic cases. The seeded
  findings are detector-backed but do not constitute a CVE corpus, and broader
  language and repository generality is future work.
- dxkit does not improve on detection. It ingests Snyk and CodeQL rather than
  out-detecting them.
- The context-efficiency measurement is a proxy; the session study is the real
  test.
- The Opus session arm is deferred, and session numbers are from Sonnet.
- The Amdahl model is directional rather than a numerical fit.
- Several sub-claims were retracted once they were traced to harness bugs or
  single unlucky draws. They are documented in the per-study docs rather than
  buried.

---

## Artifacts and reproducibility

The **deterministic tier** runs offline today, with no API key:
[`benchmarks/`](../benchmarks/) holds `bench-guardrail.mjs`,
`bench-netnew-isolation.mjs`, and `bench-matcher.mjs`, and `benchmarks/README.md`
documents how to reproduce the [Study III](./benchmarks/03-gate-correctness.md)
numbers on the pinned NodeGoat and Strapi commits.

The **agent-driven harnesses** (loop safety, cost of deferral, gate-vs-LLM, and
the graph-context sessions) require a model subscription or API key and the
pinned checkouts. They are published under
[`benchmarks/agentic/`](../benchmarks/agentic/) — `bench-loop.mjs`,
`bench-llm-gate.mjs`, `bench-sessions.mjs`, and `bench-context-efficiency.mjs`,
with `benchmarks/agentic/README.md` documenting the config schema, the pinned
substrates, and the verbatim prompts. Because these are agent-in-the-loop
measurements, the reproducible claims are the **relative** results between arms
(escape rate, deferral premium, variance reduction, gate accuracy and flips), not
exact token counts.

---

## Try the deterministic tier on your own repository

These commands let you run dxkit's deterministic gate on your own repository.
They evaluate the gate locally; they do not reproduce the benchmark numbers
above.

```bash
npx @vyuhlabs/dxkit baseline create        # grandfather today's debt
npx @vyuhlabs/dxkit init --claude-loop     # wire the Stop-gate
npx @vyuhlabs/dxkit loop doctor            # confirm it is safe to run unattended
# then run your loop, and afterwards:
npx @vyuhlabs/dxkit loop ledger summarize  # blocked versus allowed, and repaired-after-block
```

To reproduce the deterministic-tier benchmark numbers themselves (gate
correctness, net-new isolation, and matcher robustness), see the harnesses and
instructions in [`benchmarks/`](../benchmarks/). A `vyuh-dxkit evaluate` command,
a one-shot "prove it on your repo" report, is the planned next step.
