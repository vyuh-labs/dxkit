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
                           [--changed-only] [--incremental] [--untrusted]
                           [--policy <path>] [--json | --markdown]
```

| Option           | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`           | Repo root to scan. Defaults to `.`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--name <n>`     | Baseline name (`.dxkit/baselines/<n>.json`). Default `main`                                                                                                                                                                                                                                                                                                                                                                                          |
| `--baseline <p>` | Explicit baseline file path (overrides `--name`)                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--changed-only` | Drop new-side pairs whose anchor line falls outside the working-tree diff. Use in pre-commit hooks; skip in PR-gates                                                                                                                                                                                                                                                                                                                                 |
| `--incremental`  | Scope the gather to the policy's blockable kinds; (ref-based) scope semgrep to changed files AND skip the dependency-vuln audit when no dependency manifest/lockfile changed (a net-new dep vuln requires one — sound in ref-based mode, where both sides audit against the same advisory snapshot). Same verdict, scales with PR size not repo size; falls back to a full scan on any doubt. Opt-in; default is a full scan                         |
| `--untrusted`    | Treat the scanned source as attacker-controlled (a hosted PR gate). Dependency audits never execute it: the Python pack drops `pip-audit .` project mode (its PEP 517 build backend can run code) and audits only a requirements file, else reports unavailable. npm-audit and osv-scanner `scan` are already read-only, so TS/Java/Go/Rust/Ruby are unaffected. Off by default; trusted local runs and the loop on your own repo keep full coverage |
| `--policy <p>`   | Explicit `.dxkit/policy.json` override. Auto-discovers `<cwd>/.dxkit/policy.json` when omitted                                                                                                                                                                                                                                                                                                                                                       |
| `--json`         | Emit `{ schema: 'dxkit.guardrail-check.v1', ... }` JSON                                                                                                                                                                                                                                                                                                                                                                                              |
| `--markdown`     | Emit a markdown report (used by the PR-gate workflow to post a comment)                                                                                                                                                                                                                                                                                                                                                                              |
| `--verbose`      | Print per-tool timing to stderr                                                                                                                                                                                                                                                                                                                                                                                                                      |

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

One `added` case that surprises people: a pure file RENAME can mint a
net-new **test-gap** finding. That is not an identity bug — renamed
findings relocate through git-aware matching — it is analysis truth: the
test-naming convention link (`OwnerControllerTests` covers
`OwnerController`) genuinely breaks when the source file's name changes,
so the renamed file now reads untested. The honest remedies are renaming
the test alongside the source, or an `allowlist add` with a reason when
the naming divergence is deliberate.

Customise the block/warn split with [`.dxkit/policy.json`](../configuration/policy.md).
For **per-finding** suppression (false positives, intentional test
fixtures, accepted risks), use the [allowlist](./allowlist.md) — the
guardrail's block message prints the exact `allowlist add` command
for every blocked finding.

> **After a dxkit upgrade that changed the finding-identity scheme**, a
> `committed-full` check stops with a "run `vyuh-dxkit update`" message
> rather than diffing across schemes (which would flag every existing
> finding as net-new). `vyuh-dxkit update` migrates the baseline +
> allowlist automatically — see
> [`update`](update.md#identity-scheme-migration-run-after-every-upgrade).

## Markdown output: PR-comment review

`guardrail check --markdown` (used by the `dxkit-guardrails.yml`
workflow installed by `init --with-ci`) emits a markdown report
that's posted as a sticky PR comment on every pull request. The
report now includes an **"Allowlist activity"** section listing
every allowlist entry added (or removed) on this branch versus the
baseline commit. Reviewers see new suppressions being introduced —
typed category, reason, expiry — and can sanity-check the rationale
before approving.

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

### What gets installed

| Flag                                    | Hook                   | When it fires      | Scope                                                                                            | Wall-clock                                                                |
| --------------------------------------- | ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `--with-hooks` (default under `--full`) | `.githooks/pre-push`   | every `git push`   | full guardrail (every regression since baseline)                                                 | scales with repo size (~3 min on a 500-file repo)                         |
| `--with-precommit-hook` (opt-in)        | `.githooks/pre-commit` | every `git commit` | `--changed-only` (just lines you touched); add `--incremental` to also scope the underlying scan | full scan today, or near-PR-size with `--incremental` (opt-in since 2.15) |

The pre-commit hook is **opt-in** because re-running every analyzer on every commit is slow on large codebases. Pre-push amortises the same cost across the batch of commits in a push; CI runs the same check server-side as an unbypassable backstop. Customers on small/fast repos who want commit-time gating can opt in.

### Activation is automatic

Hook activation (`core.hooksPath = .githooks`) is auto-chained via the package.json postinstall, so teammates who clone + `npm install` get hooks wired automatically. If activation didn't fire (e.g. you cloned without running `npm install`), do it manually as a fallback:

```bash
git config core.hooksPath .githooks
```

This is a per-clone setting. The hook files themselves are committed (under `.githooks/`), so the team-wide enforcement story is "files in repo + postinstall activates locally + CI as the safety net."

### Switch pre-commit on or off later

After init, the on/off decision is just file presence:

```bash
# Turn pre-commit ON (re-run init with the flag, or copy the template manually)
vyuh-dxkit init --with-precommit-hook --force

# Turn pre-commit OFF (delete the hook file — pre-push stays active)
rm .githooks/pre-commit

# Turn ALL dxkit hooks off (unset the hooksPath; team unaffected — they keep theirs activated locally)
git config --unset core.hooksPath
```

### One-off bypass mechanisms

| Bypass                         | Effect                                                       |
| ------------------------------ | ------------------------------------------------------------ |
| `DXKIT_SKIP_HOOKS=1 git <cmd>` | dxkit-specific bypass (clearer audit trail in shell history) |
| `git <cmd> --no-verify`        | standard git bypass (skips ALL git hooks, not just dxkit's)  |
| `DXKIT_BASELINE_NAME=<n>`      | switch which baseline file the hook checks against           |

### Additive contract gates in the same check

Beyond the finding diff, `guardrail check` runs two additive, fail-open
gates when configured, and folds their verdicts into the same
block/warn result and PR comment:

- **Flow** (`policy.json:flow.mode`) — net-new broken UI→API
  integrations (a call to a route nobody serves, a removed route a
  consumer still calls).
- **Schema drift** (`policy.json:schema.mode`, opt-in, default off) —
  breaking data-model changes (field removed, type changed, optional →
  required, model removed); additive changes warn or inform. Preview
  locally with `vyuh-dxkit schema diff` — it runs the same evaluation.

Both skip (with a disclosed reason in `--json`) rather than fail when
they cannot gate honestly: no base commit, no surface touched by the
diff, no truth to compare against. A deliberate breaking change ships
via a per-finding allowlist entry, never a posture flip — see
[the policy reference](../configuration/policy.md).

### Existing hooks (additive install)

If `.githooks/<name>` or `.husky/<name>` already exists, the dxkit hook lands as `.githooks/<name>.dxkit` instead. Chain by adding `sh .githooks/<name>.dxkit` to the existing hook. `--force` overrides.

### Local hooks are bypassable — CI is the enforcement layer

Any local bypass (`--no-verify`, `DXKIT_SKIP_HOOKS`, missing `core.hooksPath`) is just convenience for the developer. The CI PR-gate workflow (`--with-ci`) runs the same check server-side; set it as a required check in branch protection so a bypassed commit can't merge without the guardrail passing.

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
