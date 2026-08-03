# `vyuh-dxkit jobs`

The operability answer to "which dxkit jobs run here, when, and did they
work?". One read-only view over the installed dxkit workflows: each
trigger, the actual cron parsed from the workflow file, the computed next
run (UTC), the last run's outcome when the `gh` CLI is available, and the
run-it-now command for anything dispatchable.

## Usage

```bash
vyuh-dxkit jobs           # runs against the current directory
vyuh-dxkit jobs --json    # structured: { "jobs": [...] }
```

## Options

| Option   | Effect                                          |
| -------- | ----------------------------------------------- |
| `--json` | Emit the rows as JSON instead of the text table |

## Behavior

- Rows come from the dxkit-owned workflow namespace on disk,
  `.github/workflows/dxkit-*.yml` (also `.yaml`). Any lane that installs
  a workflow appears here the day it lands; there is no separate registry
  to update.
- Triggers and crons are parsed from the workflow file itself, the truth
  of what actually executes. Detecting policy-vs-file drift is the parity
  gate's job, not this view's.
- The next scheduled fire is computed in UTC from the cron expression,
  with standard cron day semantics (when both day-of-month and
  day-of-week are restricted, a date matching either fires).
- The last-run column is probed via
  `gh run list --workflow <file> --limit 1`. When `gh` is absent,
  unauthenticated, or the workflow has never run, the column is simply
  omitted; the command degrades silently rather than failing.
- Workflows with `workflow_dispatch` are listed as runnable now, with the
  exact `gh workflow run <file>` command printed.
- With no dxkit workflows installed, the command points at
  `vyuh-dxkit init --with-ci` (or enabling a lane knob such as
  `depBump.enabled`).

Schedules themselves live in `.dxkit/policy.json`. Change one with
`vyuh-dxkit policy set <knob> <value>` and the workflows re-render
automatically; this command then shows the new cron because it reads the
rendered file.

## See also

- [Operating the lanes](../learn/operating-the-lanes.md), the runbook for
  the scheduled lanes this command lists
- [`.dxkit/policy.json` reference](../configuration/policy.md) for the
  schedule knobs
- [`vyuh-dxkit remediate`](remediate.md) and
  [`vyuh-dxkit doctor`](doctor.md)
