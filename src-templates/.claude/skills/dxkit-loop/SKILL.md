---
name: dxkit-loop
description: Set up and operate the dxkit Stop-gate for autonomous coding loops — register the hook, run the preflight, explain why a loop was blocked, read the loop ledger, and switch the blocking posture (security-only vs full-debt). Use when the user says "set up the loop gate", "why did the loop get blocked", "stop the agent from shipping debt", "run a safe agent loop", "show the loop ledger", "switch the loop to full-debt", or anything about running an unattended Claude Code loop behind dxkit.
---

# dxkit-loop

This skill owns the **loop pack**: the deterministic preflight/postflight layer that keeps an autonomous coding loop from declaring "done" while it has introduced net-new findings. Reach for it to set the gate up, to explain a block, or to tune the posture.

## What the loop pack is

When Claude Code runs in a loop (it keeps working until it decides to stop), a **Stop hook** runs `vyuh-dxkit hook stop-gate` every time the agent tries to stop. The gate re-runs the guardrail check against the baseline and:

- **net-new findings → blocks the stop** and feeds the exact findings back to the model so it repairs them, then tries to stop again;
- **clean → allows the stop** (optionally after a configured test command passes);
- **gate can't run (no baseline / config error) → blocks once for the operator** (a problem the model can't fix), then allows on the next attempt to avoid thrashing.

Every Stop event is appended to an audit trail at `.dxkit/loop/ledger.jsonl`.

The value is **predictability, not a new scanner**: the gate bounds the "loop shipped debt and never fixed it" failure mode to zero. It uses the same findings, baseline, and identity contract as the rest of dxkit — it does not detect anything new.

## See it first (no setup)

```bash
# No API key, no Claude Code, no scanners — runs the real gate over an example
# finding and shows the block → repair → clean flow offline.
npx vyuh-dxkit demo loop-guardrail
```

## Setup

```bash
# Register the Stop hook + CLAUDE.md loop norm + default preset.
# Additive: merges into existing .claude/settings.json + CLAUDE.md,
# never clobbering your hooks or prose.
npx vyuh-dxkit init --claude-loop

# Pick the posture up front (default is security-only):
npx vyuh-dxkit init --claude-loop --loop-preset full-debt
```

A loop is only safe if a baseline exists, the hook is registered, and the guardrail can run. **Always verify before an unattended run:**

```bash
npx vyuh-dxkit loop doctor
```

It checks: git repo, baseline present/resolvable, Stop hook registered, active preset, optional postflight test command, graph freshness. Exit non-zero = not safe to run unattended yet — each failing check carries a fix command. The most important one it catches is the **silent failure**: an unregistered hook never fires, so the loop would run with no gate and no error. If `loop doctor` says the baseline is missing, capture one first (`npx vyuh-dxkit baseline create`).

## Posture: the two presets

The preset decides which net-new findings BLOCK the loop. It is **loop-scoped** — it lives under `loop.preset` in `.dxkit/policy.json` and only the Stop-gate reads it. Your CI / PR guardrail is unaffected (it always uses the full policy), so switching the loop posture never weakens your CI gate.

| Preset | Blocks on | When |
|---|---|---|
| **`security-only`** (default) | net-new secrets, crit/high SAST, crit/high reachable dependency vulns | The safe unattended default. Cheap, unambiguous, must-fix. test-gap + quality only **warn**. |
| **`full-debt`** | everything net-new — adds test-gap + quality | When you deliberately want the loop to also close test/quality gaps. Can drive a long, expensive repair. |

**Why security-only is the default:** in a loop a block doesn't just fail a check — it tells the model to fix the finding. Blocking on open-ended debt (write tests until the gap closes, refactor until the quality issue clears) makes an unattended agent grind for a very long time. Security findings are bounded and must-fix; debt is an opt-in.

### Switch the posture

```bash
# Switch to full-debt (or back):
npx vyuh-dxkit init --claude-loop --loop-preset full-debt
```

Or hand off to **dxkit-config** to edit `loop.preset` directly. Either way, only `loop.preset` changes; the rest of the policy is preserved. A one-off override for a single run: `DXKIT_LOOP_PRESET=full-debt`.

## Explain a block

When a loop is blocked, the model receives a message listing each net-new finding and the rule **don't refresh the baseline, don't fix unrelated debt — fix only what this branch introduced**. The full machine-readable verdict is written to `.dxkit/loop/last-guardrail.json`.

To explain a block to the user:

1. Read `.dxkit/loop/last-guardrail.json` — the blocking findings with file/line/severity.
2. Confirm each is genuinely net-new (introduced by this branch), not pre-existing debt the gate is correctly ignoring.
3. To actually fix them, hand off to **dxkit-action** (the fix loop). The gate re-checks on the next stop.

**Two anti-patterns to refuse:** never clear a block by re-baselining (that launders the regression into the accepted set), and never let the loop wander off to fix unrelated grandfathered debt. The gate only asks for what the branch introduced.

## Read the ledger

The ledger answers "what did the loop actually do?"

```bash
npx vyuh-dxkit loop ledger summarize   # blocked vs allowed, repaired-after-block, net-new totals
npx vyuh-dxkit loop ledger show        # raw event lines (add --json for machine output)
npx vyuh-dxkit loop ledger clear       # reset the audit trail
```

`summarize` is the headline: how many stops were blocked, how many sessions repaired after a block, and how many were blocked and never repaired. A healthy loop shows blocks followed by repairs — that IS the gate working.

## Optional postflight tests

Set `DXKIT_LOOP_TEST_COMMAND` and the gate runs it after the guardrail passes — a failing suite blocks the stop too, with the failure tail fed back for repair. Unset, the gate is findings-only (`loop doctor` warns about this). Use it to make "tests must pass" part of the stop condition.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Loop stops with debt still present | Stop hook not registered → `npx vyuh-dxkit loop doctor`, then `init --claude-loop`. |
| Gate blocks the operator every stop | No baseline (gate can't diff) → `npx vyuh-dxkit baseline create`. |
| Loop blocks on test/quality you didn't want | Posture is `full-debt` → switch to `security-only`. |
| Gate can't run and you want stops anyway | `DXKIT_LOOP_FAIL_OPEN=1` allows stops with a loud warning (use only when you accept an ungated run). |
| Hook fires but errors | Broken install (vyuh-dxkit not resolvable) → hand off to **dxkit-fix**. |

## Hand-offs

- Fixing the findings a block surfaced → **dxkit-action**
- Editing `loop.preset` / other policy → **dxkit-config**
- Broken install (hook not firing, command not found) → **dxkit-fix**
- What a baseline is / how guardrails work conceptually → **dxkit-learn**
- Capturing or refreshing the baseline → **dxkit-init**
