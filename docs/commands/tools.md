# `vyuh-dxkit tools`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

List + install all external tools dxkit knows how to drive. The
go-to command when a report says something is "unavailable."

## Usage

```bash
vyuh-dxkit tools             # list status of all tools relevant to this repo
vyuh-dxkit tools install     # install missing tools (interactive)
```

## Options

| Option   | Effect                                                                   |
| -------- | ------------------------------------------------------------------------ |
| `--all`  | Install ALL tools across every language pack (not just the active stack) |
| `--yes`  | Skip confirmation prompts before each install                            |
| `--json` | Stdout JSON (tool status, suitable for CI scripts)                       |

## Tool layers

DXKit organizes external tools in layers:

- **Layer 1 (universal):** required regardless of stack — `cloc`,
  `gitleaks`, `semgrep`, `jscpd`, `graphify`.
- **Layer 2 (per-language):** activated only when the corresponding
  pack is detected. eslint for TypeScript, ruff for Python,
  govulncheck for Go, etc.
- **Optional:** quality-of-life enhancers (`osv-scanner-fix`, the
  EPSS/KEV enrichment endpoints, etc.). Missing-but-optional shows
  as a warning, not a hard error.

## Listing

```bash
vyuh-dxkit tools
```

Output:

```
LAYER 1 (universal — always required):
  ✓ cloc           1.96      (/opt/homebrew/bin/cloc)
  ✓ gitleaks       8.18.4    (/opt/homebrew/bin/gitleaks)
  ✓ semgrep        1.78.0    (/opt/homebrew/bin/semgrep)
  ✓ jscpd          4.0.5     (~/.local/bin/jscpd)
  ✓ graphify       0.5.0     (~/.cache/dxkit/tools-venv/bin/graphify)

LAYER 2 (typescript pack active):
  ✓ eslint         8.57.0    (./node_modules/.bin/eslint)
  ✓ npm-audit      built-in
  ✓ license-checker  built-in (npx)

LAYER 2 (python pack active):
  ✗ ruff           not found
  ✗ pip-audit      not found
  ✗ pip-licenses   not found

OPTIONAL:
  ✓ osv-scanner    1.7.4
  ✓ osv-scanner-fix  1.7.4
```

## Installing

```bash
vyuh-dxkit tools install
```

Interactively walks through every missing tool. For each, dxkit:

- Picks the right installer per platform (brew on macOS, pipx for
  Python, `go install`, `cargo install`, `npm install`)
- Shows the exact command before running
- Asks for confirmation (skip with `--yes`)
- Verifies post-install (re-detects, reports success/failure)

To install across the entire matrix (helpful when developing on
dxkit itself or pre-provisioning a multi-stack box):

```bash
vyuh-dxkit tools install --all --yes
```

## When something says "unavailable"

This is the first stop. A report that says `osv-scanner: unavailable`
or `gitleaks: not found` means tooling, not code. Run `tools` to
confirm, then `tools install` to fix.

If a tool IS installed but dxkit doesn't detect it, run
[`doctor`](doctor.md) — it surfaces PATH issues, version-pin
mismatches, etc.

## See also

- [`doctor`](doctor.md) — diagnose why a detected tool isn't working
