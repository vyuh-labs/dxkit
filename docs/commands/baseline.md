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
                                  [--mode <mode>] [--ref <ref>]
vyuh-dxkit baseline show   [path] [--name <name>] [--baseline <path>]
                                  [--kind <kind>] [--json]
```

## `baseline create`

Runs every analyzer, fingerprints each finding via the canonical
identity helpers, and writes `.dxkit/baselines/<name>.json` (default
`<name>` is `main`) — unless `--mode=ref-based`, in which case no
file is written and the guardrail check recomputes the prior side
from a git ref on demand.

| Option       | Effect                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| `path`       | Repo root to scan. Defaults to `.`                                                                        |
| `--name <n>` | Baseline name. Multiple baselines can coexist (e.g. `main`, `release-2025-q4`). Default `main`            |
| `--force`    | Overwrite an existing baseline file rather than erroring out                                              |
| `--mode <m>` | Baseline posture: `committed-full`, `committed-sanitized`, or `ref-based`. See "Modes" below              |
| `--ref <r>`  | Baseline ref for `--mode=ref-based`. Default: `origin/HEAD` (probed via git), falls back to `origin/main` |
| `--verbose`  | Print per-tool timing to stderr                                                                           |

### Modes

The baseline file is committed to git. On public repos that
disclosure surface matters — file paths + rule names + private
package names + advisory IDs all leak useful intel. Three modes
let you pick the disclosure posture:

| Mode                  | On-disk content                                             | Default for     |
| --------------------- | ----------------------------------------------------------- | --------------- |
| `committed-full`      | Rich per-finding entries (today's behavior)                 | private repos   |
| `committed-sanitized` | Stripped entries (`{ id, kind, sanitized: true }`)          | explicit opt-in |
| `ref-based`           | No file. Guardrail check computes prior side from a git ref | public repos    |

**Auto-picker precedence**:

1. `--mode <X>` CLI flag wins.
2. `.dxkit/policy.json` → `baseline.mode` (and `baseline.ref`).
3. Visibility-derived default — `gh repo view --json visibility`:
   - `public` → `ref-based`
   - `private` / `internal` / `unknown` → `committed-full`

`committed-sanitized` is never auto-picked. It's the explicit
opt-in for compliance-conscious private repos where broad internal
read access makes location disclosures material. The cross-run
matching contract (fingerprint identity) is identical across all
three modes — sanitization only strips human-readable locators, it
doesn't change which findings pair across runs.

**Pin the mode in `.dxkit/policy.json`**:

```json
{
  "baseline": {
    "mode": "ref-based",
    "ref": "origin/main"
  }
}
```

**Ref-based mode notes**:

- Requires `git fetch` history reaching `<ref>`. Shallow CI clones
  need `fetch-depth: 0` in the checkout step.
- Salt resolution stays consistent across the cwd + worktree for
  env-var and deterministic salt modes. File-mode salt is copied
  into the worktree so secret-HMAC matching works.
- `node_modules` (and equivalents) aren't checked out — dep-vuln
  scanners that read installed packages directly may report
  degraded coverage. Lockfile-driven scanners (the dxkit default)
  survive the gap.

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

> **Refresh the canonical baseline in CI, not on a dev laptop.** A local
> `baseline create --force` bakes your machine's scanner versions
> (semgrep, npm-audit, jscpd, …) into the committed file. When those
> differ from CI's, the next PR's guardrail emits spurious
> `TOOLING-DRIFT` warnings and shows phantom "resolved" findings — the
> baseline and the PR were scanned by different tool versions. The
> bundled refresh workflow (or any runner pinned to CI's scanner
> versions) keeps the anchor canonical. Use a local `--force` only for
> the very first capture or a throwaway experiment.

## See also

- [`guardrail`](guardrail.md) — diff a current scan against a baseline
- [`.dxkit/policy.json`](../configuration/policy.md) — tune what
  classifications block vs. warn
- [Getting started](../getting-started.md) — full workflow walkthrough
