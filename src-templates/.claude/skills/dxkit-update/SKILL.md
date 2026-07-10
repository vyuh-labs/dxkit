---
name: dxkit-update
description: Walk the customer through upgrading dxkit to a newer version safely. Use when the user asks "update dxkit", "upgrade to latest", "what's new in dxkit", "is there a new dxkit version", "should I upgrade dxkit", or anything about moving an existing dxkit install forward. Reads version delta + changelog + recommended steps; confirms each step. Hands off to dxkit-fix if post-upgrade doctor surfaces broken signals.
---

# dxkit-update

This skill drives the dxkit upgrade flow conversationally. It's the "I have something working — make it newer" surface (complement to `dxkit-onboard` for fresh installs and `dxkit-fix` for repairs).

## When to use this skill

Use when:

- "Is there a new dxkit version?"
- "Update dxkit"
- "Upgrade to latest"
- "What changed in dxkit recently?"
- "What's new in 3.1.0?" (or any other specific version)
- "Should I upgrade?"

Don't use when:

- Customer has no `.vyuh-dxkit.json` (they need `dxkit-init`, not update)
- Something is BROKEN — use `dxkit-fix` first; then maybe update after
- Customer wants to roll back to an older version (downgrade — surface the risk + manual command, don't auto-execute)

## How the upgrade works (two stages)

dxkit ships in two layers and an upgrade touches both:

1. **The binary** — `@vyuhlabs/dxkit` npm package. `npm update` or `npm install @vyuhlabs/dxkit@<version>` replaces the local binary.
2. **The scaffold** — files in the customer's repo (`.devcontainer/`, `.githooks/`, `.claude/skills/dxkit-*/`, `AGENTS.md`, `CLAUDE.md`, `.github/workflows/dxkit-*.yml`). `npx vyuh-dxkit update` refreshes these to match the new binary's templates.

`vyuh-dxkit update` also does one more thing automatically: if the new binary changed the **finding-identity scheme** (how baselines + allowlists fingerprint findings), it **migrates the committed baseline and allowlist** onto the new scheme — re-anchoring every reviewed suppression so nothing has to be re-reviewed. This is deterministic and lives in the CLI; the skill's job is to surface what it did, handle the rare entry it couldn't map, and get the result committed. See "Identity-scheme migration" below.

Both stages run for any non-trivial upgrade. The CLI subcommand `vyuh-dxkit upgrade` orchestrates them (its plan includes `vyuh-dxkit update` as a step); this skill drives the customer through the orchestration with explanations and confirmations.

## The upgrade loop

```
[1] Read the plan        → npx vyuh-dxkit upgrade --plan --json
[2] Explain the delta    → current vs target, classification, what's new
[3] Surface warnings     → major bumps, breaking changes, scaffold drift
[4] Confirm              → "proceed?" (default Y for low-risk; default N for major/downgrade)
[5] Execute              → drive each step with per-step status
[6] Verify               → run doctor + report operational health post-upgrade
[7] Surface manual steps → devcontainer rebuild instructions if .devcontainer/ changed
```

## Steps

### 1. Snapshot the plan

```bash
npx vyuh-dxkit upgrade --plan --json > /tmp/dxkit-upgrade-plan.json
```

The JSON has shape `{ schema: "upgrade-plan.v1", current: { binary, scaffold }, target, delta, steps: [...], warnings: [...], changelogNote }`. Capturing to a file (instead of piping inline) lets the customer re-read the plan if they pause mid-flow.

### 2. Explain what's about to happen

Translate the structured plan into customer-friendly prose:

| Plan field | What to say |
|---|---|
| `current.binary` + `current.scaffold` | "You're on dxkit X (scaffold also X). Latest: Y." |
| `delta: 'none'` | "Already up to date — nothing to do." Skip to End. |
| `delta: 'patch'` | "N patch versions between you and latest. Low risk — bug fixes + small features only." |
| `delta: 'minor'` | "Minor bump — new features + scaffold changes likely. Probably safe; CHANGELOG.md has details." |
| `delta: 'major'` | "**Major bump** — read CHANGELOG.md for breaking changes BEFORE upgrading. Possible baseline/manifest schema migrations; possibly broken policy files; possibly removed CLI flags." |
| `delta: 'downgrade'` | "Target is OLDER than installed. Downgrades aren't officially supported — baseline/manifest schemas may differ. Surface this and let the customer decide." |

### 3. Surface every warning

Iterate `plan.warnings` and present each as its own bullet. Don't bury them. If `warnings` is empty, mention "No warnings — proceed when ready."

### 4. Confirm before execution

Ask:

> **Proceed with the upgrade?**

Default Y for patch/minor; default N for major/downgrade. If they decline, end gracefully — leave the plan in their hands.

### 5. Execute step-by-step

For each step in `plan.steps`:

- Skip `optional: true` steps from auto-execution (devcontainer rebuild is the only one today; surface it after)
- Show: "[i/N] purpose"
- Run: the command via Bash
- Note: success/failure based on exit code

If any step fails, **stop**. Don't continue with downstream steps. Surface:

- Which step failed + its stderr
- Suggested recovery: "Run `npx vyuh-dxkit doctor` to see current state, or invoke the `dxkit-fix` skill to walk through repair."

**Peer-dep ERESOLVE on the binary install.** The most common failure on a
brownfield Node repo: `npm install @vyuhlabs/dxkit@<version>` aborts with
`npm error code ERESOLVE` from a conflict in the project's *own* existing
dependency tree (not dxkit's). It's a pre-existing conflict the upgrade
merely surfaces. Recovery: retry the same command with `--legacy-peer-deps`
(npm's own error message also suggests this), then persist the choice so
future installs don't re-hit it: `echo "legacy-peer-deps=true" >> .npmrc`.
After it succeeds, continue the loop. (`doctor` flags a missing `.npmrc`
persistence as its own operational check.)

### 5b. Identity-scheme migration (automatic, inside `vyuh-dxkit update`)

When the new binary changed the finding-identity scheme, the `vyuh-dxkit update`
step (5) migrates the committed baseline + allowlist automatically. You don't run
a separate command — you **read its output and react**. Two signals tell you a
migration happened:

- The console prints lines like `✓ Re-baselined onto identity scheme vN.` and
  `✓ Allowlist migrated: X re-anchored, Y unchanged` (and, if any, `Z unmapped`).
- A pre-`update` guardrail run would have stopped with
  `Baseline "<name>" was captured under finding-identity scheme vA, but this
  dxkit mints vB … Run vyuh-dxkit update`. (If the customer hit that message
  first, this is the fix — reassure them it's expected, not a failure.)

What to do with the report:

1. **Explain it in one line.** "Your fingerprints changed in this version; dxkit
   re-anchored your baseline and all X reviewed suppressions automatically — no
   re-reviewing needed."
2. **Handle `unmapped` entries — the one spot that needs judgment.** An unmapped
   allowlist entry is a suppression whose finding no longer exists under the new
   scheme (the finding was fixed/removed, or its metadata is insufficient to
   recompute). Do NOT silently drop them. List each (`fingerprint`, `kind`,
   `reason`) and ask the customer whether to remove it (likely stale) or keep it
   (defer). `0 unmapped` → say so and move on.
3. **Get it committed.** `update` prints "Commit .dxkit/baselines + .dxkit/allowlist.json
   to finish the migration." Offer to stage and commit exactly those:
   ```bash
   git add .dxkit/baselines .dxkit/allowlist.json
   git commit -m "chore(dxkit): migrate finding-identity scheme on upgrade"
   ```
   For `ref-based` repos (no committed baseline) there's nothing to commit —
   each run re-gathers both sides under the new scheme. Say so and skip.

### 6. Verify with doctor (+ guardrail if a migration ran)

If all steps succeeded, run `npx vyuh-dxkit doctor` and report. If doctor surfaces operational issues post-upgrade (e.g. `summary.fixable[]` not empty), **hand off to dxkit-fix** — say "Upgrade complete, but doctor surfaced N gaps. Walking through dxkit-fix to close them."

If an identity-scheme migration ran in step 5b, also run `npx vyuh-dxkit guardrail check` once. The migration succeeded iff the guardrail **does not** report a wave of net-new findings caused by the scheme change (a clean run shows the prior findings as `persisted`, blocking 0). If it instead blocks on many net-new at once, the migration didn't take — surface the output and hand off to dxkit-fix rather than letting the customer commit a broken baseline.

### 7. Surface manual follow-ups

Iterate optional steps in the plan:

```
⚠ Your .devcontainer/ was refreshed. Rebuild your container to pick up:
    VSCode:     Command Palette → "Dev Containers: Rebuild Container"
    Codespaces: Command Palette → "Codespaces: Rebuild Container"
    Local Docker: `docker compose down && docker compose up -d --build`
```

## What dxkit-update can NOT do

- **Cross-major migrations** — major bumps may need MIGRATION.md guidance + manual policy edits. Surface the link; don't auto-execute.
- **Customer code changes** — if the upgrade requires changes to the customer's scoring policy or workflow file customizations, point at the CHANGELOG.md section and stop. (Finding-identity scheme changes are the exception: `vyuh-dxkit update` migrates the baseline + allowlist automatically — see step 5b. Don't stop for those; drive them.)
- **Re-derive a finding's identity by hand** — the old→new fingerprint mapping is deterministic and owned by the CLI's migrator. The skill explains, surfaces unmapped entries, and commits the result; it never recomputes a fingerprint itself.
- **Downgrades** — never auto-execute. Always confirm; warn about schema differences; suggest backing up `.dxkit/baselines/` first.
- **Rollback** — if execution mid-step fails, dxkit-update can't undo the binary install. Customer needs to `npm install @vyuhlabs/dxkit@<previous-version>` themselves.

## Boundary with other lifecycle skills

| Customer state | Reach for |
|---|---|
| "I have nothing" | `dxkit-onboard` |
| "I have working install, make it newer" | **dxkit-update (this skill)** |
| "Doctor says X is broken" | `dxkit-fix` |
| "I want to run a report" | `dxkit-reports` |
| "Fix these findings" | `dxkit-action` |
| "Write the missing tests" | `dxkit-test` |
| "Write the missing docs" | `dxkit-docs` |
| "Manage / audit the allowlist" | `dxkit-allowlist` |
| "Raise the PR" | `dxkit-pr` |
| "Configure dxkit" | `dxkit-config` |
| "Set up hooks" | `dxkit-hooks` |
| "Explain dxkit" | `dxkit-learn` |
| "Set up / operate the loop gate" | `dxkit-loop` |

**Loop pack on upgrade:** if the repo opted into the loop pack (`init --claude-loop`), `vyuh-dxkit update` refreshes its Stop hook + CLAUDE.md loop block automatically — additive and idempotent, and it never resets the chosen `loop.preset`. No separate step. For setting it up on a repo that doesn't have it yet, or operating it, hand off to **dxkit-loop**.

If the customer asks something that spans skills (e.g. "update dxkit and then fix the new issues"), chain: dxkit-update first, then auto-invoke dxkit-fix on the post-upgrade doctor output.

## CHANGELOG hygiene (worth raising)

The plan's `changelogNote` field points at the canonical CHANGELOG.md URL. Currently it's just a pointer — future versions of `vyuh-dxkit upgrade --plan` may parse the changelog and surface per-version highlights inline. For now, when the customer asks "what changed?", offer to fetch + summarize the CHANGELOG.md for the version range:

```bash
# Fetch the changelog locally (the installed package ships it)
cat node_modules/@vyuhlabs/dxkit/CHANGELOG.md
```

Or for content between current and target (which isn't in the installed tarball until AFTER upgrade), suggest visiting the URL in `plan.changelogNote`.

## Final report

After the loop completes:

```
✓ Upgraded: dxkit X → Y
✓ Scaffold refreshed: N files updated, M new (e.g. dxkit-fix skill if upgrading from <2.5.2)
✓ Identity scheme migrated: baseline re-anchored, K suppressions carried over (0 unmapped)  ← only if a migration ran
✓ Doctor: all green   ·   Guardrail: clean (no scheme-driven net-new)
○ Manual: rebuild devcontainer to pick up changes
○ Committed .dxkit/baselines + .dxkit/allowlist.json (migration)
```

Or if something failed:

```
✗ Upgrade halted at step [i/N]: <purpose>
   stderr: <captured>
   → Recovery: `npx vyuh-dxkit doctor` to see current state; ask "fix dxkit" to walk through repair
```

End with a one-line CTA: "Anything else? Ask 'check dxkit health' to see current scores on the new version."
