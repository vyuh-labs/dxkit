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

## What a failed attempt looks like

The frame holding is the feature: if the agent's work does not verify, the
run is red, nothing merges, and the blocked attempt's diff is uploaded as a
run artifact for inspection. The other tasks in a matrix run are isolated
(own checkout each) and keep going.

## Credentials the lanes need

Two GitHub settings decide whether lanes can do their jobs — both are
covered step by step in the admin quickstart, and `vyuh-dxkit doctor`
checks them:

1. "Allow GitHub Actions to create and approve pull requests" (repo or org
   Actions settings) — without it a lane pushes its branch and cannot open
   the PR.
2. The `DXKIT_BOT_TOKEN` secret — without it, lane PRs trigger no CI
   checks and cannot satisfy branch protection.

## Watching a run

Every lane streams per-phase progress with heartbeats in the Actions log
(a long silent phase means look at the last heartbeat line, not that it
hung), and remediation runs use one job per task so each task has its own
status, log, and retry button.
