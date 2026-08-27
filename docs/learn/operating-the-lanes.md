# Operating the lanes: schedules, campaigns, and budgets

For whoever owns dxkit's scheduled automation in a repo. Everything here is
observable in GitHub Actions and lands only via pull requests through the
same gate as a human change.

## The three lane families

- **Baseline refresh** re-captures findings on a cadence and raises newly
  published dependency advisories as a decision PR: merging it defers the
  advisory for a time-boxed window (it re-blocks at expiry); fixing means
  upgrading the dependency and closing the PR.
- **Dependency bump** proposes upgrades as ordinary PRs.
- **Remediation** runs budget-bounded agent tasks. Each task's outcome is
  re-verifiable without reading prose: the correctness floor and the
  guardrail always run, and score-hinged tasks must additionally move their
  target dimension above the pristine-tree entry score or nothing lands.

The task catalog (what each task does, its model tier and why, and what its
outcome hinges on) is on the Remediation tasks page of this guide, rendered
from the same registry the lane executes.

## Scheduled runs vs one-off campaigns

**Scheduled** is the recurring posture, and it is order-driven: each firing
plans the repo's open WORK ORDERS (finite, verifiable units cut from the
entry floor's failures, deferred advisories inside their window, and the
lint backlog), then spawns one job per enabled task that has open orders,
highest value first, under the policy's budgets. A task with no open orders
spawns no job at all (a healthy repo's firing costs nothing), and the plan
job's notices say why each absent task is absent. Open-ended tasks
(`improve-tests`, `write-docs`) have no orders by nature: they run only
when policy lists them explicitly, and the plan discloses them as the
legacy open-ended shape.

**Dispatch campaigns** are one-time runs from the GitHub Actions UI: open
the remediation workflow, press _Run workflow_, and the typed form offers:

- **task**: one task from the catalog, or `custom` with a free-text prompt
  (the prompt is transported via environment, never shell-interpolated, and
  is disclosed verbatim in the PR body);
- **spend / turn / minute overrides**: blank means policy; every value is
  clamped by the `remediate.maxDispatchBudget` org ceiling.

A custom prompt carries no score hinge, and the PR says so explicitly:
verification is the floor + the guardrail + your review. Dispatching is
write-access-gated by GitHub itself. Dispatching a task also overrides a
circuit-breaker pause on that task's order classes for that one run (the
current workflow template passes the explicit override flag through; run
`vyuh-dxkit update` if a dispatch does not lift a pause), which is the
designed way to say "try again now".

## Orders, recipes, and the circuit breaker

Inside each task run, the frame works the plan in two tiers:

- **Recipes** (deterministic, $0): a registered recipe executes an order
  inside its envelope with no agent at all (lockfile re-sync, an override
  pin with an OSV pre-check, declaring a missing dependency, lint autofix).
  A recipe that cannot act refuses with the reason named; a refused or
  failed recipe order falls through to the agent tier in the same run.
- **The scoped agent**: each remaining order is one agent run with the
  rendered order as its prompt (findings, evidence, envelope, constraints,
  the done command), a budget derived from the order, and envelope
  enforcement at the sweep, up to `remediate.maxOrdersPerRun` per firing.

- **Frame-owned invariants**: what the frame reserves to itself (the
  dependency install, the lockfile matching the manifest, anything else
  the language pack declares) is stated in the order prompt and
  re-established by the frame after every agent order and recipe group,
  before verification. A hand-edited lockfile is replaced by the pack's
  own resync; an invariant the frame cannot re-establish fails that
  order at that step, named.
- **Per-order landing**: each order's commits are verified on top of the
  previously verified head. A failing order is dropped with its reason
  and the run lands the verified prefix; the guardrail arbitrates once
  over the landed head. Kept plus dropped orders is the
  `partially-landed` outcome: not clean, a PR for the kept set, the
  dropped orders named as still open. Pre-existing lockfile drift at the
  order base is disclosed, never blamed on the order and never rewritten
  inside its PR; and a verification that could not run at all
  (infrastructure) keeps the commits on the branch and completes
  `verification-unavailable` instead of destroying or landing anything.

Every order's outcome is recorded in the lane's order ledger
(`.dxkit/lanes/<lane>-<task>.orders.jsonl`): rows ride a landed PR's own
diff, and a run that lands nothing pushes its rows as a metadata commit on
the task's standing branch, so the memory survives the ephemeral runner.
A dropped order records the step that dropped it, so the breaker counts
that order's class, never the whole run.

**The circuit breaker** (`remediate.pauseAfterFailures`, default 2) reads
that ledger: a class whose last N counted FIRINGS are failures
(guardrail-red, floor-red, install-failed, a failed recipe; one red run
counts once however many orders it carried; refusals and infrastructure
never count) is PAUSED. Paused orders are still planned and shown, but
nothing dispatches them, and the plan output, the run ledger, and the
workflow notices all carry the reason plus the unpause conditions. A
pause lifts when the remediate policy changes, when dxkit is upgraded,
when you dispatch an explicit override (the workflow's Run-workflow form
naming the task, or locally
`vyuh-dxkit remediate --task <t> --dispatch-override`), or when the
failures age out of the 60-day history window (disclosed as the retry
horizon engaging). The weekly lane stops re-buying the same failure; you
decide when it retries.

## Budgets, in one place

- Per-task caps (spend, turns, minutes) live in policy
  (`remediate.agent.budget`, per-task overrides in `remediate.taskBudgets`).
- `remediate.maxSpendPerRun` caps a whole scheduled run;
  `remediate.maxDispatchBudget` caps any one-off campaign.
- A task that hits its cap is "budget-bounded, not finished": nothing lands
  unless the frame verifies, and the attempt is disclosed in the run.
- With `remediate.resume` enabled, a salvaged attempt can continue in a
  later run. Resume only anchors on a budget-exhausted VERIFIED partial
  (draft-PR salvage, attempt-counted, capped at 2 per branch); a
  guardrail-blocked draft is never resumed, and its blocking findings ride
  the next run's order prompts as a negative constraint instead.

## Estimating spend

The worst case is arithmetic, but be precise about which caps are hard:
`maxTurns` and `maxMinutes` are enforced by the runner/CLI; **`maxUsd` is
advisory for the claude-code driver** (spend is reported after the run,
not stopped mid-run — the ledger says so). Real spend is bounded by the
turn cap, so the projection uses observed cost-per-turn, and dispatch
turn overrides are clamped against `remediate.maxDispatchBudget` so a
one-off campaign cannot silently raise the ceiling.

> worst-case monthly spend ≈ enabled tasks × runs per month × per-task
> cap (default $5, turn-bounded), additionally capped by
> `remediate.maxSpendPerRun` each run.

`remediate plan` prints the per-run projection (the sum of the matrix
tasks' caps — each matrix task is its own invocation with its own cap).
Example: 3 enabled tasks on the default weekly schedule, default caps:
3 × 4 × $5 = $60/month ceiling. Real runs usually land far below their cap
(a typical fix task spends $1–3), and every PR body discloses the actual
spend, so after two weeks you have your own numbers. One-off campaigns are
separately capped by `remediate.maxDispatchBudget`.

## What a failed attempt looks like

The frame holding is the feature: if the agent's work does not verify, the
run is red, nothing merges, and the blocked attempt's diff is uploaded as a
run artifact for inspection. The other tasks in a matrix run are isolated
(own checkout each) and keep going.

## When a run is red

Read the task's job summary first — it names the outcome. The shapes:

- **`guardrail-red` / floor failed** — the frame held: the agent's change
  did not verify, so nothing merges. The attempt's diff is attached to the
  run as an artifact (Actions run page, Artifacts section). Under
  `draft-pr` salvage a guardrail-blocked attempt is additionally pushed as
  a red draft PR titled "do not merge" (its own guardrail check keeps it
  unmergeable), so the work and the blocking findings survive the runner;
  the next run starts fresh with those findings as a negative constraint
  (a blocked diff is never a resume anchor). Otherwise no action is
  required; the next scheduled run retries from a clean tree, and after
  `remediate.pauseAfterFailures` consecutive failures the class is paused
  instead of retried (see the circuit breaker above).
- **`partially-landed`**: some orders verified and landed (a PR is
  open for them); the others were dropped at their own verification
  with the reason in the job summary, and stay open for the next firing.
  The job is red so the dropped orders are not read as done.
- **`recipes-refused`**: every order the task selected was recipe-tier,
  every recipe refused or failed, and the agent tier landed nothing for
  them. The orders remain open and the per-order reasons are in the job
  summary; these orders need a policy change, the agent tier, or a human.
- **Budget-bounded, not finished** — the task hit its spend / turn / time
  cap mid-work. Also lands nothing. If it happens repeatedly on the same
  task, raise that task's budget (`remediate.taskBudgets`) or enable
  `remediate.resume` so a salvaged attempt (draft-PR salvage,
  attempt-counted) can continue next run instead of starting over.
- **Skipped: "an earlier task left unlanded work in the tree"** — task
  isolation working as designed; the skipped tasks run next time.
- **`agent-never-ran`** — the agent CLI/API failed before any work
  happened: an invalid or credit-exhausted `ANTHROPIC_API_KEY`, a missing
  CLI, a bad flag. The job is red and the ledger names the provider's own
  cause (for example `agent never ran: Credit balance is too low`) — fix
  the key or credit on the provider side; no dxkit change is involved.
- **`agent-failed`** — the run started, then ended in an error with no
  committed change. The ledger carries the driver-reported cause and the
  job log carries the agent's last output lines.
- **Degraded credentials, disclosed in the log** — the run fell back to
  `GITHUB_TOKEN` (missing or expired `DXKIT_BOT_TOKEN`): the PR opens but
  gets no CI checks, or with the Actions PR-creation setting off, the
  branch pushes but no PR opens. The log names the missing piece;
  `vyuh-dxkit doctor` confirms it from your machine.
- **Missing agent key** — the remediation lane cannot run its driver at
  all; the run says which secret is absent (see credentials below).
- **CANNOT GATE inside the lane** — not the agent's fault: the baseline is
  stale or a scanner drifted, so the gate refuses to attribute. Re-capture
  via the baseline-refresh workflow (dispatch it manually if needed); the
  lane behaves normally once attribution is restored.

Each remediation task is its own job, so the Actions "re-run job" button
retries one task without re-running the others.

## Credentials the lanes need

Three credentials decide whether lanes can do their jobs — the GitHub two
are covered step by step in the admin quickstart
(`docs/learn/quickstart-admin.md`), and `vyuh-dxkit doctor` checks them:

1. "Allow GitHub Actions to create and approve pull requests" (repo or org
   Actions settings) — without it a lane pushes its branch and cannot open
   the PR.
2. The `DXKIT_BOT_TOKEN` secret — without it, lane PRs trigger no CI
   checks and cannot satisfy branch protection.
3. **The agent key** (remediation lane only) — the driver's API key as a
   repo secret, `ANTHROPIC_API_KEY` for the default `claude-code` driver.
   Use a scoped workspace key with a provider-side spend limit, never a
   personal key: dxkit's budget caps are enforced by the runner, and the
   key's own limit is the independent backstop. Set it with
   `gh secret set ANTHROPIC_API_KEY`; an absent or expired key is
   disclosed in the run log, and the other two lanes are unaffected.

## Watching a run

Every lane streams per-phase progress with heartbeats in the Actions log
(a long silent phase means look at the last heartbeat line, not that it
hung), and remediation runs use one job per task so each task has its own
status, log, and retry button.
