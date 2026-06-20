# dxkit benchmarks: methodology and findings

> A sanitized public report. The claim throughout is predictability rather than
> reduction. Every headline number is presented with its caveats, and the claim
> ledger and the "what this does not prove" section appear before the evidence.

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

| Claim                                                 | Status          | Evidence                                           | Public wording                                              |
| ----------------------------------------------------- | --------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| The Stop-gate prevents observed loop escapes          | Strong          | loop benchmark, 8 reps × 2 tasks                   | "0/16 observed escapes in our benchmark"                    |
| Prompt-only self-check is insufficient                | Strong          | checklist arm, 9/16 escapes                        | "prompting reduced but did not eliminate escapes"           |
| Gate identity is deterministic under tested churn     | Strong          | offline matcher benches                            | "0 false net-new on tested line-shift and rename cases"     |
| LLM-as-gate has cost and reproducibility issues       | Strong          | gate-vs-LLM benchmark, 5 reps × 2 models × 2 repos | "an LLM can judge, but not cheaply or reproducibly in-loop" |
| Graph context reduces observed large-repo token tails | Moderate–strong | Sonnet session study, 30 sessions                  | "lower mean, tail, and variance on a large repo"            |
| Test-gap gating is safe as a default                  | Not claimed     | repair cost of 1.1M–1.6M tokens in validation      | default remains `security-only`; `full-debt` is opt-in      |
| dxkit improves every agent session                    | Not claimed     | n/a                                                | do not say this                                             |
| dxkit detects more vulnerabilities than scanners      | Not claimed     | n/a                                                | do not say this                                             |

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
  high-severity vulnerabilities (see study I).
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

- NodeGoat ([OWASP NodeGoat](https://github.com/OWASP/NodeGoat)) is a
  deliberately vulnerable Node.js and Express training application of roughly 2k
  lines (Apache-2.0), pinned at commit `c5cb68a`. Its vulnerabilities are
  intentional and publicly documented, which makes it a clean target for a
  net-new gate. The dxkit baseline contains 205 pre-existing findings. It is
  referred to below as the "small app."
- Strapi ([strapi/strapi](https://github.com/strapi/strapi)) is a large
  TypeScript monorepo of roughly 574k lines (Yarn and Nx), pinned at commit
  `dc49217`. Its code graph has 18,948 nodes and 20,012 edges. The dxkit baseline
  contains 1,020 grandfathered brownfield items, which are overwhelmingly
  test-gaps, duplication, and quality debt rather than vulnerabilities; this is
  the pre-existing debt the gate grandfathers so that only regressions block. It
  is referred to below as the "large monorepo."
- The loop-safety study also uses synthetic repositories: small and controlled,
  with one known finding injected per task.

Independence and trademarks. dxkit is an independent project. It is not
affiliated with or endorsed by OWASP, Strapi, or any benchmarked project, and
trademarks belong to their owners. The benchmarks run on pinned public commits
and characterize the agent's behavior under each tool, not the quality or
security of these projects.

Determinism tier. The gate-correctness benches run offline, with no API key,
using seeded regressions together with clean and churn commits, and produce a
confusion matrix. Anyone can re-run them.

Repetitions. The safety study uses 8 repetitions per arm per task; the session
study uses 3 repetitions per cell (30 sessions); the gate-vs-LLM study uses 5
repetitions per case across 2 models and 2 repositories. Point estimates without
repetitions are flagged as such.

Process. Several headline claims were retracted mid-study once they were traced
to harness bugs or to unlucky single draws; these are noted inline. The
benchmarks also fed back into the product, and two findings shipped as releases.

---

## Findings

### I. Loop safety and the Stop-gate

Question. How often does an autonomous loop ship net-new debt and declare itself
done, and does a deterministic gate prevent this where a prompt does not?

Method. The harness is `bench-loop.mjs`, with four arms. The vanilla arm has no
gate. The checklist arm has no gate, but the project prompt asks the agent to
self-review for untested code and for secrets. The dxkit arm wires the Stop-gate
hook together with a project norm. The deferred arm runs the vanilla loop and
then uses a separate cold session to fix the debt, as a proxy for the
detect-on-CI-fix-later model. We used two tasks, a test-gap trap and a
secret-hardcode trap, with 8 repetitions each, on Sonnet 4.6. The metric is the
final tree, measured by an identical post-hoc guardrail check: did the loop stop
with net-new debt still present?

Results (escape rate, where the loop ships net-new debt and never fixes it):

| arm                        | observed escapes |
| -------------------------- | ---------------- |
| vanilla                    | 11/16 (69%)      |
| checklist (prompt-only)    | 9/16 (56%)       |
| dxkit (deterministic gate) | 0/16 (observed)  |

The deferred arm is excluded from this table because it intentionally fixes the
debt in a separate cold session. It is used only for the cost-of-deferral
comparison below.

The checklist arm named both failure modes in the prompt and nonetheless shipped
test-gaps in 7 of 8 runs and hardcoded secrets in 2 of 8. Prompting misses even
what you explicitly ask for, whereas the gate is mechanical. The dxkit arm caught
and repaired every net-new finding: it blocked, the model fixed the finding, and
the loop re-stopped clean, with no thrashing.

Cost of deferral. Fixing inside the loop was cheaper than deferring to a cold
session. The deferred arm cost 49% more tokens and 51% more turns on the test-gap
task, and 19% more tokens on the secret task, because the cold fixer has to
re-orient in a context it no longer holds.

Real-repo validation (the small app, NodeGoat, with 2 repetitions). The gate
generalized from synthetic tasks to a real repository. It blocked on net-new
test-gaps, the agent wrote real tests in an unfamiliar framework, and the loop
re-stopped clean. That repair cost between 1.1M and 1.6M tokens, which is exactly
why test-gap gating is opt-in (the `full-debt` preset) while `security-only`,
covering secrets and high-severity vulnerabilities, is the default. The default
is bounded, must-fix, and cheap to gate.

Caveats. The synthetic tasks are small and detector-backed, not a CVE corpus. The
secret-specific failure mode is model-dependent: Sonnet 4.6 is secret-secure by
default on an obvious task, refusing to hardcode a live key in about 62% of runs,
so the test-gap trap rather than the secret trap carries the headline. An earlier
n=1 smoke test reported a deferral premium of about zero; the 8-repetition run
corrected this to the 19% to 49% figures above.

---

### II. The gate is correct and reproducible

Question. Does the gate reliably block net-new regressions, pass clean changes,
and grandfather pre-existing debt, every time?

Method. Three offline benches (no API key) on both real repositories.
`bench-guardrail.mjs` seeds known regressions and clean edits and produces a
confusion matrix. `bench-netnew-isolation.mjs` grandfathers all debt and then
introduces exactly one finding. `bench-matcher.mjs` applies mechanical churn that
adds no finding, namely comment-insert line shifts and file renames.

Results.

- Catch 3/3 and false-block 0/2 on the seeded confusion matrix (tp3, fn0, tn2,
  fp0): every seeded regression was blocked, and every clean edit passed.
- Net-new isolation held in both repository cases. The gate isolated exactly the
  one injected net-new finding: against 1,020 grandfathered items in the large
  monorepo (Strapi), and against 205 grandfathered items in the small app
  (NodeGoat), where the dirty scan therefore contains 206 findings in total, the
  205 grandfathered items plus the one net-new finding.
- Matcher robustness held on the large monorepo (Strapi), whose baseline
  contains 15 duplication findings. Line-shift and rename churn produced 0 false
  regressions, so all 15 duplications kept their identity. (On the small app the
  same churn likewise produced 0 false regressions, over its 5 duplication
  findings.)

These are controlled regression suites, not statistical estimates of scanner
recall. They establish that the gate behaves correctly on the seeded cases, not
that it would catch every possible regression in the wild.

Caveat. The matcher contained a 50% defect in version 2.11.1, a
duplication-identity bug. The bench caught it, and version 2.12.0 fixed it as a
class, with content-anchored identity and a property-based contract test over
every finding kind. The benchmark drove the release.

---

### III. Deterministic gate versus LLM-as-the-gate

Question. When an agent or a CI pipeline asks "is my change safe?", should a
deterministic gate answer, or should one ask an LLM to be the gate? This is a
comparison of gate against gate, not of scanner against scanner.

Method. The harness is `bench-llm-gate.mjs`, with 10 seeded cases (7 security
regressions, 1 clean edit, and 2 pure-churn refactors), 5 repetitions, both
models, and both repositories, for a total cost of about $51. There are three
arms: dxkit's actual verdict; an LLM judging the diff naively, with no baseline;
and an LLM judging the diff with the full prior-findings list as a steelman, at
baseline sizes of 1, 205, and 1,020.

Results.

- dxkit reached 100% accuracy with 0% flips across repetitions, at no LLM cost
  and with no prompt-size growth as the baseline grows, at every scale.
- The naive LLM false-blocked a pure file-rename refactor 50% of the time, across
  both models and both repositories, and Sonnet flip-flopped on a line shift in
  40% of repetitions, so determinism was empirically violated.
- Sonnet with the 1,020-finding baseline missed a real open-redirect regression.
  It caught this regression at smaller baselines and began over-grandfathering by
  similarity as the list grew.
- Cost grows with the baseline, a statefulness tax. Sonnet cost $0.22, $1.05, and
  $4.35 per run at baseline sizes of 1, 205, and 1,020, and Opus cost about $28
  per run at 1,020. The LLM-as-gate prompt grows with the baseline, whereas dxkit
  stores baseline state outside the model context, so its verdict carries no LLM
  cost and a prompt that does not grow with baseline size.
- Opus held 100% accuracy where Sonnet slipped. A stronger model buys
  scale-robustness at roughly 6.5 times the cost, and still without a
  reproducibility guarantee.

Caveat. This is explicitly not a claim that the LLM gives wrong answers.
Opus-with-baseline is an accurate gate. The defensible advantages are
determinism, no LLM cost, and no prompt-size growth at scale. An earlier claim
that the LLM decayed from 80% to 0% was retracted once it was traced to a harness
bug.

---

### IV. Graph context and observed exploration tails

Question. Does the passive code-graph context actually help a real agent session,
net of the scaffold's overhead?

Method. `bench-context-efficiency.mjs` is a proxy measurement over 200 sampled
symbols, comparing whole-file tokens against a `vyuh-dxkit context` slice.
`bench-sessions.mjs` runs real `claude -p` sessions on a naive repository and on
a dxkit-scaffolded repository that carries the 18,948-node graph and a passive
hook, across 5 tasks, 2 arms, and 3 repetitions, for 30 sessions in total, with
the hook firing in every session.

Results.

- Context slices were about 45% smaller than reading the whole file on average,
  and up to about 34 times smaller on hot or large files, in the proxy
  measurement.
- On real sessions in the large monorepo (Strapi), median tokens were roughly
  tied (123k against 154k), the mean was 30% lower (152k against 219k), the worst
  case was 57% lower (281k against 652k, where the naive arm had a rabbit-hole
  run and the dxkit arm had a lower observed worst case), and the variance was
  roughly halved (a
  coefficient of variation of 0.41 against 0.72).
- On the small app the overhead was about zero, with identical mean tokens. The
  scaffold tax is negligible, and the observed tail still tightens slightly.

The claim is predictable tokens rather than fewer tokens. The benefit is a lower
observed worst case, which is what matters most for an unattended loop. A 1-rep
smoke test once reported a factor of 3.5, a naive outlier that we retracted; the
same smoke test surfaced a stale scaffold whose hook never fired, which was
fixed.

Scope of this study. It measures token and cost behavior and hook firing, not
independent task-success quality, so on its own it does not rule out the
possibility of fewer tokens because of less useful work. Future runs should add
blinded task-success scoring.

Why does the benefit appear only on large repositories, and vanish or turn
negative on small ones? The most likely explanation is Amdahl's law, developed in
section V: graph savings are capped by how much of a session is orientation work,
and on a small repository the fixed scaffold overhead swamps that small share. We
treat this as a likely explanation rather than a confirmed one. The model is
directionally consistent with these numbers, but its parameters (`f`, `O`, and
`s`) have not yet been fit to the session traces, so it remains a hypothesis to
be confirmed.

---

### V. When the graph pays: an Amdahl model

Large per-operation graph speedups, such as the often-cited figure of roughly 75
times, do not automatically translate to whole-session savings. Model a session as
orientation work (a fraction `f`, replaceable by graph queries at speedup `s`)
plus a fixed scaffold overhead `O`, over total tokens `T`:

```
fractional session savings ≈ f·(1 − 1/s) − O/T
```

- Even an infinite graph speedup caps whole-session savings at `f`. If
  orientation is 20% of a session, the ceiling is about 20%, not 75 times. The
  75-times figure is `s`, a sub-operation asymptote.
- On a small repository the fixed `O` over a small `T` dominates, so savings fall
  to zero or go negative. A forced-graph probe cost 66% more on the small app.
- On a large repository `O/T` is negligible and `f` is large, which gives the
  30% lower mean and 57% lower tail reported above.

There are three decoupled axes of graph value. The first is mean token
efficiency, which is size-gated and often near zero. The second is variance and
tail behavior, driven by navigability risk, which can be positive even when the
mean is flat; this is the axis that matters for loops. The third is structural
correctness and grounding, which is size-independent and lies outside tokens
entirely. The firing rule that follows is to graph-orient only on large,
well-connected, orientation-heavy work where the workflow actually substitutes
queries for reads, and to read directly otherwise. This is a falsifiable model
rather than a conclusion: `f`, `O`, and `s` are directionally consistent with the
data but not yet numerically fit.

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
  single unlucky draws. They are documented rather than buried.

---

## Artifacts

The three deterministic-tier harnesses are published in the
[`benchmarks/`](../benchmarks/) directory of this repository:
`bench-guardrail.mjs` (gate correctness), `bench-netnew-isolation.mjs` (net-new
isolation), and `bench-matcher.mjs` (matcher robustness). They run offline, with
no API key, against any git repository that has a dxkit baseline, and
`benchmarks/README.md` documents how to reproduce the numbers above on the pinned
NodeGoat and Strapi commits.

The agent-driven harnesses (loop safety, the LLM-as-gate comparison, and the
graph-context sessions) require a model API or subscription and the pinned
repository checkouts. Those harnesses and their raw traces will be published
separately after redaction. Until then, the deterministic-tier numbers are
reproducible today, and the loop, LLM, and session numbers should be read as
trust-but-verify rather than as already-linked raw data.

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
