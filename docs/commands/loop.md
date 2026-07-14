# `vyuh-dxkit loop` + `vyuh-dxkit hook stop-gate`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use.

The **loop pack** is dxkit's deterministic preflight/postflight layer for
autonomous coding loops — a Claude Code session that keeps working until it
decides to stop. It stops a loop from declaring "done" while it has
introduced net-new findings, by re-running the [`guardrail`](guardrail.md)
on every Stop and feeding any net-new findings back to the model for repair.

The value is **predictability, not new detection**: the gate bounds the
"loop shipped debt and never fixed it" failure mode to zero using the
findings, baseline, and [identity contract](baseline.md) dxkit already
computes. It is not a new scanner.

## Setup

```bash
# Register the Stop hook + CLAUDE.md loop norm + default preset.
# Additive: merges into an existing .claude/settings.json + CLAUDE.md
# without clobbering your hooks or prose. Implies the dxkit skills.
vyuh-dxkit init --claude-loop [--loop-preset security-only|full-debt]
```

This is opt-in even under `init --full`, because it registers a hook that
blocks the agent from stopping. See [`init`](init.md).

## `vyuh-dxkit hook stop-gate`

The body of the Claude Code **Stop hook**. Not run by hand — `init
--claude-loop` registers it in `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cd \"${CLAUDE_PROJECT_DIR:-.}\" && npx vyuh-dxkit hook stop-gate"
          }
        ]
      }
    ]
  }
}
```

It reads the hook payload from stdin, runs the guardrail against the
baseline, and decides:

| Outcome              | Condition                                                  | Mechanism                                                                                                                     |
| -------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Allow stop**       | No net-new findings (and the optional test command passed) | exit 0, no decision                                                                                                           |
| **Block → model**    | Net-new findings the model can fix                         | exit 0 + `{"decision":"block","reason":"…"}` on stdout — the reason reaches the model so it repairs, then tries to stop again |
| **Block → operator** | Guardrail couldn't run (no baseline / config error)        | exit 2 + stderr to the operator (the model can't fix a preflight problem); allows on the next attempt to avoid thrashing      |

The repair message lists each net-new finding with its location and is
explicit: **do not refresh the baseline, do not fix unrelated
grandfathered debt — fix only what this branch introduced.** The full
machine-readable verdict is written to `.dxkit/loop/last-guardrail.json`.

### Environment knobs

| Variable                  | Effect                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `DXKIT_LOOP_PRESET`       | Override the posture for one run (`security-only` / `full-debt`)                                     |
| `DXKIT_LOOP_TEST_COMMAND` | Run after the guardrail passes; a failing suite also blocks the stop, with the failure tail fed back |
| `DXKIT_LOOP_FAIL_OPEN=1`  | Allow stops even when the gate can't run (loud warning) — use only when you accept an ungated run    |

## Posture: presets

The preset decides which net-new findings BLOCK the loop. It is
**loop-scoped**: it lives under `loop.preset` in
[`.dxkit/policy.json`](../configuration/policy.md) and **only the Stop-gate
reads it** — your CI / PR guardrail always uses the full policy, so
switching the loop posture never weakens your CI gate.

| Preset                    | Loop blocks on                                                        | When                                                                                         |
| ------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `security-only` (default) | net-new secrets, crit/high SAST, crit/high reachable dependency vulns | The safe unattended default. test-gap + quality only **warn**.                               |
| `full-debt`               | every net-new finding — adds test-gap + quality                       | When you deliberately want the loop to close test/quality gaps too. Can drive a long repair. |

`security-only` is the default because in a loop a block tells the model to
_fix_ the finding; blocking on open-ended debt (write tests / refactor
until clear) makes an unattended agent grind for a long time, while
security findings are bounded and must-fix.

```json
{ "loop": { "preset": "full-debt" } }
```

## `vyuh-dxkit demo loop-guardrail`

A no-API, offline walkthrough — no Claude Code session, no key, no scanners. It
drives the **real** gate code path (`buildRepairMessage` + the exit-0
decision-block contract) over an example net-new finding, so you can see
exactly what the gate feeds an agent — block, repair, clean — without setting
anything up.

```bash
vyuh-dxkit demo loop-guardrail
```

After the walkthrough it shows a **next step tailored to where you ran it**: a
git repo with no dxkit yet gets the wire-up commands; an already-set-up repo gets
`loop doctor`; a non-repo points you at your project. When you run it
interactively (a TTY) inside a fresh git repo, it also **offers to wire the
Stop-gate in for you** with one keystroke — that opt-in runs the additive
`init --claude-loop` and is the only thing that writes anything. It defaults to
**no**, never prompts in a piped or CI run, and never touches a repo that already
has dxkit. The `init --claude-loop` it runs finishes setup — it captures today's
debt as the baseline automatically (pass `--no-finish` to defer and run
`baseline create` yourself later).

## `vyuh-dxkit loop doctor`

Preflight for an unattended run. Verifies the loop is wired safely BEFORE
it runs, instead of after it has already shipped debt.

```bash
vyuh-dxkit loop doctor [path] [--json]
```

Checks: git repo, baseline present/resolvable (committed file or ref-based
ref), **Stop hook registered** (the silent-failure class — an unregistered
hook never fires, so the loop runs with no gate and no error), active
preset, optional postflight test command, code-graph freshness. Each
failing check carries a fix command. **Exit `1` when any check fails** so a
CI loop-setup step can gate on it.

## `vyuh-dxkit loop ledger`

Every Stop event is appended to `.dxkit/loop/ledger.jsonl`. The ledger
answers "what did the loop actually do?"

```bash
vyuh-dxkit loop ledger [show|summarize|clear] [--json] [--limit <n>]
```

| Subcommand       | Output                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `show` (default) | Raw event lines — guardrail status, net-new vs baseline counts, allowed/blocked, timing                  |
| `summarize`      | Blocked vs allowed totals, **repaired-after-block** sessions, blocked-and-never-repaired, net-new totals |
| `clear`          | Remove the ledger file (reset the audit trail)                                                           |

`summarize` is the headline: a healthy loop shows blocks followed by
repairs — that IS the gate working.

## Examples

```bash
# One-command setup, then verify before an unattended run.
vyuh-dxkit init --claude-loop
vyuh-dxkit loop doctor

# Run the loop to also close test + quality gaps (expensive).
vyuh-dxkit init --claude-loop --loop-preset full-debt

# After a run: what did the gate do?
vyuh-dxkit loop ledger summarize

# Block on a failing test suite too.
DXKIT_LOOP_TEST_COMMAND="npm test" claude   # (inside your loop runner)
```

## See also

- [`guardrail`](guardrail.md) — the check the Stop-gate runs
- [`baseline`](baseline.md) — the anchor it diffs against
- [`.dxkit/policy.json`](../configuration/policy.md) — the `loop.preset` knob
- [`init`](init.md) — `--claude-loop` setup
- The **dxkit-loop** skill — operate the gate conversationally with Claude Code
