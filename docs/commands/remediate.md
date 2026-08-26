# `vyuh-dxkit remediate`

Run a coding agent on the debt the deterministic lanes cannot close: the
grandfathered broken build, advisories a version bump cannot fix, the
lint backlog, missing tests, missing docs. The agent runs inside a
verified frame, and its own claim of success is never trusted: an entry
correctness-floor snapshot is captured on the pristine tree before the
agent spawns, then after the run a leftover sweep, a full-scope floor
attributed against that entry (only net-new failures block; pre-existing
debt is disclosed, never weaponized), and the guardrail as final arbiter.
Work lands only as a PR carrying the verification ledger.

## Usage

```bash
vyuh-dxkit remediate plan [path] [--json] [--with-floor]  # dry-run: no key, no spend
vyuh-dxkit remediate [path] --task <id> [--land pr] [--json]
vyuh-dxkit remediate configured [path] [--land pr] [--json]
```

- `plan` shows, per enabled task, the task > tier > driver-native model
  resolution, the effective per-task budget, and the spend-ceiling-trimmed
  matrix the managed workflow reads. It also lists the planned WORK ORDERS
  (`workOrders` in `--json`): the finite units the run consumes (recipe-tier
  orders execute deterministically in the frame; the remaining agent-tier
  orders are dispatched one order per agent run, up to
  `remediate.maxOrdersPerRun`), built from the entry floor, deferred advisories inside their
  window (joined to the live dependency scan), and the lint backlog, each
  with its class, tier (`recipe` where a registered recipe matches, else
  `agent`), derived budget, and done criterion. Findings no class can take
  are listed under `undispatchable` with the reason. The floor is read from
  the baseline's recorded envelope (or the loop snapshot) so the plan stays
  cheap; `--with-floor` runs the live floor instead, and the output says
  which source it used (`workOrderFloorSource`). The scheduled matrix
  (`matrixTasks`) is derived from the OPEN orders in value order: a task
  with no open orders spawns no scheduled job, open-ended tasks
  (`improve-tests`, `write-docs`) appear only when policy lists them
  explicitly (disclosed as the legacy shape), and classes the circuit
  breaker paused are shown with the reason and the unpause conditions
  (`pausedClasses`). A dispatch naming a task bypasses the matrix and runs
  exactly that task.
- `--task <id>` runs one task. With `--land pr` a `verified` outcome (or a
  `budget-exhausted` one under the `draft-pr` salvage policy) pushes the
  standing branch `dxkit/remediate-<task>` and opens or updates its PR.
- `configured` runs every policy-configured task through the same
  executor; this is the scheduled workflow's entry point. Tasks share one
  tree, so a task that leaves unlanded work stops the loop and the
  remaining tasks are named as skipped.

Landing is refused from a named non-default branch (it would push
unrelated commits into the standing PR); run from the default branch or a
detached CI checkout.

## Tasks

| Task            | Verified by             | Notes                                                      |
| --------------- | ----------------------- | ---------------------------------------------------------- |
| `fix-build`     | correctness floor       | skipped (`no-op`, $0) when the entry floor is green        |
| `fix-vulns`     | guardrail               | the default task when policy lists none                    |
| `fix-lint`      | guardrail               | light model tier (mechanical work)                         |
| `improve-tests` | correctness floor       | works the test-gap CRITICAL bucket first                   |
| `write-docs`    | guardrail + score hinge | Documentation score must end higher, Quality must not drop |

Prompts are dxkit-authored constants; the scheduled lane never runs
user-supplied text. A sixth id, `custom`, exists only for dispatch
campaigns (below) and can never be scheduled from policy.

## Budgets (from `.dxkit/policy.json`)

- `remediate.agent.budget`: `maxTurns` (default 80), `maxMinutes` (30),
  `maxUsd` (5). What each cap can actually DO depends on the driver and is
  declared per dimension (`enforced` / `reported` / `none`) and disclosed
  in the ledger. For `claude-code`: `maxTurns` and `maxMinutes` are
  enforced; **`maxUsd` is advisory** — the CLI reports spend only after
  the run and cannot stop mid-run on cost, so real spend is bounded by
  the turn cap and wall clock (an overrun is disclosed and the attempt
  marked partial).
- `remediate.taskBudgets.<id>`: per-task overrides merged over the shared
  budget.
- `remediate.maxSpendPerRun` (0 = no ceiling): run-level USD ceiling;
  tasks beyond it are deferred to the next firing, in declaration order,
  and named. `remediate plan` prints the per-run projection (the sum of
  the matrix tasks' caps) either way — each matrix task is its own
  invocation with its own cap, so one firing may spend the sum.
- `remediate.pauseAfterFailures` (default 2, 0 = off): the circuit
  breaker. A work-order class whose last N counted outcomes are failures
  (guardrail-red, floor-red, install-failed, a failed recipe; refusals and
  infrastructure never count) is paused: planned but not dispatched,
  always disclosed. The pause lifts on a remediate policy change, a dxkit
  upgrade, an explicit dispatch of the owning task, or when the failures
  age out of the 60-day order-history window. Outcome rows live in
  `.dxkit/lanes/<lane>-<task>.orders.jsonl` (committed with a landing;
  pushed as a metadata commit on the standing branch when nothing lands).
- `remediate.maxDispatchBudget` (0 = undeclared): the dispatch spend
  authority. It clamps the `max_usd` override AND the `max_turns`
  override (proportionally against the policy budget) — turns govern real
  spend when the driver cannot enforce cost mid-run, so an unclamped turn
  override would be a back door around the ceiling.

## Salvage and resume

`remediate.salvage` defaults to `auto`: the decision follows each task's
declared completion shape. Open-ended tasks (`write-docs`,
`improve-tests`) have no completion test — the agent stops when a cap
cuts it off, never because it is done — so `discard` would throw away
their verified, gate-passing work every run; they default to `draft-pr`.
Bounded tasks (`fix-build`, `fix-vulns`, `fix-lint`) can genuinely
finish, so they keep the conservative `discard`. Pin `discard` or
`draft-pr` in policy to override every task.

Under `draft-pr`, a budget-cut partial lands as a draft PR marked
partial, and a guardrail-BLOCKED attempt lands as a red draft titled "do
not merge" — its own required guardrail check keeps it unmergeable, so
nothing merges while the work and the exact blocking findings survive
the ephemeral runner. An unrunnable guardrail never pushes anything.

With `remediate.resume: true` (opt-in), the next run continues from that
salvage branch instead of starting over, up to 2 attempts per branch
before falling back to a fresh run (the attempt counter is pushed with
the branch, so a no-op resume still consumes an attempt). A resumed
attempt after a guardrail block gets the prior blocking findings in its
prompt, so it starts from "close these", not from scratch. The entry
floor still snapshots the pristine default tree first, so a broken
partial reads as net-new and can never grandfather its own breakage.

## Dispatch campaigns

The managed workflow (`.github/workflows/dxkit-remediate.yml`) also
accepts `workflow_dispatch` with typed inputs: task selection, budget
overrides (`maxUsd`, `maxTurns`, `maxMinutes`), model, and, for the
`custom` task, a free-text prompt. Dispatch is write-gated by GitHub, the
prompt is transported via env (never shell-interpolated), budget
overrides are clamped to `maxDispatchBudget` (spend authority grows only
in committed policy), and the ledger and PR body disclose the dispatcher
and the verbatim prompt. The work still lands only through the identical
verified frame.

## The in-loop gate

The claude-code driver arms the dxkit Stop-gate (`DXKIT_LOOP_ACTIVE=1`),
so an agent's stop attempt re-runs the guardrail inside the session and
bounces net-new findings back while the working context is warm. For the
hook to actually load, the checkout must be a trusted workspace: on CI
runs the lane pre-trusts its own checkout before spawning (a deliberate
trust decision — the lane checks out the maintainers' default branch,
the same tree whose npm scripts and workflows CI already executes), then
probes the wiring end to end. The envelope and ledger disclose the
result on every run: `in-loop gate: ARMED` or `BACKSTOP-ONLY` with the
first missing link named, so a run without the in-loop gate never reads
identically to one with it.

Structural limit, worth knowing: a `max_turns` kill never reaches a
stop attempt, so even a wired Stop-gate cannot fire at the cap. In-loop
gating helps every completion attempt before the cap; the post-run
verified frame remains the final word either way.

## Credentials and enablement

The default driver is `claude-code`. In CI the workflow injects the
`ANTHROPIC_API_KEY` repo secret; only the driver's declared credential
names are forwarded, never the whole environment. Locally the driver's
own default applies (subscription mode). `remediate.enabled: true` gates
the scheduled workflow only; the local CLI runs regardless, since a human
at a terminal is its own consent.

### The lane token (three tiers)

The lanes push branches and open PRs, and PRs opened with the default
`GITHUB_TOKEN` run **no checks** (GitHub's robot-loop rule), which makes
them unmergeable under branch protection. The workflows resolve their
token through one chain, best tier first:

1. **GitHub App** (preferred): set the `DXKIT_APP_ID` repository (or
   org) _variable_ and the `DXKIT_APP_PRIVATE_KEY` _secret_, with the
   app installed on the repo holding contents + pull-requests write. The
   workflow mints a short-lived installation token per run — no billed
   seat, the PAT-expiry class cannot recur, and lane PRs are attributed
   to the app's own bot identity, so a maintainer can approve them. A
   configured-but-broken app fails the mint step loudly rather than
   silently degrading a tier. One lifetime fact to know: GitHub caps an
   installation token at **one hour**, so the remediate lane re-mints
   immediately before the task step (the hour starts at agent launch,
   not at job start) and clamps the agent's wall-clock budget to 45
   minutes on this tier — disclosed in the run's envelope — so the
   landing push always fits inside the token. Runs that need a longer
   wall clock should use the PAT tier.
2. **`DXKIT_BOT_TOKEN`** (a PAT with repo scope): works today,
   attributed to the PAT's owner (who then cannot approve the lane's
   PRs), and expires on the PAT's schedule.
3. **The default token**: functional, but the lane's PRs run no checks —
   the workflow says so with a run notice, and `doctor` flags it at
   setup time.

Exit code is the truthful aggregate: any task that did not end
`verified`, `no-op`, or a landed salvage draft exits 1.

## See also

- [Operating the lanes](../learn/operating-the-lanes.md) for the
  day-to-day lane workflow
- [`vyuh-dxkit jobs`](jobs.md) to see when the scheduled lane fires
- [`.dxkit/policy.json` reference](../configuration/policy.md) for the
  `remediate` block
- [Admin quickstart](../learn/quickstart-admin.md) for credential setup
- [`vyuh-dxkit guardrail check`](guardrail.md), the frame's final arbiter
