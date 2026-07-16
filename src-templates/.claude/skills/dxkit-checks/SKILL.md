---
name: dxkit-checks
description: Declare and operate custom repo invariants as first-class guardrail gates — a project rule (a "no imports from X" check, an architecture script, a license audit) or the built-in per-language lint gate. Use when the user says "make our lint errors block the PR", "gate our custom check", "add a repo rule to the guardrail", "enforce our architecture script", "why isn't my check running", "block net-new lint but grandfather the backlog", or "run our checks without gating". For suppressing an individual finding, defer to dxkit-allowlist; for the fix-vs-suppress decision, dxkit-action.
---

# dxkit-checks

A **custom check** is any repo command dxkit runs as a first-class gate citizen. Two sources feed one seam:

- **User checks** you declare in `.dxkit/policy.json:checks` — a project invariant (`check:no-cross-layer-imports`, `make lint`, a license audit, `scripts/arch-gate.sh`).
- The **built-in lint gate** — each active language pack's linter (eslint, ruff, golangci-lint, rubocop, clippy, ktlint, dotnet analyzers), enabled with one policy flag.

Both normalize to the *same* runner and inherit the *same* machine every native finding gets: fingerprint → baseline → git-aware matcher → brownfield classify → allowlist → guardrail verdict. So the guardrail blocks only a **net-new** failure and **grandfathers pre-existing debt** — you can turn on a lint gate against a repo with a thousand existing warnings and it will only ever block the error *this change* introduced.

It is **opt-in, default-off**. A repo that declares nothing pays nothing (the runner spawns no process).

## See what's configured

```bash
npx vyuh-dxkit checks            # list configured user checks + active lint gates
npx vyuh-dxkit checks --json     # the same, machine-readable (agent-queryable)
npx vyuh-dxkit checks run        # DRY-RUN: execute each check, show pass/fail/skip + findings
npx vyuh-dxkit checks run --json
```

`checks run` is a diagnostic — it runs the checks and shows *what the gate would see right now*, but it never blocks and never touches the baseline. Net-new-ness is decided by `guardrail check` against the committed baseline, not here.

## Declare a user check

Add to `.dxkit/policy.json`:

```jsonc
{
  "checks": [
    {
      "name": "check:no-cross-layer-imports",
      "command": "node scripts/check-layers.js",
      "blocking": true            // default true; false = warn-only
    },
    {
      "name": "license-audit",
      "command": ["scripts/license-audit.sh", "--strict"],
      "blocking": false
    }
  ]
}
```

- `command` is a string (split on whitespace) or an argv array. It resolves the binary on `PATH`; a **missing binary is a fail-open skip**, never a block (a developer who hasn't installed a tool locally isn't blocked — CI is the backstop).
- `name` is the durable identity key — keep it stable, or the baseline treats a rename as "old check resolved, new check appeared".
- `expectedExit` (default `0`) sets which exit code means "pass".

### Two finding shapes: binary vs located

How you parse a check's output decides how precisely the gate grandfathers debt:

- **Binary** (`parse: "exit"`, the default) — the whole command is one pass/fail. A non-`expectedExit` exit yields ONE finding keyed on the check name. Right for a genuine pass/fail gate (`check:seam` passes or it doesn't). **Caveat:** on a check that's *already failing*, a binary finding grandfathers the entire check — so a genuinely new problem the same command surfaces won't be seen as net-new. Use binary only when the command is expected to pass.
- **Located** (`parse: { "regex": "..." }`) — each output line matching the regex becomes one located finding, so identity is per `file + line + rule`. This is what lets a **net-new lint error block while the pre-existing lint backlog is grandfathered**. The regex uses named groups — any subset of `(?<file>…)`, `(?<line>…)`, `(?<rule>…)`, `(?<message>…)`:

```jsonc
{
  "name": "eslint-strict",
  "command": "npx eslint --format unix src",
  "parse": { "regex": "^(?<file>[^:]+):(?<line>\\d+):\\d+:\\s+(?<message>.+?)\\s+\\[.*?(?<rule>[\\w-/]+)\\]$" }
}
```

> Prefer **located** for anything linter-shaped. A binary lint check grandfathers the whole linter on any repo with existing debt, which silently lets net-new errors through — the located form is the whole point.

The runner parses regex output **regardless of exit code** — many linters exit `0` while emitting diagnostics (dotnet build analyzers, eslint warnings-only). "Clean" means zero matched lines, not exit 0. A command that fails *and* matches nothing falls back to one binary finding, so a real crash is never lost.

## Enable the built-in lint gate

You don't need to hand-write a regex for your language's standard linter — the pack ships it. Turn it on:

```jsonc
{
  "lint": {
    "enabled": true,     // default false
    "blocking": false    // default false (warn-only); true = block net-new lint errors
  }
}
```

Each active pack contributes a `lint:<language>` gate (e.g. `lint:typescript`, `lint:python`) using its standard zero-config linter, parsed from the linter's own machine-readable output (eslint/ruff/golangci/rubocop/ktlint JSON, clippy's JSON diagnostic stream) rather than a display format — so a diagnostic whose text breaks a display line-shape is never silently dropped, and the rule name always lands in the finding's identity. (C# is the one regex exception: MSBuild has no machine-readable diagnostic stream.) User-declared checks still use the `exit` / `regex` shapes above — the structured mode is pack-internal. Coverage is 7 of 8 built-in packs (TypeScript/JS, Python, Go, Ruby, Rust, Kotlin, C#); Java has no single zero-config standalone linter, so gate Java lint as a **user check** pointing at your build's checkstyle/PMD/spotbugs task. Tool detection is automatic through the registry — `vyuh-dxkit tools install` provisions any missing linter; a linter that isn't installed is a fail-open skip.

Start `blocking: false` to observe what the gate *would* block for a release or two, then flip to `blocking: true` once the net-new stream is clean.

## After you configure — capture the baseline

A check only grandfathers pre-existing failures if they're in the committed baseline. After adding checks (or enabling lint), refresh the baseline so today's failures are recorded as the accepted floor:

```bash
npx vyuh-dxkit baseline create        # captures current custom-check findings as the floor
```

> **Refresh the baseline in CI, not on your laptop** — a local capture bakes your machine's tool versions in and churns fingerprints. Use the `dxkit-baseline-refresh` workflow (see **dxkit-ingest**).

Then the guardrail gates net-new only:

```bash
npx vyuh-dxkit guardrail check        # blocks/warns on net-new check failures vs baseline
```

Custom checks gate fully in **committed/baseline** mode. They are excluded from **ref-based** diff mode: a throwaway worktree at a git ref lacks the toolchain, so the linter would fail-open-skip on the "before" side and false-flag every finding as net-new. Committed mode (the private-repo default) captures the baseline from a provisioned tree, so the comparison is honest.

### Gates that need a specific build environment (4.0)

A pack lint gate declares what it needs to run (host OS, toolchain, a project build). When the current machine cannot satisfy it — the flagship case: the C# gate reads analyzer warnings out of `dotnet build`, and a `net*-windows` target only builds on Windows — the check is a **disclosed boundary**, never a silent skip and never a fake finding: `checks run` shows `skipped-environment` with what is needed, where it runs, and the install remedy. Its slice of the baseline is captured where it CAN run: the generated `dxkit-baseline-refresh` workflow gains a `capture-<host>` job that runs the gate on the right runner and merges its findings into the one committed baseline (`baseline fragment` / `baseline merge-fragment` — plumbing the workflow drives; you rarely run them by hand). No configuration: it is derived from the pack's declarations when lint gating is enabled.

## Security

Custom-check commands are **executed**. dxkit runs them ONLY from the repo's own committed `.dxkit/policy.json` (or a pack's built-in lint command) — the same trust boundary as the repo's npm scripts or CI config. dxkit never runs a check from a CLI flag or any untrusted source. Treat a PR that edits `checks[].command` with the same review scrutiny as a PR that edits a CI workflow.

## Troubleshooting

- **"My check doesn't appear in `checks list`"** — it was dropped as malformed (no `name`, empty `command`, a reserved `lint:` prefix, or a duplicate name). `checks list` prints the skip reason; fix and re-run.
- **"`checks run` says skipped-unavailable"** — the binary isn't on `PATH`. Install it (`vyuh-dxkit tools install` for pack linters) or fix the command. Skips never block.
- **"`checks run` says skipped-environment"** — the gate's declared execution requirement isn't met here (wrong OS, missing or unhealthy SDK). The reason line names the need and the remedy. This is by design: the check runs in the environment that can serve it (see the build-environment section above); nothing is wrong with your config.
- **"A net-new lint error isn't blocking"** — check `lint.blocking` is `true` (default is warn-only), and that the gate is **located** not binary. A binary lint check grandfathers the whole linter.
- **"An old failure is blocking as if net-new"** — the baseline predates the check, or a fingerprint churned. Re-capture the baseline in CI.

## Hand-offs

- To **suppress one specific check finding** (a false positive, an accepted exception) → **dxkit-allowlist**.
- For the **fix-vs-suppress decision** on a finding → **dxkit-action**.
- For **policy/ignore-file tuning** generally → **dxkit-config**.
- For **installing a pack's linter** → `vyuh-dxkit tools install`.
