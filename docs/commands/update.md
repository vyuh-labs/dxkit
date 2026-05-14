# `vyuh-dxkit update`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Re-generate the scaffolded files (`.claude/`, `CLAUDE.md`, etc.)
while preserving files you've evolved since the original `init`.

## Usage

```bash
vyuh-dxkit update [options]
```

## What it does

- Reads the manifest of files dxkit originally generated (from
  `.dxkit/config.yml`)
- For each, compares the current content's hash to the at-generation
  hash
- Files with unchanged hash → safe to re-generate
- Files with changed hash → marked "evolved", preserved by default

## Options

| Option     | Effect                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------- |
| `--force`  | Overwrite even evolved files (use with caution)                                          |
| `--rescan` | Re-run codebase analysis before regenerating (picks up new files / packs since last run) |

## When to use

- After upgrading dxkit to a new version (catches new template files
  added since the original `init`)
- After adding a new language to the project (re-runs detection with
  `--rescan`)
- When the scaffold templates have improved upstream and you want the
  new versions where you haven't customized

## What "evolved" means

A file is considered evolved if its current content's hash differs
from the hash recorded at the time of original `init`. Pure
intent-based — even reformatting counts as evolved (since the hash
changes). The default behavior errs on the side of preservation;
`--force` is the explicit opt-out.

## See also

- [`init`](init.md) — original generation
