# Study IV: Deterministic gate versus LLM-as-the-gate

> Detailed write-up for the study summarized in
> [`docs/benchmarks.md`](../benchmarks.md).

## Question

When an agent or a CI pipeline asks "is my change safe to stop on?", should a
deterministic gate answer, or should one ask an LLM to be the gate? This compares
**gate against gate**, not scanner against scanner. It is explicitly *not* a
claim that the LLM gives wrong answers, a strong model with enough baseline
state is an accurate judge. The question is whether it is cheap, reproducible, and
scale-stable enough to sit on every loop iteration.

## TL;DR

| Gate                    | Accuracy           | Flips | Cost                         | Prompt growth with baseline |
| ----------------------- | ------------------ | ----- | ---------------------------- | --------------------------- |
| dxkit (deterministic)   | 100% at all scales | 0     | $0                           | none                        |
| LLM (Sonnet, baseline)  | slips at 1,020     | 0-40% | $0.22 → $4.35 (1 → 1,020)    | grows with baseline         |
| LLM (Opus, baseline)    | 100% at all scales | 0     | up to ~$28 / suite at 1,020  | grows with baseline         |

A frontier model can match dxkit's accuracy (Opus did, at every scale). dxkit's
defensible advantages are **determinism, no per-check LLM cost, and a prompt that
does not grow with the baseline**, all of which hold regardless of model
capability.

## Substrate and pins

- **OWASP NodeGoat** (Apache-2.0), commit `c5cb68a`, baseline sizes 1 and 205.
- **strapi/strapi** (community MIT / `ee/` commercial), commit `dc49217`,
  baseline sizes 1, 205, and 1,020.

Models: Claude Sonnet 4.6 and Claude Opus 4.8. 10 seeded cases (7 security
regressions, 1 clean edit, 2 pure-churn refactors), 5 repetitions each. Total
study cost ≈ **$51**. dxkit 2.13.0.

## Method

The harness is `bench-llm-gate.mjs`. Three gate arms judge the same diffs:

1. **dxkit**, the actual deterministic verdict.
2. **LLM naive**, an LLM judging the diff with no baseline context.
3. **LLM with baseline**, an LLM judging the diff with the full prior-findings
   list supplied as context, a steelman, at baseline sizes of 1, 205, and 1,020.

Each cell reports modal accuracy across the 5 repetitions, a flip rate (did the
verdict change across repetitions of the identical input?), and the cell's total
equivalent cost over its 10 cases × 5 repetitions.

## Results

### Accuracy and flips

- **dxkit: 100% accuracy, 0% flips, at every scale on both repositories.** The
  same input yields the same verdict by construction.
- **Naive LLM false-blocks churn.** With no baseline, a pure file-rename refactor
  was false-flagged as net-new by Sonnet on both repositories and by Opus on
  Strapi (churn false-net-new rate 0.5 at the naive scale). Sonnet also
  flip-flopped on a pure line-shift refactor in **40% of repetitions** on Strapi
  (accuracy 0.6, flip 0.4), determinism empirically violated on identical input.
- **Sonnet over-grandfathers at scale.** With the 1,020-finding baseline, Sonnet
  **missed a real open-redirect regression** (accuracy 0 on that case) that it
  caught at baseline sizes naive, 1, and 205. As the prior-findings list grows,
  the model begins matching a true regression to a similar-looking grandfathered
  item and waving it through. Its overall accuracy fell to 0.90 at 1,020.
- **Opus held 100%** accuracy at every scale, including 1,020, where Sonnet
  slipped. A stronger model buys scale-robustness, but not a reproducibility
  guarantee, and not for free.

### Cost (the statefulness tax)

Cost for each scale's full suite (10 cases × 5 reps), on Strapi:

| Baseline size | Sonnet | Opus    |
| ------------- | ------ | ------- |
| 1             | $0.22  | $1.43   |
| 205           | $1.05  | $6.81   |
| 1,020         | $4.35  | $28.28  |

The LLM-as-gate prompt grows with the baseline, so cost grows roughly 20× across
this range as the prior-findings list is fed in on every judgment. At the largest
baseline Opus costs about **6.5× Sonnet** ($28.28 vs $4.35). dxkit stores baseline
state outside the model context, so its verdict carries **no LLM cost and a prompt
that does not grow** with baseline size.

## Caveats and retractions

- **Not a claim the LLM is wrong.** Opus-with-baseline is an accurate gate. The
  defensible advantages are determinism, no LLM cost, and no prompt-size growth.
- **"Per run" vs suite total.** The dollar figures above are each scale-cell's
  total over its 10 cases × 5 repetitions (they sum to the ≈$51 study total). The
  load-bearing facts are the *scaling* with baseline size and the Sonnet/Opus
  *ratio*, both of which are normalization-independent.
- **An earlier claim that the LLM decayed from 80% to 0% was retracted** once it
  was traced to a harness bug. The numbers here are the corrected run.
- **Seeded cases, not a recall estimate.** 10 controlled cases, not a CVE corpus.

## Reproduce it

Requires a model subscription or API key; part of the agent-driven tier under
[`benchmarks/agentic/`](../../benchmarks/agentic/).

```bash
node benchmarks/agentic/bench-llm-gate.mjs --config <cfg.json> --out gate.json
```

See [`benchmarks/agentic/README.md`](../../benchmarks/agentic/README.md) for the
config (models, scale points, cases) and pinned-substrate setup.

## Provenance

dxkit 2.13.0, harness commit `7f801a4`, June 2026, Sonnet 4.6 + Opus 4.8, pricing
as of June 2026. Raw data: `strapi-llm-gate-FULL.json` (1,020-scale cells) and
`nodegoat-llm-gate-FULL.json`.
