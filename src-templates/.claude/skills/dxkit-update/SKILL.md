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
- "What's new in 2.5.5?" (or any other specific version)
- "Should I upgrade?"

Don't use when:

- Customer has no `.vyuh-dxkit.json` (they need `dxkit-init`, not update)
- Something is BROKEN — use `dxkit-fix` first; then maybe update after
- Customer wants to roll back to an older version (downgrade — surface the risk + manual command, don't auto-execute)

## How the upgrade works (two stages)

dxkit ships in two layers and an upgrade touches both:

1. **The binary** — `@vyuhlabs/dxkit` npm package. `npm update` or `npm install @vyuhlabs/dxkit@<version>` replaces the local binary.
2. **The scaffold** — files in the customer's repo (`.devcontainer/`, `.githooks/`, `.claude/skills/dxkit-*/`, `AGENTS.md`, `CLAUDE.md`, `.github/workflows/dxkit-*.yml`). `npx vyuh-dxkit update` refreshes these to match the new binary's templates.

Both run for any non-trivial upgrade. The CLI subcommand `vyuh-dxkit upgrade` orchestrates them; this skill drives the customer through the orchestration with explanations and confirmations.

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

### 6. Verify with doctor

If all steps succeeded, run `npx vyuh-dxkit doctor` and report. If doctor surfaces operational issues post-upgrade (e.g. `summary.fixable[]` not empty), **hand off to dxkit-fix** — say "Upgrade complete, but doctor surfaced N gaps. Walking through dxkit-fix to close them."

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
- **Customer code changes** — if the upgrade requires changes to the customer's scoring policy, baseline schema, or workflow file customizations, point at the CHANGELOG.md section and stop.
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
✓ Doctor: all green
○ Manual: rebuild devcontainer to pick up changes
```

Or if something failed:

```
✗ Upgrade halted at step [i/N]: <purpose>
   stderr: <captured>
   → Recovery: `npx vyuh-dxkit doctor` to see current state; ask "fix dxkit" to walk through repair
```

End with a one-line CTA: "Anything else? Ask 'check dxkit health' to see current scores on the new version."
