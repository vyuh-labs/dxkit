# `vyuh-dxkit checks`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use.

List and dry-run the **custom checks** configured for this repo — user-declared
repo invariants ([`.dxkit/policy.json:checks`](../configuration/policy.md#custom-checks--lint-gate))
plus the pack-declared built-in [lint gate](../configuration/language-packs.md#the-built-in-lint-gate).

A custom check is a first-class gate citizen: its failures are fingerprinted,
baselined, and gated by [`guardrail check`](guardrail.md) **net-new only** — a
pre-existing failure is grandfathered, so you can turn on a lint gate against a
repo with a thousand existing warnings and only ever block the error _this
change_ introduced. User checks and lint share one runner; lint is the first
consumer of the seam, not a parallel path.

## Usage

```bash
vyuh-dxkit checks [list] [path] [--json]   # what's configured (default)
vyuh-dxkit checks run  [path] [--json]     # dry-run: execute each check, no gating
```

| Option   | Effect                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| `list`   | (default) Show configured user checks + active lint gates, and any skipped entries.                                  |
| `run`    | Execute each check and report `pass` / `fail` / `skipped-*` + finding counts. Never blocks, never writes a baseline. |
| `path`   | Repo root. Defaults to `.`                                                                                           |
| `--json` | Machine-readable output (agent-queryable).                                                                           |

`checks list` resolves through the **same** entry point the baseline producer
and the guardrail use, so what it prints is exactly what the gate sees. `checks
run` answers "what would the gate find right now?" — but net-new-ness is decided
by `guardrail check` against the committed baseline, not here.

## Configure

Declare user checks and/or enable the lint gate in `.dxkit/policy.json`:

```jsonc
{
  "checks": [
    { "name": "check:no-cross-layer-imports", "command": "node scripts/layers.js" },
    {
      "name": "eslint-strict",
      "command": "npx eslint --format unix src",
      "blocking": false,
      "parse": {
        "regex": "^(?<file>[^:]+):(?<line>\\d+):\\d+:\\s+(?<message>.+?)\\s+\\[.*?(?<rule>[\\w-/]+)\\]$",
      },
    },
  ],
  "lint": { "enabled": true, "blocking": false },
}
```

See [policy.json](../configuration/policy.md#custom-checks--lint-gate) for every
field.

## Two finding shapes: binary vs located

How a check parses its output decides how precisely the gate grandfathers debt:

- **Binary** (`parse: "exit"`, default) — the whole command is one pass/fail;
  identity is the check name. Right for a genuine pass/fail gate. It grandfathers
  the _entire_ check once it's failing, so reserve it for commands expected to
  pass.
- **Located** (`parse: { "regex": "…" }`) — each matching output line is a
  finding keyed on `file + line + rule` (via named capture groups —
  `(?<file>…)`, `(?<line>…)`, `(?<rule>…)`, `(?<message>…)`, any subset). This
  is what lets a **net-new lint error block while the pre-existing backlog is
  grandfathered**. Prefer it for anything linter-shaped.

The runner parses regex output **regardless of exit code** — many linters exit
`0` while emitting diagnostics (dotnet analyzers, eslint warnings). "Clean"
means zero matched lines. A command that fails _and_ matches nothing falls back
to one binary finding, so a real crash is never lost.

## Capture the baseline after configuring

A check only grandfathers pre-existing failures once they're in the committed
baseline:

```bash
vyuh-dxkit baseline create      # records today's failures as the accepted floor
vyuh-dxkit guardrail check      # then gates net-new only
```

> Refresh the baseline in **CI**, not on your laptop — a local capture bakes
> your machine's tool versions in and churns fingerprints. Use the
> `dxkit-baseline-refresh` workflow.

Custom checks gate in **committed/baseline** mode. They are excluded from
**ref-based** diff mode: a throwaway worktree at a git ref lacks the toolchain,
so the linter would fail-open-skip on the "before" side and false-flag every
finding as net-new.

## Security

Custom-check commands are **executed**. dxkit runs them ONLY from the repo's own
committed `.dxkit/policy.json` (or a pack's built-in lint command) — the same
trust boundary as the repo's npm scripts or CI config. dxkit never runs a check
from a CLI flag or any untrusted source. Review a PR that edits
`checks[].command` with the scrutiny of a PR that edits a CI workflow.

## Troubleshooting

| Symptom                                  | Cause / fix                                                                                                                                                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check missing from `checks list`         | Dropped as malformed (no `name`, empty `command`, reserved `lint:` prefix, duplicate name). `list` prints the reason.                                                                                                                                    |
| `checks run` shows `skipped-unavailable` | The binary isn't on `PATH`. Install it (`vyuh-dxkit tools install` for pack linters). Skips never block.                                                                                                                                                 |
| `checks run` shows `skipped-environment` | The gate's declared execution requirement isn't met here (wrong OS, missing/unhealthy SDK) — the reason names the need and the remedy. The check runs where it can: the generated per-host CI job captures its baseline slice. Nothing is misconfigured. |
| A net-new lint error isn't blocking      | `lint.blocking` is `false` (default warn-only), or the gate is binary not located.                                                                                                                                                                       |
| An old failure blocks as if net-new      | The baseline predates the check, or a fingerprint churned — re-capture the baseline in CI.                                                                                                                                                               |

## See also

- [`guardrail check`](guardrail.md) — the gate that consumes these findings
- [`allowlist`](allowlist.md) — suppress an individual check finding
- [policy.json](../configuration/policy.md#custom-checks--lint-gate) — the config
- [language packs](../configuration/language-packs.md#the-built-in-lint-gate) — the built-in lint gate
- The `dxkit-checks` agent skill drives all of this conversationally.
