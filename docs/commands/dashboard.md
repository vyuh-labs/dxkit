# `vyuh-dxkit dashboard`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Single-page HTML view assembling every report that's been generated.
Doesn't run analysis — reads what's already in `.dxkit/reports/`.

## Usage

```bash
vyuh-dxkit dashboard [path]
```

## What it does

- Scans `.dxkit/reports/` for the most recent of each report type
  (health, vulnerabilities, test-gaps, quality, dev-report, bom,
  licenses)
- Renders a single browsable HTML page with one tab per report
- Writes to `.dxkit/reports/dashboard.html`

Open in your browser:

```bash
open .dxkit/reports/dashboard.html      # macOS
xdg-open .dxkit/reports/dashboard.html  # Linux
start .dxkit/reports/dashboard.html     # Windows
```

## When to use it

- After running `vyuh-dxkit report` (which runs every analyzer + the
  dashboard in one shot)
- To re-render the dashboard after running individual reports
- To share a snapshot — the HTML is self-contained, you can email or
  attach it

## What it looks like

Tabs across the top: `Overview | Health | Vulnerabilities | BoM |
Test Gaps | Quality | Dev`. Overview shows the most actionable items
across all tabs — top critical findings, score deltas (if previous
runs exist), and headline metrics.

Each tab body is the corresponding report's detailed markdown,
rendered into HTML with consistent navigation.

## Performance

< 5 seconds. Pure rendering — no scanners run.

## See also

- [`report`](report.md) — generate every report then render the dashboard in one command
