# `vyuh-dxkit baseline`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use.

Capture the per-finding identities of every issue dxkit currently
surfaces in your repo, and write them to a JSON file under
`.dxkit/baselines/`. The file becomes the "brownfield anchor" the
[`guardrail check`](guardrail.md) command diffs new scans against to
decide what is a net-new regression vs. pre-existing debt.

## Usage

```bash
vyuh-dxkit baseline create [path] [--name <name>] [--force]
vyuh-dxkit baseline show   [path] [--name <name>] [--baseline <path>]
                                  [--kind <kind>] [--json]
```

## `baseline create`

Runs every analyzer, fingerprints each finding via the canonical
identity helpers, and writes
`.dxkit/baselines/<name>.json` (default `<name>` is `main`).

| Option       | Effect                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `path`       | Repo root to scan. Defaults to `.`                                                             |
| `--name <n>` | Baseline name. Multiple baselines can coexist (e.g. `main`, `release-2025-q4`). Default `main` |
| `--force`    | Overwrite an existing baseline file rather than erroring out                                   |
| `--verbose`  | Print per-tool timing to stderr                                                                |

What lands in the file:

- **Per-finding `id` + `kind` + `fingerprints`** (multi-axis: location,
  domain, content, semantic) — the durable contract the matcher uses
  to detect "same finding, different line" vs "new finding".
- **`repo.commitSha`** — anchor for the git-aware matcher's
  `git diff <baseSha> HEAD` lookups.
- **`tools` map** — real version probed per scanner tool, so
  guardrail check can detect tooling drift.
- **`analysis` block** — `dxkitVersion`, `policyHash`, `ignoreHash`,
  `toolchainHash`, `configHash` for envelope-drift classification.
- **`schemaVersion: 'dxkit-baseline/v1'`** — version banner so future
  schema changes can be migrated rather than break consumers.

The file is JSON-pretty-printed for git-friendly diffs. Commit it.

## `baseline show`

Pretty-print the on-disk baseline. Default: summary line + per-kind
counts. Pass `--kind <name>` to drill into one kind, or `--json` to
emit a schema-banner-wrapped payload an agent can consume.

| Option           | Effect                                                                |
| ---------------- | --------------------------------------------------------------------- |
| `--name <n>`     | Read `.dxkit/baselines/<n>.json` (default `main`)                     |
| `--baseline <p>` | Read an explicit baseline file path (overrides `--name`)              |
| `--kind <kind>`  | Filter to one finding kind (secret, dep-vuln, code, duplication, ...) |
| `--json`         | Emit `{ schema: 'dxkit.baseline-show.v1', ... }` JSON payload         |

## Examples

```bash
# Capture today's state as the brownfield anchor.
vyuh-dxkit baseline create

# Inspect what was captured.
vyuh-dxkit baseline show
vyuh-dxkit baseline show --kind secret      # one finding kind
vyuh-dxkit baseline show --json | jq        # agent-readable

# Maintain a parallel baseline for the release branch.
git checkout release/2.5.x
vyuh-dxkit baseline create --name release
```

## Refreshing the baseline

The `--with-baseline-refresh` flag on `init` installs a GitHub Actions
workflow that runs `baseline create --force` on every push to `main`
and auto-commits the updated file with `[skip ci]`. The next PR's
[`guardrail check`](guardrail.md) reads the refreshed anchor without
manual intervention.

## See also

- [`guardrail`](guardrail.md) — diff a current scan against a baseline
- [`.dxkit/policy.json`](../configuration/policy.md) — tune what
  classifications block vs. warn
- [Getting started](../getting-started.md) — full workflow walkthrough
