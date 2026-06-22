# Study VI — When the graph pays: an Amdahl model

> Detailed write-up for the model summarized in
> [`docs/benchmarks.md`](../benchmarks.md). This is an analytical companion to the
> empirical [Study V, graph context](./05-graph-context.md): it explains *why* the
> graph benefit appears on large repositories and vanishes or goes negative on
> small ones. It is a falsifiable model, not a measured result.

## The puzzle

[Study V](./05-graph-context.md) found a 30% lower mean and 57% lower tail on a
large monorepo, but zero benefit (and a 66%-more forced-graph probe) on a small
app. Large per-operation graph speedups — the often-cited figure of roughly 75×
for a single lookup — clearly do not translate into whole-session savings of that
magnitude. Why not?

## The model

Model a session as orientation work (a fraction `f` of total tokens, replaceable
by graph queries at a per-operation speedup `s`) plus a fixed scaffold overhead
`O` (the graph hook, the scaffold prompt), over total session tokens `T`:

```
fractional session savings ≈ f·(1 − 1/s) − O/T
```

This is Amdahl's law with a fixed-cost term. Three consequences follow directly.

1. **Even an infinite per-operation speedup caps whole-session savings at `f`.**
   As `s → ∞`, the first term → `f`. If orientation is 20% of a session, the
   ceiling on whole-session savings is about 20%, *not* 75×. The 75× figure is
   `s`, a sub-operation asymptote, not a session-level result. Conflating the two
   is the central error the model corrects.

2. **On a small repository the fixed `O/T` term dominates and savings go
   negative.** When `T` is small, `O/T` is large, and `f` is small (a small app
   needs little orientation), so the whole expression is negative — using the
   graph costs *more*. This is exactly the NodeGoat forced-graph probe: +66%.

3. **On a large repository `O/T` is negligible and `f` is large.** Orientation is
   a big share of a sprawling, poorly-navigable monorepo, and the fixed overhead
   is a rounding error against a large `T`. The expression is solidly positive,
   which is consistent with the 30% lower mean and 57% lower tail measured on
   Strapi.

## Three decoupled axes of graph value

The model also separates three things that "does the graph help?" usually
conflates:

1. **Mean token efficiency** — size-gated, often near zero. This is what most
   "token savings" benchmarks measure, and it is the *weakest* axis.
2. **Variance and tail behavior** — driven by navigability risk, not average
   cost. This can be strongly positive even when the mean is flat, because the
   graph removes the rabbit-hole runs. **This is the axis that matters for an
   unattended loop**, where the worst case sets the cost and completeness bound.
3. **Structural correctness and grounding** — size-independent, and outside the
   token budget entirely. The graph can make the agent *right* about call
   relationships regardless of how many tokens it spends.

## The firing rule

The model yields an operational rule: **graph-orient only on large,
well-connected, orientation-heavy work where the workflow actually substitutes
queries for reads; read directly otherwise.** dxkit's product behavior follows
this — graph context is a complement that pays on large repos, not a universal
token-saver, and the documentation says so.

## Status: falsifiable, not yet fit

This is a model, not a fitted result. The parameters `f` (orientation fraction),
`O` (fixed overhead), and `s` (per-operation speedup) are **directionally
consistent** with the Study V session traces but have **not been numerically fit**
to them. The honest status is "a hypothesis that explains the sign and rough
magnitude of the measured effects," not "a validated quantitative law."

To confirm it, a future run should:

- estimate `f` per session by labeling orientation versus editing turns in the
  traces;
- measure `O` directly as the scaffold's fixed token cost on a trivial task;
- fit `s` from the proxy's per-operation reductions ([Study V](./05-graph-context.md));
- check whether the fitted `f·(1 − 1/s) − O/T` predicts the observed per-session
  savings across both repositories.

Until then it is presented as a falsifiable explanation, and any reader should
treat it as such.

## Provenance

Analytical model; no harness. The numbers it explains come from
[Study V](./05-graph-context.md) (`d-full-strapi-sonnet.json`,
`d-full-nodegoat-sonnet.json`, `f-probe-nodegoat.json`). dxkit 2.13.0 era, June
2026.
