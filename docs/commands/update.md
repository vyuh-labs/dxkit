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
- **Migrates your baseline + allowlist if a dxkit upgrade changed the
  finding-identity scheme** (see below) — so the upgrade is one command,
  not a manual re-baseline

## Identity-scheme migration (run after every upgrade)

dxkit stamps each `.dxkit/baselines/*.json` and `.dxkit/allowlist.json`
with the finding-identity scheme it was written under. When a new dxkit
version changes that scheme, `update` detects the gap and migrates
automatically:

- **Re-anchors your allowlist** — rewrites each entry's `fingerprint` onto
  the new scheme, preserving every reviewed suppression. You don't
  re-review anything or copy fingerprints from reports. (Inline
  `dxkit-allow:` source comments are unaffected — they match by location.)
- **Regenerates the baseline** onto the new scheme (only if one already
  exists — `ref-based` repos gain no baseline).
- **Reports** what it re-anchored / left unchanged, and flags any allowlist
  entry whose finding no longer exists (review + prune those).

So the full upgrade is:

```bash
npm i -D @vyuhlabs/dxkit@latest
vyuh-dxkit update
git add .dxkit && git commit -m "chore(dxkit): adopt latest"
```

If you skip `update` and run `vyuh-dxkit guardrail check` against a
pre-upgrade `committed-full` baseline, the guardrail stops with an explicit
"run `vyuh-dxkit update`" message rather than reporting every existing
finding as net-new. The manual equivalent is `vyuh-dxkit baseline create
--force` plus re-adding fingerprint-based allowlist entries by hand.

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
