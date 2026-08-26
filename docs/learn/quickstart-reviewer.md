# Reviewing with dxkit: guardrail output and lane PRs

For people who review PRs in a dxkit-gated repo. Two things land in your
review queue: human PRs carrying a guardrail verdict, and PRs opened by
dxkit's own scheduled lanes.

## Reading a guardrail verdict on a human PR

- **PASSED**: the change introduced nothing in a blocking category. Existing
  repo debt is not this author's problem; do not ask them to fix unrelated
  findings the gate grandfathered.
- **PASSED with warnings**: net-new findings in warn-only categories (for
  example new test gaps under the default posture). Worth a comment if they
  matter; the gate deliberately does not force them.
- **BLOCKED**: the listed findings are net-new in this change. The author's
  options are fix, allowlist with a category and reason, or a time-boxed
  deferral. All three are visible in the diff.
- **CANNOT GATE**: the comparison itself was invalid (stale baseline, tool
  drift). Not the author's fault; the repo side re-captures. Do not merge a
  gated repo on CANNOT GATE without knowing why.

Things worth your attention as a reviewer:

- **New allowlist entries** in the diff (`.dxkit/allowlist.json` or inline
  `dxkit-allow:` annotations). The category and reason are the review
  surface: is "false-positive" actually true? Is an `accepted-risk` entry
  something this author may accept alone?
- **Deferrals**: a defer entry is a loan with an expiry that will re-block.
  Check the reason and the date are honest.
- **Policy edits**: a PR that changes `.dxkit/policy.json:checks[].command`
  executes in CI. Review it with the same scrutiny as a workflow edit.

## Reviewing lane PRs

dxkit's scheduled lanes open PRs of their own. Each type has a specific
meaning for merge:

- **Baseline refresh decision PR**: a newly published dependency advisory
  was held OUT of the baseline. **Merging the PR defers the advisory for a
  time-boxed window** (it re-blocks at expiry). Fixing means upgrading the
  dependency instead, and closing this PR. The PR body states the deadline.
- **Dependency bump PR**: a proposed upgrade, gated like any change. Review
  the changelog delta and merge or close; there is no hidden semantics.
- **Remediation PR**: produced by the remediation lane, which fixes what
  it can with deterministic recipes at $0 and hands only the remaining
  work orders to a budget-bounded agent, one order per run. The body
  carries the ledger: per-order outcomes for both tiers, each agent
  dispatch's derived budget and spend, envelope enforcement, and (for a
  custom dispatch) who dispatched it and the exact prompt. The change
  passed the same gate as a human PR, and for custom prompts the body says
  explicitly that no automated score improved; your review is the
  verification. Review the diff on its merits.

One operational note: a lane PR pushed with the default workflow credential
may show **no CI checks** (GitHub does not trigger workflows for it). The
repo admin can configure a bot token to fix this; until then, close and ask
for a re-run, or run the checks by hand. Never merge an unchecked lane PR
into a protected branch on trust.

## What you never need to do

- Re-run scanners by hand to double-check the gate: the verdict is
  deterministic and reproducible with `vyuh-dxkit guardrail check`.
- Police pre-existing debt in someone's unrelated PR: the baseline exists
  precisely so review can focus on the change.
