---
description: Generate a self-contained HTML dashboard from all dxkit reports
---

Run the deterministic CLI to render `.dxkit/reports/*` into
`.dxkit/reports/dashboard.html`. No LLM templating — the HTML is a
pure function of the report markdowns and their JSON envelopes.

```bash
npx vyuh-dxkit dashboard . 2>/dev/null
```

The dashboard features:
- Dark theme with modern design
- Sidebar navigation grouped by report type with color-coded badges
- Overview tab synthesizing health score, dimension breakdown, key
  metrics, and the top critical issues
- Full markdown rendering with styled tables, code blocks, headings
- Responsive layout (works on mobile)
- Print-friendly styles

If `vyuh-dxkit dashboard` isn't available (older dxkit version), fall
back to the `dashboard-builder` agent. The agent is also the right
tool when the user asks for natural-language narrative on top of the
dashboard (e.g., "explain the highest-priority items" or "summarize
this for an exec").

$ARGUMENTS
