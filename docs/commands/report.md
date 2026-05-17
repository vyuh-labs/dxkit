# `vyuh-dxkit report`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Run every analyzer + the dashboard in one shot. The full audit.

## Usage

```bash
vyuh-dxkit report [path] [options]
```

## What it runs

In sequence, each as a separate child process (so a failure in one
doesn't take down the others):

1. `health` — 6-dimension audit
2. `vulnerabilities` — security deep scan
3. `test-gaps` — untested-file ranking
4. `quality` — lint + duplication + slop
5. `dev-report` — git activity
6. `dashboard` — assembles the above into HTML

## Options

| Option            | Effect                                                                          |
| ----------------- | ------------------------------------------------------------------------------- |
| `--with-coverage` | Pass `--with-coverage` to health + test-gaps (materializes real coverage first) |
| `--detailed`      | All analyzers write their detailed reports                                      |

## When to use

- **First-time audit** of a brownfield repo
- **Pre-release** scan — get a full snapshot of the codebase's state
- **CI scheduled runs** — periodic full audit (nightly / weekly)
- **Handoff** — share `.dxkit/reports/dashboard.html` with a teammate

## Performance

On a medium codebase: 5-15 minutes total. The long-pole varies:

- **JS-heavy repo** → `jscpd` in the quality phase dominates (8-15 min)
- **Large dep tree** → `osv-scanner` in vulnerabilities (1-3 min per pack)
- **Slow tests + `--with-coverage`** → your test suite + coverage parse
- **Python-heavy repo** → graphify Python walk (1-3 min)

## Output

Everything that each individual analyzer would write, plus the
dashboard HTML. All under `.dxkit/reports/`.

## See also

- [`dashboard`](dashboard.md) — re-render the dashboard from existing reports
- Individual report pages: [`health`](health.md), [`vulnerabilities`](vulnerabilities.md), [`test-gaps`](test-gaps.md), [`quality`](quality.md), [`dev-report`](dev-report.md)
