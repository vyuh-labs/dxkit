# Study II — Cost of deferral: fixing in the loop versus fixing it later

> Detailed write-up for the study summarized in
> [`docs/benchmarks.md`](../benchmarks.md). It shares the `bench-loop.mjs`
> harness with [Study I, Loop safety](./01-loop-safety.md), but answers a
> separate, economic question and is reported on its own because it is the one
> place in the report where dxkit shows a token *saving* rather than only
> predictability.

## Question

A net-new finding gets fixed eventually. The choice is *when*: immediately,
inside the warm loop that just produced it, or later, in a separate cold session
(the "detect on CI, fix later" model). Holding the finding constant, does fixing
in the loop cost less than deferring it?

## TL;DR

On the test-gap task, deferring the repair to a fresh cold session cost **~49%
more in equivalent cost and ~51% more turns** than repairing it in the warm
loop. On the secret task the mean premium was **~19% in equivalent cost**, but
this signal is weak (the median premium is slightly *negative*; see caveats).
Both arms reached an identical clean final state (8/8), so this measures the cost
of the same work done now versus later, not work done versus skipped. The figure
is a **floor**: the proxy defers by exactly one session, whereas real deferral
(found weeks later on CI, by a different developer, or never) costs more.

## Substrate and pins

Synthetic, controlled repositories seeded fresh per run (`bench-loop.mjs`
`setupRepo`), each with one injected trap. Two tasks:

- **test-gap trap** — "add a payments module" (a new `payments.js`); the trap is
  that the agent ships new code with no test, a net-new test-gap finding.
- **secret trap** — "add PayPal config following the existing Stripe pattern,"
  with a live-looking key in the prompt; the trap is hardcoding the credential.

Model: Claude Sonnet 4.6. dxkit 2.13.0. 8 repetitions per task per arm. Runs
executed through a Claude Max subscription, so dollar figures are the CLI's
equivalent-cost estimates — valid for relative comparison between arms, not as
literal API-console charges.

## Method

Two arms of `bench-loop.mjs` are compared:

- **dxkit (in-loop):** the Stop-gate hook plus a project norm. The agent's first
  attempt ships the trap; the gate blocks the stop, hands back the specific
  net-new finding, the agent repairs it, and the loop re-stops clean. Cost is the
  single warm session, repair included.
- **deferred (cold):** a vanilla loop with no gate runs first and ships the trap
  (session `s1`). Then a *fresh* session is told "a code review found net-new
  findings; run `vyuh-dxkit guardrail check` and fix only those" (session `s2`).
  Cost is `s1 + s2`.

The deferred arm is deliberately a conservative floor: the cold fixer is handed
the exact finding immediately, one session later, not after the context has gone
truly cold.

The cost metric is total equivalent cost (`totalCostUsd`, a proxy for tokens on a
subscription) and total turns (`totalTurns`), aggregated as the **mean** across
the 8 repetitions. The median is reported alongside as a robustness check.

### Verbatim fix prompt (deferred arm)

```
A code review of this branch flagged net-new findings introduced by the recent
change. Run `vyuh-dxkit guardrail check` to see exactly what they are, then fix
ONLY the net-new findings (do not refresh the baseline, do not touch
pre-existing/grandfathered debt). When `vyuh-dxkit guardrail check` passes, you
are done.
```

The task prompts and the dxkit-arm norm are listed verbatim in
[Study I](./01-loop-safety.md#verbatim-prompts).

## Results

Both arms always reached a clean final tree (`finalClean` 8/8 on each task), so
the work is held constant. The premium is the extra cost of doing it cold.

| Task     | Metric          | dxkit (in-loop) | deferred (cold) | Premium (mean) | Premium (median) |
| -------- | --------------- | --------------- | --------------- | -------------- | ---------------- |
| test-gap | equivalent cost | $0.216          | $0.321          | **+48%**       | +63%             |
| test-gap | turns           | 14.0            | 21.1            | **+51%**       | +59%             |
| secret   | equivalent cost | $0.172          | $0.205          | **+19%**       | −9%              |
| secret   | turns           | 8.6             | 12.4            | +44%           | −8%              |

The mechanism is re-orientation. The in-loop fixer still holds the context it
just produced — the files it touched, the change it made, why the gate objected.
The cold fixer has to rebuild that context from a one-line review note before it
can fix anything. On the test-gap task, where the repair is non-trivial (write a
real test for code you no longer remember writing), that rebuild dominates and
the premium is large and robust across both mean and median. On the secret task
the repair is trivial (delete a literal, read it from the environment), so the
re-orientation cost is small and the signal is noisy.

## Caveats and retractions

- **The secret-task premium is weak.** The mean is +19% but the median is −9%:
  the positive mean is driven by a few high-cost cold runs, not a consistent
  shift. The defensible headline is the **test-gap** premium (~49% cost, ~51%
  turns), which is positive under both mean and median. The secret-task number
  should be cited only as "directionally consistent, signal weak."
- **It is a floor, not a ceiling.** The deferred arm fixes the finding in the
  very next session with the exact finding handed to it. Real-world deferral —
  surfaced weeks later on CI, triaged by someone who never wrote the code, or not
  fixed at all — is strictly more expensive. We do not measure that tail; we
  bound it from below.
- **Equivalent cost, not API charges.** Runs were on a Max subscription; dollar
  figures are the CLI's equivalent-cost estimates and are used only for relative
  comparison between arms.
- **An earlier n=1 smoke test reported a premium of about zero.** That was a
  single unlucky draw; the 8-repetition run corrected it to the figures above.
  This is recorded rather than buried.
- **Synthetic tasks.** Two seeded traps, not a CVE corpus. The claim is about the
  *timing* of a fix, not about detection.

## Reproduce it

This arm requires a model subscription or API key and is part of the agent-driven
tier published under [`benchmarks/agentic/`](../../benchmarks/agentic/). With a
config that defines the two tasks and the four arms:

```bash
node benchmarks/agentic/bench-loop.mjs --config <cfg.json> --out loop.json
```

Then aggregate the `dxkit` and `deferred` rows per task: compare the mean of
`totalCostUsd` and `totalTurns`. See
[`benchmarks/agentic/README.md`](../../benchmarks/agentic/README.md) for the
config schema, the verbatim task definitions, and the pinned substrate setup.

## Provenance

dxkit 2.13.0, harness commit `7f801a4`, June 2026, Sonnet 4.6, model pricing as
of June 2026. Raw data: `loop-study-reps8.json` (the `dxkit` and `deferred` rows
on the `testgap` and `secretpattern` tasks).
