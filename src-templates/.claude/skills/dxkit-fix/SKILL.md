---
name: dxkit-fix
description: Repair a broken dxkit install — read doctor's structured output and walk the customer through each fix. Use when the user asks "fix dxkit", "fix my dxkit install", "doctor says X but Y is broken", "the pre-push hook isn't firing", "vyuh-dxkit command not found", or anything else that points at a broken-install state. Hands off to dxkit-init for fresh installs and dxkit-hooks for hook-specific deep dives.
---

# dxkit-fix

This skill repairs broken dxkit installs. It does NOT install dxkit from scratch (that's `dxkit-init`) and it does NOT triage code findings (that's `dxkit-action`). Use it when something about the install itself is wrong — hooks not firing, vyuh-dxkit not on PATH, scanner toolchain missing pieces, baseline absent, etc.

## How dxkit-fix works

The skill consumes `npx vyuh-dxkit doctor --json` output. Doctor returns a structured `DoctorReport` with a `summary.fixable[]` array — every failing check carries:

- `label` — the problem in one line
- `fix.hint` — the human-readable explanation
- `fix.command` — the shell command that repairs it (optional)
- `fix.skill` — a more specific dxkit-* skill that can deep-dive (optional)

The skill iterates `summary.fixable[]`, asks the customer for confirmation on each fix (with the command shown), runs it, then re-runs doctor at the end to verify everything closed.

## The repair loop

```
[1] Run doctor in JSON mode    → npx vyuh-dxkit doctor --json
[2] Read summary.fixable[]     → enumerate broken signals + fix commands
[3] For each fixable:
      [3a] Show the customer: label + hint + command
      [3b] Confirm (default Y)
      [3c] Run the command in their shell
      [3d] Note success/failure
[4] Re-run doctor              → verify the previously-fixable list is now empty
[5] Report what remains        → any non-fixable failures + which dxkit-* skill handles them
```

## Steps

### 1. Snapshot the broken state

```bash
npx vyuh-dxkit doctor --json > /tmp/dxkit-doctor.json
```

Capturing to a file (instead of piping inline) lets the customer re-read what was broken if a fix takes multiple iterations.

### 2. Read the fixable list

The JSON has shape `{ schema: "doctor.v1", checks: [...], summary: { fixable: [...] } }`. Iterate `summary.fixable` only — each entry has `ok: false` AND a `fix` block. Failing checks WITHOUT a fix block are informational (e.g. a missing optional toolchain) and shouldn't be touched here.

### 3. Walk the customer through each fix

For every fixable entry, present:

| Field | What to show |
|---|---|
| `label` | Section heading ("git hooks active — not activated") |
| `fix.hint` | One-line "what this means" explanation |
| `fix.command` | The exact shell command, in a code block |
| `fix.skill` (if present and ≠ dxkit-fix) | "For a deeper walkthrough, ask Claude Code: 'set up hooks'" (or whatever the skill's trigger is) |

Then ASK the customer: "Run this fix? [Y/n]". Default Y. If they decline, skip and move on.

When they confirm, run the command. Stream output. Note the exit code.

### 4. Idempotency check

Every fix command in the doctor output is designed to be idempotent — re-running it on a working install is a no-op (or a refresh). So even if a customer answers Y twice by accident, nothing breaks.

### 5. Verify with a second doctor run

After all fixes are applied (or declined), run `npx vyuh-dxkit doctor --json` again. The new `summary.fixable[]` should be a strict subset of the first run's. If something didn't close, surface it with the original `fix.hint` and offer to retry or escalate to the more specific skill.

## What dxkit-fix can repair

Driven by doctor's tier 3 (operational health) — these are the canonical repairables today:

| Symptom (doctor label) | Fix command | Notes |
|---|---|---|
| `git hooks active` not active | `npx vyuh-dxkit hooks activate` | Sets `core.hooksPath = .githooks`. Refuses to clobber husky/lefthook configs. |
| `baseline captured` missing | `npx vyuh-dxkit baseline create` | First-run: locks in today's findings as "pre-existing." Warn customer this is value-laden — see "Capturing the FIRST baseline" below. |
| `vyuh-dxkit on PATH` not found | `npm install -g @vyuhlabs/dxkit` | Global install ensures the bare CLI works in any shell session. |
| `scanner toolchain` missing pieces | `npx vyuh-dxkit tools install --yes` | Reinstalls any ✗ tools per TOOL_DEFS. Idempotent on already-installed tools. |
| `.npmrc legacy-peer-deps persistence` missing | `echo "legacy-peer-deps=true" >> .npmrc` | Locks in the peer-dep resolution mode for future `npm install` calls. |
| `CI guardrails workflow` missing | `npx vyuh-dxkit init --with-ci --yes` | Adds the dxkit-guardrails.yml workflow. Idempotent. |
| Agent DX tier failures (manifest missing, AGENTS.md missing, .claude/* missing) | `npx vyuh-dxkit init --full --yes` or `npx vyuh-dxkit update` | Init for fresh installs; update for refreshes. |

### Tool reported missing but the customer says it IS installed

If doctor flags a tool (git, dotnet, node, npm, a scanner) as missing but the customer insists it's installed, it's almost always a detection gap — the binary lives somewhere dxkit doesn't probe (common on Windows / locked-down corporate machines). Don't tell them to reinstall. Instead:

1. Find where it actually lives: `where <tool>` (Windows) / `which <tool>` (POSIX).
2. Add that directory to `.dxkit/tools.json` `probePaths` (hand off to **dxkit-config**, which documents the file).
3. Re-run `npx vyuh-dxkit doctor` to confirm it now resolves.

This matters: an undetected scanner means `baseline create` silently captured ZERO findings for that tool's category — re-baseline (`baseline create --force`) once detection is fixed.

## Capturing the FIRST baseline — be deliberate

Of all the fixes, `baseline create` is the only one with permanent consequences. The baseline records the fingerprint of every finding currently in the repo and tells future scans "these are pre-existing — don't block on them."

If the customer's repo has uncaptured findings that are real security issues (hardcoded secrets, leaked API keys, etc.), creating a baseline NOW locks those in as accepted. They won't trip the guardrail check.

Before running `baseline create` on a customer who has NEVER captured one, surface this tradeoff:

> Capturing a baseline locks in **N** current findings as "pre-existing." If any of those are real defects you'd want to fix first (secrets to rotate, vulnerable deps to upgrade), tell me and I'll show you what's flagged so we can triage before baseline.
>
> Skip baseline now if: you have secrets in the repo, or you'd rather fix-as-you-go than accept the current state.
> Capture baseline now if: the codebase is a known-messy brownfield and you want guardrails on future regressions specifically.

If they say "show me what's flagged first," hand off to `dxkit-action` — that skill triages findings before baseline lock-in.

## What dxkit-fix can NOT repair

These need a different skill or human action:

- **Code findings** (hardcoded secrets, lint errors, duplicates, missing tests) — `dxkit-action` handles triage + fixing. Doctor only flags that the install is working; the analyzer results are a separate surface.
- **Branch protection on the GitHub repo** — needs `gh api` credentials + repo-admin rights. The `setup-branch-protection` CLI (when available) wraps this. If doctor flags the workflow as missing but the customer's CI is healthy on PRs, this is a documentation gap, not an install gap.
- **Real secret rotation** — even after dxkit detects a hardcoded API key, the credential needs to be rotated in its issuing provider's UI by a human.
- **External tool toolchains** (e.g. a Go compiler for stacks that don't have Go) — dxkit's TOOL_DEFS install most scanner tools; toolchains for the customer's project itself are out of scope.

## When to delegate to a more specific dxkit-* skill

Doctor's `fix.skill` field signals "this is more nuanced than a single command — walk through it via that skill." Cases:

| `fix.skill` | When to delegate |
|---|---|
| `dxkit-init` | Customer doesn't have a manifest at all — they need the full first-install flow, not a repair. |
| `dxkit-hooks` | Hook-related repair where the customer also wants chaining advice (husky/lefthook integration, bypass workflow, removal). |
| `dxkit-config` | Customer wants to tune what dxkit flags (e.g. exclude a vendored dir, adjust severity policy) rather than fix a broken state. |
| (no skill, command only) | Plain repair — apply the command and move on. |

If `fix.skill === "dxkit-fix"`, that's the default path — handle it here.

## Idempotency + safety

Every repair this skill drives is idempotent and reversible:

- `hooks activate` is no-op if hooks already pointed at .githooks
- `baseline create` refuses to overwrite an existing baseline without `--force` — so accidentally running it twice can't corrupt state
- `tools install --yes` skips already-installed tools (per TOOL_DEFS check command)
- `npm install -g @vyuhlabs/dxkit` upgrades or installs as needed; no data loss
- `.npmrc` append is line-deduplicated

So a customer who declines a fix, then runs into it again later, can re-invoke the skill with no penalty.

## Failure modes

If a fix command fails (non-zero exit):

1. **Capture the stderr** so the customer can see why
2. **Don't auto-retry** — the customer's environment may have a problem the fix can't solve (no network, permission denied, registry hiccup)
3. **Suggest a manual workaround** if there's an obvious one (e.g. for global install failures, suggest `sudo npm install -g` on systems where the npm prefix isn't user-writable)
4. **Continue with the remaining fixes** — one failure shouldn't block the rest

Surface failures in the final summary alongside what DID get fixed.

## Final summary

After the loop completes, structure the report:

```
✓ Repaired:
   • git hooks active
   • vyuh-dxkit on PATH

✗ Failed:
   • baseline captured — `vyuh-dxkit baseline create` exit 1 (no .dxkit/ write permission?)

→ Skipped:
   • .npmrc legacy-peer-deps persistence (you declined)

Remaining issues (not auto-fixable):
   • CI guardrails workflow missing → ask 'set up dxkit init' to walk through init --with-ci
```

End with a one-line CTA: "Run `npx vyuh-dxkit doctor` to confirm the final state, or ask 'fix dxkit' again if anything new comes up."
