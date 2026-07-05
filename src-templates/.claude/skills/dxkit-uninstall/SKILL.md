---
name: dxkit-uninstall
description: Cleanly and non-intrusively remove dxkit from a repo, restoring its exact pre-dxkit state — reverse every additive merge (settings.json, CLAUDE.md, .gitignore, package.json), delete every file dxkit created, and clean up hooks + CI + the .dxkit/ tree. Dry-run first. Use when the user says "remove dxkit", "uninstall dxkit", "get rid of dxkit", "clean up dxkit from this repo", "how do I undo dxkit init", or wants to stop using dxkit.
---

# dxkit-uninstall

This skill owns **removing dxkit** from a repo. Its one guarantee: after uninstall, the repo is back to its **exact pre-dxkit state** — every file dxkit created is gone, and every additive change dxkit made to a file you already had is reversed, leaving your own content byte-for-byte intact.

## What it removes vs reverts

dxkit's footprint falls into two kinds, handled differently:

- **Files dxkit created** (they didn't exist before): `.dxkit/`, the `dxkit-*` skills under `.claude/`, `AGENTS.md`, the git hooks in `.githooks/`, the `dxkit-*` GitHub workflows, `.dxkit-ignore`, and `.vyuh-dxkit.json`. These are **removed** outright.
- **Additive merges into files you already had**: the `.gitignore` runtime-output block, the `CLAUDE.md` loop block (between `<!-- dxkit:loop:start -->` / `end -->`), the `.claude/settings.json` hooks (`context-hook` / `stop-gate`), and the `package.json` `@vyuhlabs/dxkit` devDependency + postinstall. These are **surgically reverted** — only dxkit's additions are stripped; your keys, prose, and formatting are preserved.

It knows exactly what is dxkit's because `init` recorded a manifest (`.vyuh-dxkit.json`) with a hash of every created file. A dxkit-created file you have since **edited** is surfaced and **skipped** (not clobbered) unless you pass `--force`.

## How to run it

```bash
# 1. Dry run FIRST (default) — prints exactly what will be removed/reverted,
#    changes nothing.
npx vyuh-dxkit uninstall

# 2. Apply it.
npx vyuh-dxkit uninstall --yes
```

Useful flags:

- `--remove-devdep` — also remove the `@vyuhlabs/dxkit` devDependency + postinstall from `package.json` (kept by default so a lockfile install doesn't break mid-cleanup). After it edits `package.json`, run your package manager's install to prune the lockfile — the CLI prints the exact command for your PM (`npm ci` / `pnpm install` / `yarn install` / `bun install`).
- `--keep-baselines` — keep the curated, git-tracked artifacts (`.dxkit/baselines/`, the allowlist, `.dxkit/external/`) and remove only the runtime state. Use this if you want to pause dxkit but keep your grandfathered debt inventory.
- `--force` — also remove dxkit-created files you have edited (default: skip + warn).
- `--no-feedback` — skip the feedback prompt.
- `--json` — machine-readable plan/result.

## Verifying the restore

On a git repo, the definitive check is that the working tree returns to clean:

```bash
git status        # after `uninstall --yes`, dxkit's changes are gone
```

If you had committed dxkit's files (baselines, workflows), those show as deletions to commit — that is expected; uninstall only edits the working tree, never git history.

## Package-manager notes

- **After `--remove-devdep`, run your PM's install** to prune the lockfile (the CLI prints the exact command). Non-npm repos need their own PM — `pnpm install` / `yarn install` / `bun install`, not `npm install`.
- **pnpm with a release-age policy** (`minimumReleaseAge`): if your `pnpm-workspace.yaml` has a `minimumReleaseAgeExclude` entry for `@vyuhlabs/dxkit`, keep it until AFTER `pnpm install` prunes dxkit from the lockfile, THEN remove the exclusion and `pnpm install` again. Removing it first makes the stale lockfile fail `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` before it can prune. (That exclusion was added by pnpm, not dxkit, so uninstall does not touch it.)
- **`@vitest/coverage-v8`**: if you ran `vyuh-dxkit tools install`, it may have added this devDependency for `vyuh-dxkit coverage`. It is not part of dxkit's install manifest, so uninstall leaves it — remove it by hand if you don't want it (`<pm> remove @vitest/coverage-v8`).

## The feedback prompt (optional, opt-in)

On completion, the CLI prints a **prefilled GitHub issue URL** and invites you to share why you're removing dxkit. Nothing is sent automatically — it is a link you choose to open; there is no telemetry. Skip it with `--no-feedback`. If the user wants to leave feedback, open the URL it printed (or run `npx vyuh-dxkit issue --type=uninstall --about="…"`).

## What NOT to do

- Do **not** hand-delete `.dxkit/` and the workflows and call it done — that leaves the additive merges (settings.json hooks, CLAUDE.md block, .gitignore entries, package.json devDep) behind. Use `uninstall`, which reverses those too.
- Do **not** run `--force` reflexively — the skip-and-warn on edited files is there so you don't lose work you put into a dxkit-created file. Review the warnings first.
