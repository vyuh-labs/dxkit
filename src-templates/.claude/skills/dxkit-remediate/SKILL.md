---
name: dxkit-remediate
description: Set up and operate the remediation lane: preview the work-order plan (tiers, budgets, paused classes) at $0, run a task locally inside the verified frame (deterministic recipes first, a scoped agent only for what remains), enable the scheduled workflow, read the order ledger, and tune the budgets and the circuit breaker. Use when the user says "set up automated remediation", "have an agent fix the backlog", "why did the remediation run fail", "what will remediate cost", "the remediate PR is a draft, why", or anything about the scheduled agent lane. For deterministic dependency bumps (no agent), defer to the deps bump lane; for one-off interactive fixes, dxkit-action.
---

# dxkit remediate — the agentic remediation lane

The lane plans the repo's debt (the grandfathered build/tests, advisories a
version bump cannot fix, the lint backlog) as finite work orders and works
them in two tiers: deterministic recipes execute first at $0, and only the
remaining orders go to a scoped agent, one order per run under a derived
budget and an enforced envelope. Everything lands INSIDE dxkit's verified
frame: an entry-attributed correctness floor and the guardrail run before
any PR opens, and the agent's own claim of success is never trusted. One standing PR per task; the PR body
is the verification ledger plus the agent envelope (model, turns, spend,
outcome).

## Preview before spending anything

```bash
vyuh-dxkit remediate plan
```

Shows, per configured task, the full model resolution chain (task → tier →
driver-native model), the budget caps and which ones the driver can enforce,
and whether the agent CLI resolves here. It also lists the planned WORK
ORDERS: the finite units the run would actually work (class, tier, derived
budget, done criterion), the scheduled matrix derived from them (a task
with no open orders spawns no scheduled job), any classes the circuit
breaker has paused (with the reason and the unpause conditions), and the
spend-ceiling trim. No key needed, no spend.

Model settings (`remediate.agent.model`):
- `auto` (default) — each task uses its registry tier: light for mechanical
  work (fix-lint), standard for reasoning work (fix-build, fix-vulns,
  improve-tests). Tiers map to the driver's rolling aliases, so they never
  break when a model generation rolls over.
- a tier name (`light` | `standard` | `deep`) — pins all tasks; portable
  across drivers. `deep` is the most capable and most expensive; nothing
  selects it automatically.
- anything else — a driver-native model id passed through verbatim (a
  driver switch may invalidate it; a dated id will eventually deprecate).

## Run one task locally (human present)

```bash
vyuh-dxkit remediate --task fix-lint            # run + verify, no PR
vyuh-dxkit remediate --task fix-vulns --land pr # land the standing PR
```

Local runs work without `remediate.enabled` (that knob gates the SCHEDULED
workflow). With no API key in the environment, the claude-code driver uses
your `claude` subscription login.

## Enable the scheduled lane

1. In `.dxkit/policy.json`, uncomment / add the `remediate` stanza
   (`enabled: true`, pick `tasks`, `schedule`, budget).
2. `vyuh-dxkit update` — installs the `dxkit-remediate` workflow.
3. Set the `ANTHROPIC_API_KEY` repo secret — use a scoped workspace key
   with a spend limit, never a personal key.

The workflow triggers on schedule + manual dispatch ONLY, runs against the
default branch only, with dxkit-authored prompts only.

## How a run works (orders, recipes, the scoped agent)

Each task run plans the repo's open work orders and works them in two
tiers. Recipe-tier orders execute deterministically inside the frame first
(lockfile re-sync, an OSV-pre-checked override pin or dependency
declaration, lint autofix): $0, no agent. Remaining orders are dispatched
one order per agent run (up to `remediate.maxOrdersPerRun`), each with the
rendered order as its prompt, a budget derived from the order's findings,
and envelope enforcement at the sweep (out-of-envelope changes are dropped
with disclosure). A refused or failed recipe order falls through to the
agent tier in the same run; when nothing lands for such orders the outcome
is `recipes-refused`, never a green no-op.

The frame owns the dependency tree (and whatever else a language pack
declares as a frame-owned invariant): each order prompt tells the agent not
to edit the lockfile or run installs, and after every agent order and
recipe group the frame re-runs the pack's resync and lockfile-sync check
before verifying the order, replacing a hand-edited lockfile with the
tool's truth or failing the order at that step, named. Landing is per
order: each order's commits are verified on top of the previously verified
head, a failing order is dropped with its reason, the verified prefix
lands, and the guardrail arbitrates once over the landed head.

Every order's outcome is recorded in the lane order ledger
(`.dxkit/lanes/<lane>-<task>.orders.jsonl`). The circuit breaker
(`remediate.pauseAfterFailures`, default 2) pauses a class whose recent
counted firings are all failures (one red run counts once for a class,
however many of its orders it carried): paused orders stay planned and
disclosed but are not dispatched, so the scheduled lane stops re-spending
on the same failure. The pause lifts on a remediate policy change, a dxkit
upgrade, an explicit dispatch override (the workflow form naming the task,
or locally `vyuh-dxkit remediate --task <t> --dispatch-override`), or when
the failures age out of the 60-day history window.

## Reading an outcome

- `verified` / a green PR — the diff passed the entry-attributed floor and
  the guardrail. Pre-existing debt listed in the ledger was already failing
  before the agent ran; it is disclosed, not the agent's doing.
- `no-op` — the agent ran and committed nothing; the job summary says so.
  A no-op can also mean every selected order is paused by the circuit
  breaker (the note names the classes and the unpause conditions; $0).
- `partially-landed`: some orders verified and land (a PR is open for
  the kept set); others were dropped at their own verification, with the
  step and reason per order in the ledger, and stay open. Not clean by
  design: the dropped orders must not read as done.
- `recipes-refused`: a recipe-only plan where every recipe refused or
  failed and nothing was fixed. Non-clean by design: the orders remain
  open, and the per-order reasons are in the ledger.
- `install-failed` — a clean checkout of the agent's commits cannot be
  installed the way CI installs it (the frozen-lockfile install failed, most
  often a manifest edited without re-running the install so the lockfile
  records it). Nothing lands: CI would have died before any gate ran. The
  ledger carries the install output.
- `floor-red` — the agent's change introduced a net-new floor failure; no
  PR was opened, on purpose. The ledger names the failing checks.
- `guardrail-red` — the guardrail blocked, refused to gate, or could not
  run. Nothing lands (the agent lane fails CLOSED on verification: an
  agent-authored diff is never pushed unverified); the change stays local
  for inspection and the ledger says which case it was.
- `budget-exhausted`: a cap hit (wall-clock, turns, or spend). What
  lands follows the effective salvage for the task: `salvage` defaults to
  `auto`, which resolves open-ended tasks (`write-docs`, `improve-tests`)
  to `draft-pr` (verified partial work lands as a DRAFT marked
  budget-bounded) and bounded tasks (`fix-build`, `fix-vulns`, `fix-lint`)
  to `discard` (nothing lands; the branch stays for inspection). Pin
  `"discard"` or `"draft-pr"` in policy to force one fate for every task.
- `agent-never-ran` — infrastructure (auth, missing CLI); the reason is in
  the note. Fix the secret/install, re-dispatch.
- `sweep-failed` — the agent committed work, but the leftovers it left
  uncommitted could not be swept into a reviewable commit (a pre-commit
  hook, a signing requirement). Nothing lands: those files are staged, and
  landing would push them unreviewed. The note names the git error.
- `refused` — a trust or configuration refusal, with the remedy named.

Resume (`remediate.resume: true`, opt-in) continues a prior salvage branch
in the next run, but only when that attempt was a budget-exhausted VERIFIED
partial; a guardrail-blocked draft is never a resume anchor, and its
blocking findings ride the next run's order prompts as a negative
constraint instead. Attempts are capped at 2 per branch before the task
falls back to a fresh run and a human is expected to look at the draft.

## Tuning the budget

`remediate.agent.budget`: `maxTurns` caps agent iterations (enforced by the
shipped driver), `maxMinutes` is the wall-clock kill (enforced by the
runner; salvage applies), `maxUsd` is the spend cap. The shipped driver only
REPORTS spend after the run and cannot stop mid-run on cost, so there
`maxUsd` is advisory: an overrun is disclosed and the attempt marked
partial, and real spend is bounded by turns and wall-clock. `remediate plan`
lists which caps the configured driver cannot enforce. Start conservative
(the defaults), widen only for a task that keeps hitting `budget-exhausted`
while producing verified work; give one task headroom with
`remediate.taskBudgets.<id>` rather than widening the shared cap, and bound
a whole firing with `remediate.maxSpendPerRun`.
