# `vyuh-dxkit guardrail`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use.

Diff a current scan against a committed [`baseline`](baseline.md) and
classify each finding as `added` / `relocated` / `tooling_drift` /
`config_drift` / `persisted` / `removed` / `fixed`. Block on net-new
regressions per the brownfield policy; exit non-zero so a pre-commit
hook, pre-push hook, or CI workflow can stop the commit/push/merge.

The matcher is git-aware: it knows about file renames (`-M`), absorbs
line drift via fuzzy ±2 windows, and falls back to content-hash
matching when line locators aren't enough. Each match pair carries a
confidence in [0, 1] and structured `reason` codes
(`exact-id`, `git-line-exact`, `git-line-fuzz`, `git-rename`, ...).

## Usage

```bash
vyuh-dxkit guardrail check [path] [--name <n>] [--baseline <path>]
                           [--changed-only] [--policy <path>]
                           [--json | --markdown]
```

| Option           | Effect                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `path`           | Repo root to scan. Defaults to `.`                                                                                   |
| `--name <n>`     | Baseline name (`.dxkit/baselines/<n>.json`). Default `main`                                                          |
| `--baseline <p>` | Explicit baseline file path (overrides `--name`)                                                                     |
| `--changed-only` | Drop new-side pairs whose anchor line falls outside the working-tree diff. Use in pre-commit hooks; skip in PR-gates |
| `--policy <p>`   | Explicit `.dxkit/policy.json` override. Auto-discovers `<cwd>/.dxkit/policy.json` when omitted                       |
| `--json`         | Emit `{ schema: 'dxkit.guardrail-check.v1', ... }` JSON                                                              |
| `--markdown`     | Emit a markdown report (used by the PR-gate workflow to post a comment)                                              |
| `--verbose`      | Print per-tool timing to stderr                                                                                      |

Exit code: `1` when the policy blocks any pair, `0` otherwise.

## Classifications

| Status              | Meaning                                                                    | Default policy |
| ------------------- | -------------------------------------------------------------------------- | -------------- |
| `persisted`         | Same finding, same place — pre-existing debt                               | passes         |
| `relocated`         | Same finding, moved (line drift, rename)                                   | passes         |
| `removed`           | Was in baseline, gone now                                                  | passes         |
| `fixed`             | Was in baseline, now intentionally suppressed via comment / ignore         | passes         |
| `added`             | Net-new finding the developer just introduced                              | **blocks**     |
| `tooling_drift`     | New on disk but the scanner version / ruleset changed                      | warns          |
| `config_drift`      | New on disk but `.dxkit-ignore` / dxkit config changed                     | warns          |
| `newly_detected`    | New but envelope signals can't tell whether tooling or developer caused it | warns          |
| `probable_existing` | Heuristic match below the confidence threshold                             | warns          |
| `uncertain`         | Below every threshold; manual review                                       | warns          |

Customise the block/warn split with [`.dxkit/policy.json`](../configuration/policy.md).

## Examples

```bash
# Capture baseline, make a change, check.
vyuh-dxkit baseline create
echo 'API_TOKEN="sk-real-secret"' >> src/app.ts
vyuh-dxkit guardrail check
# → 1 added (secret) — exit 1

# Markdown report for a CI PR-comment.
vyuh-dxkit guardrail check --markdown > guardrail.md

# Machine-readable.
vyuh-dxkit guardrail check --json | jq '.summary'

# Pre-commit narrow-scope: only block when the new finding overlaps
# a line the developer changed in this commit.
vyuh-dxkit guardrail check --changed-only

# Custom policy.
cat > .dxkit/policy.json <<'EOF'
{
  "block": ["added"],
  "warn": ["tooling_drift", "config_drift", "newly_detected", "uncertain"],
  "confidence": { "secret": 0.70, "criticalSecurity": 0.75, "quality": 0.90 }
}
EOF
vyuh-dxkit guardrail check  # auto-discovers .dxkit/policy.json
```

## Hooks

`dxkit init --with-hooks` installs `.githooks/pre-commit` (fast-mode,
`--changed-only`) and `.githooks/pre-push` (full check). Both honor
two escape hatches:

- `DXKIT_SKIP_HOOKS=1 git <cmd>` — one-off bypass
- `git <cmd> --no-verify` — standard git bypass

Override the baseline name via `DXKIT_BASELINE_NAME=<n>`.

Activate the hooks after install:

```bash
git config core.hooksPath .githooks
```

## CI

`dxkit init --with-ci` installs `.github/workflows/dxkit-guardrails.yml`.
It runs on every PR, posts a markdown summary as a PR comment (updates
in place across pushes), and fails the check if the guardrail blocks.

`dxkit init --with-baseline-refresh` installs a sibling workflow that
runs `baseline create --force` on every push to `main` and auto-commits
the refreshed `.dxkit/baselines/main.json` with `[skip ci]`.

## See also

- [`baseline`](baseline.md) — capture the anchor the guardrail diffs against
- [`.dxkit/policy.json`](../configuration/policy.md) — block/warn taxonomy
- [`init`](init.md) — install the hooks + CI workflows
- [Getting started](../getting-started.md) — full workflow walkthrough
