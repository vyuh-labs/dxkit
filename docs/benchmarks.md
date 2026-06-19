# dxkit benchmarks: methodology and findings

> Sanitized public report. The honest claim throughout is predictability, not
> reduction. Every headline number carries its caveats; the claim ledger and
> "what this does not prove" are up front.

---

## TL;DR

Autonomous coding loops (an agent that keeps editing until it decides to
stop) **ship net-new debt and declare "done" most of the time** — measured at
**69%** of runs with a vanilla loop, **56%** even when the project prompt
explicitly tells the agent to self-check. A deterministic **Stop-gate** that
re-runs a net-new guardrail on every stop drops that to **0%** (reps=8). The
gate doesn't detect anything new — it enforces, at the loop's tempo, the
findings dxkit already computes, and feeds them back to the model to repair.

**dxkit = predictability, not reduction.** Three independent measurements,
one through-line:

| Layer              | What it bounds                    | Headline                                                |
| ------------------ | --------------------------------- | ------------------------------------------------------- |
| Deterministic gate | unsafe final state                | 69%/56% → **0%** escape rate                            |
| Code graph         | the cost + completeness **tails** | worst-case session tokens **−57%**, variance **halved** |
| Durable identity   | finding identity under churn      | **0%** false "net-new" on line-shifts / renames         |

It is **not** a scanner (it ingests Snyk/CodeQL/SARIF), **not** a token-saver
(mean tokens are often flat), and **not** "more accurate than an LLM" (a
frontier model with a baseline is an accurate judge — just not a cheap,
reproducible, or in-loop one).

---

## Claim ledger

Every claim below, its strength, and the exact public wording we stand behind.
Read this first; the rest of the doc is the evidence.

| Claim                                              | Status          | Evidence                                           | Public wording                                              |
| -------------------------------------------------- | --------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| The Stop-gate prevents observed loop escapes       | Strong          | loop benchmark, 8 reps × 2 tasks                   | "0/16 observed escapes in our benchmark"                    |
| Prompt-only self-check is insufficient             | Strong          | checklist arm 9/16 escapes                         | "prompting reduced but did not eliminate escapes"           |
| Gate identity is deterministic under tested churn  | Strong          | offline matcher benches                            | "0 false net-new on tested line-shift / rename cases"       |
| LLM-as-gate has cost + reproducibility issues      | Strong          | gate-vs-LLM benchmark, 5 reps × 2 models × 2 repos | "an LLM can judge, but not cheaply or reproducibly in-loop" |
| Graph context bounds large-repo token tails        | Moderate–strong | Sonnet session study, 30 sessions                  | "lower mean / tail / variance on a large repo"              |
| dxkit improves _every_ agent session               | **Not claimed** | —                                                  | do not say this                                             |
| dxkit detects _more_ vulnerabilities than scanners | **Not claimed** | —                                                  | do not say this                                             |

## What this does not prove

- **0/16 is observed, not proven-zero.** The gate blocked every detector-backed
  finding surfaced in these seeded runs; that is not a proof that no escape is
  possible.
- **dxkit is not a scanner** and does not claim to find more bugs than Snyk,
  CodeQL, Semgrep, or a frontier model. It ingests them.
- **The loop benchmark uses synthetic, detector-backed tasks** plus small
  real-repo validation — not a CVE corpus.
- **The loop headline includes test-gap behavior**, which is the opt-in
  `full-debt` preset; the product default (`security-only`) gates secrets +
  crit/high vulns. (See study I.)
- **Graph context does not guarantee fewer tokens** in every session; the
  measured win is lower mean / tail / variance on large, connected tasks.
- **Opus session results are deferred**; session numbers are Sonnet.

---

## The thesis: predictability, not reduction

A scanner answers "what's wrong?" An autonomous loop needs a different
answer: **"did I just make it worse, and can I stop?"** That question has to
be answered the same way every time, in seconds, locally, with feedback the
_model_ can act on. That's a systems property, not a detection problem — and
it's the gap dxkit fills:

1. **A deterministic net-new gate.** Same input → same verdict, one exit
   code, $0, offline. Pre-existing debt is grandfathered by a baseline; only
   regressions block.
2. **A code graph** that bounds the agent's worst-case exploration cost and
   completeness, rather than lowering its average cost.
3. **Durable, content-anchored finding identity** that survives line shifts
   and renames, so "net-new" means net-new and a committed baseline keeps
   matching across machines and CI.

---

## What dxkit is / is NOT (read this before the numbers)

- **Is:** a deterministic verification + governance layer that stitches
  established tools (gitleaks, community Semgrep, OSV/npm-audit, jscpd, a
  code-graph builder, cloc) and **ingests** external engines (Snyk Code,
  CodeQL, any SARIF), then adds the layer they lack — a net-new gate, a
  brownfield baseline, durable identity, and graph-scoped context.
- **Is NOT a scanner.** dxkit does not claim to find more bugs than Snyk or
  CodeQL. It ingests their findings and makes them enforceable.
- **Is NOT "the LLM is wrong."** With a baseline provided, a frontier model
  judges net-new accurately. dxkit's wins are _determinism, $0/check, O(1) at
  scale, and reproducible identity_ — properties that hold regardless of
  model IQ.
- **Is NOT a token-saver.** On a real session the mean token count is often
  flat; the win is a bounded worst case, not a smaller average.

---

## Methodology (shared across studies)

- **Models:** Claude Sonnet 4.6 for agent-session runs; Claude Opus 4.8 added
  as a steelman in the gate-vs-LLM study. Sessions run through `claude -p
--output-format stream-json` and are parsed from the raw event stream.
- **Substrates (two real OSS repos, pinned, sanitized):**
  - **"small app"** — a small Express app (~2k LOC, an OWASP training
    target). dxkit baseline: **205 pre-existing findings**.
  - **"large monorepo"** — a large TypeScript monorepo (~574k LOC, Yarn/Nx).
    dxkit baseline: **1,020 findings**; code graph: **18,948 nodes / 20,012
    edges**.
  - Plus **synthetic repos** for the loop-safety study (small, controlled,
    one known finding injected per task).
- **Determinism tier (no API key, fully reproducible):** the gate-correctness
  benches run offline with seeded regressions + clean/ churn commits and
  produce a confusion matrix. Anyone can re-run them.
- **Reps:** safety study **8 reps** per arm per task; session study **3 reps**
  per cell (30 sessions); gate-vs-LLM **5 reps** per case across 2 models × 2
  repos. Point estimates without reps are flagged as such.
- **Honesty discipline:** several headline claims were **retracted** mid-study
  when traced to harness bugs or unlucky single draws (noted inline). The
  benchmarks also fed the product — two findings shipped as releases.

---

## Findings

### I. Loop safety — the Stop-gate (the headline)

**Question:** how often does an autonomous loop ship net-new debt and declare
done, and does a deterministic gate prevent it where a prompt doesn't?

**Method:** `bench-loop.mjs`. Four arms — **vanilla** (no gate), **checklist**
(no gate; the project prompt tells the agent to self-review for untested code
_and_ secrets), **dxkit** (Stop-gate hook + project norm), **deferred**
(vanilla, then a separate cold session fixes the debt — a proxy for the
"detect on CI, fix later" model). Two tasks (a test-gap trap and a
secret/hardcode trap), **8 reps each**, Sonnet 4.6. The metric is the **final
tree** measured by an identical post-hoc guardrail check: did the loop stop
with net-new debt still present.

**Results — escape rate (ships net-new debt, never fixed):**

| arm                        | escape rate     |
| -------------------------- | --------------- |
| vanilla                    | **69%** (11/16) |
| checklist (prompt-only)    | **56%** (9/16)  |
| dxkit (deterministic gate) | **0%** (0/16)   |

- The checklist arm **named both failure modes in the prompt** and still
  shipped test-gaps 7/8 and hardcoded secrets 2/8. Prompting misses even what
  you explicitly asked for; the gate is mechanical.
- The dxkit arm caught and **repaired** every net-new finding (block →
  model fixes → re-stops clean), with no thrashing.

**Cost of deferral (in-loop vs fix-it-later):** fixing in the loop is
**cheaper** than deferring to a cold session — the deferred arm cost **+49%**
tokens / +51% turns on the test-gap task and **+19%** on the secret task,
because the cold fixer pays to re-orient in a context it no longer has.

**Real-repo validation (small app, reps=2):** the gate generalized from
synthetic to a real repo — it blocked on net-new test-gaps, the agent wrote
real tests in an unfamiliar framework, and it re-stopped clean. That repair
cost **1.1M–1.6M tokens**, which is exactly why **test-gap gating is opt-in**
(`full-debt` preset) and **`security-only` is the default** (secrets +
crit/high vulns — bounded, must-fix, cheap to gate).

**Honest caveats:** synthetic tasks are small and detector-backed, not a CVE
corpus. The secret-specific failure mode is model-dependent — Sonnet 4.6 is
"secret-secure by default" on an obvious task (it refused to hardcode a live
key ~62% of the time), so the _test-gap_ trap, not the secret trap, carries
the headline. An earlier n=1 smoke claimed a ≈0 deferral premium; reps=8
corrected that to the +19–49% above.

---

### II. The gate is correct and reproducible (deterministic, $0)

**Question:** does the gate reliably block net-new regressions, pass clean
changes, and grandfather pre-existing debt — every time?

**Method:** three offline benches (no API key) on both real repos —
`bench-guardrail.mjs` (seed known regressions + clean edits → confusion
matrix), `bench-netnew-isolation.mjs` (grandfather all debt, introduce
exactly one finding), `bench-matcher.mjs` (mechanical churn that adds _no_
finding — comment-insert line shifts, file renames).

**Results:**

- **100% catch / 0% false-block** on seeded regressions vs clean edits, both
  repos.
- **Net-new isolation 100%:** in the large monorepo the gate flags **1
  against 1,020** grandfathered findings; in the small app **1 against 206**.
- **Matcher robustness 0% false regressions** across 15 real duplicate blocks
  under line-shift + rename churn.

**Honest caveat:** the matcher was a **50% defect** in 2.11.1 (a
duplication-identity bug) — the bench _caught it_, and 2.12.0 fixed it as a
class (content-anchored identity + a property-based contract test over every
finding kind). The benchmark drove the release.

---

### III. Deterministic gate vs LLM-as-the-gate

**Question:** when an agent or CI asks "is my change safe?", should a
deterministic gate answer, or should you ask an LLM to _be_ the gate? (This is
gate-vs-gate, not scanner-vs-scanner.)

**Method:** `bench-llm-gate.mjs`. 10 seeded cases (7 security regressions, 1
clean edit, 2 pure-churn refactors), **5 reps**, **both models**, **both
repos**, ~$51 total. Three arms: dxkit's real verdict; an LLM judging the diff
**naively** (no baseline); an LLM judging the diff **with the full prior
findings list** (the steelman), at baseline scales 1 → 205 → 1,020.

**Results:**

- **dxkit: 100% accuracy / 0% flip across reps / $0 / O(1)** at every scale.
- **The naive LLM false-blocks a pure file-rename refactor 50% of the time**
  (both models, both repos); Sonnet flip-flopped on a line-shift **40%** of
  reps — _determinism empirically violated._
- **Sonnet with the 1,020-finding baseline missed a real open-redirect
  regression** (it caught it at smaller baselines — it over-grandfathers by
  similarity as the list grows).
- **Cost grows with the baseline (a statefulness tax):** Sonnet $0.22 → $1.05
  → $4.35 per run as the baseline scales 1 → 205 → 1,020; **Opus at 1,020 ≈
  $28/run.** dxkit is $0 and O(1).
- Opus held 100% where Sonnet slipped — a smarter model buys scale-robustness
  at **~6.5× the cost**, still without a reproducibility guarantee.

**Honest caveat:** this is explicitly **not** "the LLM gives wrong answers."
Opus-with-baseline is an accurate gate. The defensible wins are determinism,
$0, and O(1) behavior at scale. (An earlier "the LLM decays 80→0%" claim was
retracted when traced to a harness bug.)

---

### IV. Graph context: bounding exploration tails

**Question:** does the passive code-graph context actually help a real agent
session, net of the scaffold's overhead?

**Method:** `bench-context-efficiency.mjs` (proxy: 200 sampled symbols,
whole-file tokens vs `vyuh-dxkit context` slice) and `bench-sessions.mjs`
(real `claude -p` sessions, naive repo vs dxkit-scaffolded repo with the
18,948-node graph + a passive hook; 5 tasks × 2 arms × 3 reps = 30 sessions,
hook fired 100%).

**Results:**

- **Context slices are ~45% smaller** than reading the whole file on average,
  up to **~34×** on hot/large files (proxy).
- **Real sessions, large monorepo:** median tokens **≈ tied** (123k vs 154k),
  **mean −30%** (152k vs 219k), **worst case −57%** (281k vs 652k — the naive
  agent rabbit-holes; dxkit caps it), **variance roughly halved** (CV 0.41 vs
  0.72).
- **Small app:** overhead **≈ 0** (mean tokens identical) — the scaffold tax
  is negligible and the tail still tightens slightly.

**The honest claim is "predictable tokens, not fewer tokens."** The win is a
bounded worst case, which is exactly what matters for an unattended loop.
(A 1-rep smoke once showed 3.5× — a naive outlier, retracted. The same smoke
caught a stale scaffold whose hook never fired; fixed.)

Why does the benefit appear only on large repos and vanish (or go negative) on
small ones? The most likely explanation is **Amdahl's law** (section V): graph
savings are capped by how much of a session is orientation work, and on a small
repo the fixed scaffold overhead swamps that small share. We treat this as a
**likely explanation, not a confirmed one** — the model is directionally
consistent with these numbers, but its parameters (`f`, `O`, `s`) have not yet
been fit to the session traces, so it remains a hypothesis to be confirmed.

---

### V. When the graph pays — an Amdahl model (why "75× savings" is misleading)

A code-graph tool's viral "~75× token savings" is real for **one structural
operation** but **never reaches the session level**. Modeling a session as
orientation work (fraction `f`, replaceable by graph queries at speedup `s`)
plus fixed scaffold overhead `O` over total tokens `T`:

```
fractional session savings ≈ f·(1 − 1/s) − O/T
```

- Even an **infinite** graph speedup caps whole-session savings at `f` (if
  orientation is 20% of a session, the ceiling is ~20% — not 75×). The "75×"
  is `s`, a sub-operation asymptote.
- On a **small** repo, fixed `O` over small `T` dominates → savings go to zero
  or **negative** (a forced-graph probe cost **+66%** on the small app).
- On a **large** repo, `O/T` is negligible and `f` is large → the **−30%
  mean / −57% tail** above.

**Three decoupled axes of graph value:** (1) mean token efficiency —
size-gated, often ≈0; (2) **variance/tail — driven by navigability risk, can
be positive even when the mean is flat** (this is the loop-relevant one); (3)
structural correctness/grounding — size-independent, outside tokens entirely.
The firing rule that falls out: **graph-orient only on large, well-connected,
orientation-heavy work where the workflow actually substitutes queries for
reads; read directly otherwise.** This is a falsifiable model, not a
conclusion — `f`, `O`, `s` are directionally consistent with the data but not
yet numerically fit.

---

## Differentiation: why not just Snyk / SonarQube?

The difference is **architecture and tempo, not detection.** Cloud scanners
are detection engines on a CI cadence; they were never built to sit inside an
agent's stop decision.

| What a loop's Stop-gate needs            | dxkit                                      | Cloud scanners (Snyk Code / SonarQube) |
| ---------------------------------------- | ------------------------------------------ | -------------------------------------- |
| Fires on every stop, in seconds, locally | ✅ $0, offline, instant                    | ❌ cloud round-trip, CI/PR cadence     |
| Offline / no egress / no auth            | ✅ local + deterministic                   | ❌ upload-to-cloud / server-side gate  |
| Feedback the **model** can act on        | ✅ `decision:block + reason` → warm repair | ❌ dashboards / PR comments for humans |
| Reproducible identity offline            | ✅ content-anchored, env-independent       | ⚠️ "new code" defined server-side      |

**Honesty guardrails (or the claim gets dismantled):** do **not** say cloud
scanners "can't detect net-new" — SonarQube has a new-code quality gate and
Snyk has delta concepts. Do **not** say in-loop gating is "impossible" with
them — you _could_ shell a cloud scan in a Stop hook; it'd just be slow,
networked, authenticated, and untuned to the loop's baseline. The accurate
claim is **"not architecturally designed for per-iteration local gating —
and optionally a detection source dxkit ingests."**

---

## Why now (market context)

- Claude Code is reportedly behind **~4% of all public GitHub commits**; loop
  workflows generate **8× more code, 80%+ AI-authored**.
- The recognized hard part of a loop is the **gate**. Today's loop validation
  is tests + linter — which catch _broken_, not _regressed_: there's no
  net-new-vs-known notion, and an LLM-judge gate adds cost, latency, and
  non-determinism on every iteration.
- The sharpest one-line framing: **"the deterministic guardrail your Claude
  Code loops need."**

---

## Honest limitations (the disclaimer slide)

- **Two real repos** + synthetic cases. Seeded findings are detector-backed
  but **not a CVE corpus**; broader language/repo generality is future work.
- **Not better detection.** dxkit ingests Snyk/CodeQL; it doesn't out-detect
  them.
- **Context-efficiency is a proxy**; the session study is the real test.
- **The Opus session arm is deferred**; session numbers are Sonnet.
- **The Amdahl model is directional**, not a numerical fit.
- Several sub-claims were **retracted** when traced to harness bugs or single
  unlucky draws — they're documented, not buried.

---

## Reproduce it on your own repo

The whole point is that you don't have to trust these numbers — the
deterministic tier runs offline:

```bash
npx vyuh-dxkit baseline create          # grandfather today's debt
npx vyuh-dxkit init --claude-loop        # wire the Stop-gate
npx vyuh-dxkit loop doctor               # confirm it's safe to run unattended
# …run your loop, then:
npx vyuh-dxkit loop ledger summarize     # blocked vs allowed, repaired-after-block
```

A `vyuh-dxkit evaluate` command (a one-shot "prove it on your repo" report) is
the planned next step.
