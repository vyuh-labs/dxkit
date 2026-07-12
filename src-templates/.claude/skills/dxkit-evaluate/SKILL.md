---
name: dxkit-evaluate
description: Run dxkit's zero-write trial — replay a repo's recent merged changes through the deterministic gate and report what it would have blocked and what enabling dxkit costs, without writing anything to the repo. Use when the user asks "would dxkit help here", "try dxkit on this repo", "what would dxkit have caught", "is dxkit worth enabling", or wants to evaluate dxkit before installing it.
---

# dxkit-evaluate

This skill answers the pre-adoption question honestly: **what would dxkit's
gate have done on this repo's real history, and at what cost?** It runs the
real guardrail — the same code path the installed Stop-gate and CI gate use —
against historical ref pairs, in disposable temp worktrees. Nothing is
written to the repo: no `.dxkit/`, no baseline, no hooks.

## Running the trial

The default replays the last 10 landings (merged PRs / squash commits) of the
current branch:

```bash
vyuh-dxkit evaluate                      # last 10 landings, security-only posture
vyuh-dxkit evaluate --last-prs 20        # more history
vyuh-dxkit evaluate --preset full-debt   # also gate test gaps + quality regressions
vyuh-dxkit evaluate --base origin/main~5 --head origin/main   # one explicit range
vyuh-dxkit evaluate --json               # the versioned evidence document
vyuh-dxkit evaluate --json --redact      # shareable: file paths + lines stripped
```

## Reading the result

- **Blocked landings** list the exact net-new findings the gate would have
  returned for repair. Dependency findings on old landings carry an
  anachronism note (advisories are current-day) — say so when summarizing.
- **A clean replay is a positive result, not an empty one**: it means the
  repo's existing debt would be grandfathered and the gate would have stayed
  out of the way. Present it that way — the gate's value is blocking the
  regression that hasn't happened yet, and the trial just measured its
  false-block behavior on real history.
- **The costs section is measured, not modeled**: gate latency comes from
  this trial on this machine, the interruption rate from the repo's own
  history. Quote those numbers; do not invent others.
- Some finding classes are structurally excluded from a ref-vs-ref replay
  (duplication, test gaps, custom checks) — the output discloses this. Do
  not claim the trial covered them.

## Next steps to offer

- Clean history and the user wants to see a block happen:
  `npx -y @vyuhlabs/dxkit@latest demo loop-guardrail` (20 seconds, fixture
  repo, their repo untouched).
- Ready to enable: `npm init @vyuhlabs/dxkit -- --claude-loop --yes`, then
  `vyuh-dxkit baseline create`. Everything is reversible via
  `vyuh-dxkit uninstall`.
