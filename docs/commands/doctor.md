# `vyuh-dxkit doctor`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Diagnose missing tools, version mismatches, environment misconfig.
The first stop when something doesn't work.

## Usage

```bash
vyuh-dxkit doctor [path]
```

## What it checks

| Category          | Examples                                                      |
| ----------------- | ------------------------------------------------------------- |
| Node version      | Node ≥ 18                                                     |
| Tool availability | Every Layer 1 + active-pack Layer 2 tool detected             |
| Tool versions     | Versions are within known-working ranges                      |
| Project shape     | `.git` exists, `.gitignore` reasonable, no obvious mis-config |
| PATH issues       | Tool present but not on PATH (e.g. `~/.local/bin` missing)    |
| Tilde expansion   | Tools installed under `~/...` paths that didn't get expanded  |
| Permissions       | `.dxkit/reports/` writable                                    |

## Output

Human-readable diagnostics with actionable next steps:

```
✓ Node 20.11.1 (✓ ≥ 18 required)
✓ Project structure looks correct
✓ All Layer 1 tools detected
✗ ruff: not found on PATH
    Install with: pipx install ruff
    Or: vyuh-dxkit tools install
✗ govulncheck: installed at ~/go/bin/govulncheck but not on PATH
    Add to PATH: export PATH="$HOME/go/bin:$PATH"
⚠ osv-scanner: 1.6.0 detected, dxkit tested against ≥ 1.7
    Upgrade: brew upgrade osv-scanner
```

Exit code:

- `0` — no issues
- `1` — at least one issue blocking analysis

## When to run

- After `npm install -g @vyuhlabs/dxkit` to verify setup
- When a report says "tool X unavailable"
- When you've installed a new tool and want to confirm dxkit sees it
- In CI before running analyzers to fail fast on env misconfig

## See also

- [`tools`](tools.md) — list + install missing tools
