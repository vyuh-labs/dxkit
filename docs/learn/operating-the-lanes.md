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

**Scheduled** is the recurring posture: the tasks enabled in
`.dxkit/policy.json` run on the workflow's cron, under the policy's
per-task budgets.

**Dispatch campaigns** are one-time runs from the GitHub Actions UI: open
the remediation workflow, press _Run workflow_, and the typed form offers:

- **task**: one task from the catalog, or `custom` with a free-text prompt
  (the prompt is transported via environment, never shell-interpolated, and
  is disclosed verbatim in the PR body);
- **spend / turn / minute overrides**: blank means policy; every value is
  clamped by the `remediate.maxDispatchBudget` org ceiling.

A custom prompt carries no score hinge, and the PR says so explicitly:
verification is the floor + the guardrail + your review. Dispatching is
write-access-gated by GitHub itself.

## Budgets, in one place

- Per-task caps (spend, turns, minutes) live in policy
  (`remediate.agent.budget`, per-task overrides in `remediate.taskBudgets`).
- `remediate.maxSpendPerRun` caps a whole scheduled run;
  `remediate.maxDispatchBudget` caps any one-off campaign.
- A task that hits its cap is "budget-bounded, not finished": nothing lands
  unless the frame verifies, and the attempt is disclosed in the run.
- With `remediate.resume` enabled, a salvaged attempt can continue in a
  later run (draft-PR salvage only, attempt-counted, capped).

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
  unmergeable), so the work and the blocking findings survive the runner
  and a resumed attempt can continue from them. Otherwise no action is
  required; the next scheduled run retries from a clean tree.
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
