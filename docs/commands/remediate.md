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
vyuh-dxkit remediate plan [path] [--json]              # dry-run: no key, no spend
vyuh-dxkit remediate [path] --task <id> [--land pr] [--json]
vyuh-dxkit remediate configured [path] [--land pr] [--json]
```

- `plan` shows, per enabled task, the task > tier > driver-native model
  resolution, the effective per-task budget, and the spend-ceiling-trimmed
  matrix the managed workflow reads.
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
- `remediate.maxDispatchBudget` (0 = undeclared): the dispatch spend
  authority. It clamps the `max_usd` override AND the `max_turns`
  override (proportionally against the policy budget) — turns govern real
  spend when the driver cannot enforce cost mid-run, so an unclamped turn
  override would be a back door around the ceiling.

## Salvage and resume

`remediate.salvage` defaults to `discard`: a partial diff from a
budget-killed run is dropped. With `draft-pr`, the partial lands as a
draft PR marked partial. With `remediate.resume: true` (opt-in), the next
run continues from that salvage branch instead of starting over, up to 2
attempts per branch before falling back to a fresh run. The entry floor
still snapshots the pristine default tree first, so a broken partial
reads as net-new and can never grandfather its own breakage.

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

## Credentials and enablement

The default driver is `claude-code`. In CI the workflow injects the
`ANTHROPIC_API_KEY` repo secret; only the driver's declared credential
names are forwarded, never the whole environment. Locally the driver's
own default applies (subscription mode). `remediate.enabled: true` gates
the scheduled workflow only; the local CLI runs regardless, since a human
at a terminal is its own consent.

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
