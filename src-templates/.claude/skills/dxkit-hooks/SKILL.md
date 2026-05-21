---
name: dxkit-hooks
description: Install, configure, troubleshoot, or remove dxkit git hooks. Use when the user asks "set up hooks", "pre-push isn't firing", "how do I chain with husky", "bypass the hook", or anything about pre-commit/pre-push behavior in a dxkit-managed repo.
---

# dxkit-hooks

This skill handles the git-hook surface dxkit ships. Use it to install hooks, debug "the hook didn't fire," chain dxkit with an existing hook system, or guide a bypass.

## What dxkit ships

`.githooks/pre-push` (default-on under `--full`) — runs the guardrail check before code leaves the developer's machine. Fast on warm scanner caches (~10-30s).

`.githooks/pre-commit` (opt-in via `--with-precommit-hook`) — same guardrail check but on every commit. Slower on large repos (~1-3 min on 500+ file repos). Not in `--full` by default because the wall-clock cost gates adoption.

Both run `npx vyuh-dxkit guardrail check`. The check exits 1 (blocking) on net-new findings vs. the baseline.

## Installation

```bash
# Pre-push only (recommended for most teams)
npx vyuh-dxkit init --with-hooks --yes

# Both pre-commit + pre-push
npx vyuh-dxkit init --with-hooks --with-precommit-hook --yes

# Add to an existing dxkit install (idempotent)
npx vyuh-dxkit init --with-precommit-hook --yes
```

Existing hooks at `.githooks/<name>` or `.husky/<name>` trigger sidecar-write mode: dxkit puts its hook at `.githooks/<name>.dxkit` and emits a chain note instead of clobbering.

## Activation

Hooks activate by setting `core.hooksPath = .githooks` in the local git config. Dxkit wires this via `npm postinstall` so every clone + `npm install` runs it automatically. Manual:

```bash
# Either of these works
npx vyuh-dxkit hooks activate
git config core.hooksPath .githooks
```

`npx vyuh-dxkit hooks activate` is idempotent — refuses to clobber a custom hooksPath (husky's `.husky`, lefthook's `.lefthook`, etc.). Run it to confirm the current state.

## Troubleshooting "hook didn't fire"

Walk this checklist:

1. **Hook file exists**: `ls -la .githooks/pre-push` — should be executable.
2. **hooksPath is wired**: `git config --local --get core.hooksPath` should print `.githooks`. If empty or pointing elsewhere, run `npx vyuh-dxkit hooks activate`.
3. **dxkit binary is on PATH**: from the repo root, `which npx vyuh-dxkit` should resolve (either project-local `./node_modules/.bin/vyuh-dxkit` or global). The hook delegates to whichever it finds.
4. **Baseline exists**: `test -f .dxkit/baselines/main.json` — without a baseline the guardrail has nothing to compare against. Run `npx vyuh-dxkit baseline create`.
5. **Run the check by hand**: `npx vyuh-dxkit guardrail check` from the repo root. Expected: exits 1 on net-new findings (red), 0 on clean diff (green).

If all five pass and the hook still doesn't fire, the most common cause is a competing hook system. `git config --global --get core.hooksPath` could be set globally to something else.

## Chaining with husky / lefthook / other hook managers

When dxkit detects an existing hook (`.husky/pre-commit` or `.githooks/pre-commit`), it writes `.githooks/pre-commit.dxkit` instead and prints a chain note. To wire them together, add a line at the end of the existing hook:

```bash
# .husky/pre-commit (after husky's own logic)
sh .githooks/pre-commit.dxkit
```

Order matters: run the fast lint/format hooks first, then dxkit's guardrail last (so dxkit sees the actual final diff).

For pre-push, same pattern with `.githooks/pre-push.dxkit`.

## Bypass (emergency)

When a hook blocks a push and the fix needs to land NOW (incident response, hotfix):

```bash
git push --no-verify
```

This skips ALL git hooks (not just dxkit's). After the emergency:

1. Open the .dxkit/reports/ from the blocked push to understand what got bypassed.
2. Either fix the regression in a follow-up commit OR
3. Re-baseline if the regression is intentional and accepted:
   ```bash
   npx vyuh-dxkit baseline create --force
   git add .dxkit/baselines/main.json
   git commit -m "chore(baseline): accept regression from <ref>"
   ```

Re-baselining is a deliberate action — it grants future scans permission to keep the regression. Don't do it casually; use the policy file to suppress noisy finding kinds instead.

## Disabling pre-commit (keeping pre-push)

If pre-commit becomes a wall-clock blocker:

```bash
rm .githooks/pre-commit
```

`git config core.hooksPath` stays pointed at `.githooks/` (don't unset it). Future `init` calls won't re-add pre-commit unless `--with-precommit-hook` is passed.

## Removing dxkit hooks entirely

```bash
git config --local --unset core.hooksPath
rm -rf .githooks
# Also remove the postinstall line from package.json if you want a clean uninstall
```

The CI workflows in `.github/workflows/dxkit-*.yml` continue to enforce the guardrail at PR-time, so removing local hooks doesn't disable the safety guarantees — just shifts them to CI-only.
