# Study V — Graph context and observed exploration tails

> Detailed write-up for the study summarized in
> [`docs/benchmarks.md`](../benchmarks.md). The analytical model that explains
> *why* the effect is size-gated is [Study VI, the Amdahl model](./06-amdahl-model.md).

## Question

Does dxkit's passive code-graph context actually help a real agent session, net of
the scaffold's overhead? And if so, on what axis — fewer tokens, or *more
predictable* tokens?

## TL;DR

The benefit is **predictable tokens, not fewer tokens**, and it is **size-gated**.

- On a large monorepo (Strapi), real sessions showed a **30% lower mean**, a **57%
  lower worst case**, and **variance roughly halved** — but a roughly tied median.
- On a small app (NodeGoat), the mean was identical (overhead ≈ zero) and the tail
  tightened only slightly.
- A token-slicing proxy saved **45% aggregate** tokens versus reading whole files,
  but on **54% of individual files the slice was actually larger** (scaffold
  overhead on small files); the median file was only 8% smaller. The savings live
  almost entirely in large, hot files (up to **34× smaller**).

This is the axis that matters for an unattended loop: a lower observed worst case
bounds the cost and completeness tails, even when the average is flat.

## Substrate and pins

- **strapi/strapi** (community MIT / `ee/` commercial), commit `dc49217` — the
  large monorepo, code graph of 18,948 nodes and 20,012 edges.
- **OWASP NodeGoat** (Apache-2.0), commit `c5cb68a` — the small app.

Model: Claude Sonnet 4.6. dxkit 2.13.0.

## Method

Two harnesses:

- **`bench-context-efficiency.mjs`** — a proxy measurement over 200 sampled
  symbols, comparing whole-file token cost against a `vyuh-dxkit context` slice for
  the same symbol. Measures the slicing primitive in isolation, not a real
  session.
- **`bench-sessions.mjs`** — real `claude -p --output-format stream-json` sessions
  on a naive checkout versus a dxkit-scaffolded checkout that carries the
  18,948-node graph and a passive PreToolUse context hook. 5 tasks × 2 arms × 3
  repetitions = 30 sessions per repository, with the hook confirmed firing in
  every dxkit-arm session.

The metric is total session tokens (and its distribution), parsed from the raw
event stream. This study measures token and cost behavior and hook firing — not
independent task-success quality (see caveats).

## Results

### Proxy (200 symbols)

| Measure                                | Value          |
| -------------------------------------- | -------------- |
| Aggregate (token-weighted) reduction   | **45% smaller**|
| Median per-file slice vs whole file    | 8% smaller     |
| Files where the slice was *larger*     | 108/200 (54%)  |
| Max reduction (hot/large file)         | **33.9×**      |

The honest reading: on a *typical* file a graph slice is about the same size as
just reading the file, and more than half the time it is slightly larger because
of the slice's structural framing. The 45% aggregate is real but is carried by a
minority of large, hot files where the slice is dramatically smaller. This is the
size-gating that [the Amdahl model](./06-amdahl-model.md) formalizes.

### Real sessions — large monorepo (Strapi, n=15 per arm)

| Statistic            | naive    | dxkit    | Delta            |
| -------------------- | -------- | -------- | ---------------- |
| median tokens        | 153,603  | 123,204  | roughly tied     |
| mean tokens          | 219,249  | 152,056  | **−30%**         |
| worst case (max)     | 652,278  | 281,395  | **−57%**         |
| coefficient of var.  | 0.72     | 0.41     | **~halved**      |

The naive arm had a rabbit-hole run (652k tokens); the dxkit arm's worst case was
far lower. The mean and tail move while the median barely does — the signature of
*variance reduction*, not average reduction.

### Real sessions — small app (NodeGoat, n=15 per arm)

| Statistic           | naive    | dxkit    |
| ------------------- | -------- | -------- |
| mean tokens         | 115,990  | 115,533  |
| coefficient of var. | 0.18     | 0.12     |

The means are identical: the scaffold tax is negligible and there is no
average benefit to extract on a small, already-navigable app. The tail tightens
only slightly. A separate forced-graph probe on NodeGoat — forcing graph use
where direct reads would do — cost **66% more** (570k vs 343k tokens), a concrete
illustration of overhead dominating on small work.

## Caveats and retractions

- **Predictability, not reduction.** The claim is a lower observed worst case and
  tighter variance on large, connected work — not fewer tokens in every session.
- **This study does not score task-success quality.** It measures tokens, cost,
  and hook firing, so on its own it does not rule out "fewer tokens because of less
  useful work." Future runs should add blinded task-success scoring.
- **Sonnet only; Opus session arm deferred.**
- **A 1-rep smoke test once reported a 3.5× reduction** — a naive outlier we
  retracted. The same smoke surfaced a stale scaffold whose hook never fired,
  which was then fixed.
- **The proxy is a proxy.** It measures the slicing primitive, not a session; the
  session study is the real test.

## Reproduce it

The proxy and session harnesses are part of the agent-driven tier under
[`benchmarks/agentic/`](../../benchmarks/agentic/) (the session harness needs a
model subscription; the proxy needs only a built graph):

```bash
node benchmarks/agentic/bench-context-efficiency.mjs --config <cfg.json>
node benchmarks/agentic/bench-sessions.mjs --config <cfg.json> --out sessions.json
```

See [`benchmarks/agentic/README.md`](../../benchmarks/agentic/README.md) for the
scaffold setup and task list.

## Provenance

dxkit 2.13.0, harness commit `7f801a4`, June 2026, Sonnet 4.6. Raw data:
`context-efficiency-results.json` (200 symbols), `d-full-strapi-sonnet.json` and
`d-full-nodegoat-sonnet.json` (30 sessions each), `f-probe-nodegoat.json`
(forced-graph probe).
