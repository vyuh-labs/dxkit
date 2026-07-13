---
name: dxkit-pr
description: Open a pull request with a title + body grounded in the branch's real commits and diff — what changed, features implemented, findings fixed — plus a reviewer checklist and the dxkit guardrail/allowlist/score signals a reviewer needs. Use when the user says "raise a PR", "open a pull request", "create the PR", "write the PR description", or after dxkit-feature / dxkit-action finishes a change and it's ready to push for review.
---

# dxkit-pr

This skill turns a finished branch into a **reviewable** pull request: a title
and body grounded in what actually changed (not a generic template), and a
checklist that guides the reviewer through what to verify. It's the natural
close of `dxkit-feature` (built something) and `dxkit-action` (fixed findings) —
both hand off here when the work is ready for review.

A good PR description is written from the diff, not from memory. This skill
reads the branch, summarizes it honestly, and attaches the dxkit signals
(guardrail verdict, allowlist activity, score movement) a reviewer would
otherwise have to reconstruct by hand.

## The PR loop

```
[1] Compute     → `vyuh-dxkit pr` builds the body from the real commits + diff
[2] Narrate     → you write only "What & why"; tailor the computed checklist
[3] Confirm     → show the user the draft; open with `gh pr create` on yes
```

The heavy lifting is one command. `vyuh-dxkit pr` reads `base..HEAD` and emits a
ready-to-review body with the parts that used to drift when hand-assembled:

- a **title** from the dominant conventional-commit type + scope,
- a **Changes** section bucketed by commit type (Features / Fixes / Refactors / …),
- the **dxkit signals** block (the receipt: guardrail verdict + allowlist delta),
- **suggested reviewers** (the active-owner model, blended with CODEOWNERS),
- a **diff-derived reviewer checklist** (a supply-chain row only when a manifest
  moved, a migration row only when a migration moved, a tests row when source
  changed without a test, …), and
- a **Structural review** section: functions this change adds that structurally
  match existing code — the seam signal as a reviewer prompt, not a block.

Everything there is computed from the branch, so the body can't misrepresent the
change. Your job is the narrative ("What & why") and pruning/tailoring the
checklist to the actual change.

```bash
vyuh-dxkit pr --base <base-branch>              # markdown body on stdout
vyuh-dxkit pr --base <base-branch> --since <base-branch>   # + health-score movement
vyuh-dxkit pr --base <base-branch> --json       # every computed field, to parse
```

`--since <ref>` adds the per-dimension score-movement table (it runs a base-ref
analysis, so omit it if you only need the verdict + checklist). `--no-seams`
skips the structural-duplicate pass. The command reads git + the (cache-backed)
guardrail and writes nothing — it never opens the PR.

Don't skip [3]. A PR is outward-facing — show the draft and get a yes before
opening it.

## [1] Compute — run the command, read what it produced

```bash
git fetch origin
vyuh-dxkit pr --base origin/main --since origin/main    # or the repo's default branch
```

The body it prints is the draft's skeleton. Skim the diff (`git diff --stat
$BASE...HEAD`) to confirm the computed classification matches what you know you
changed — the command reads commit *subjects*, so a poorly-titled commit lands in
the `Other` bucket, and that's your cue to describe it in the narrative.

Two computed sections are load-bearing and you should read them, not just paste:

- **dxkit signals** — the guardrail verdict + allowlist delta. If it's BLOCKED,
  the PR isn't ready: hand off to `dxkit-action` to fix the net-new findings
  first. The block reuses the session verdict cache, so it's the same result the
  pre-push hook produced moments ago, not a fresh scan.
- **Structural review** — functions this change adds that structurally match
  existing code. This is advisory (warn-tier, never a block): for each one,
  either confirm in the narrative that the parallel is intentional, or consolidate
  before opening. It's exactly the "you copied an existing function" signal a
  human reviewer would otherwise have to notice by eye.

Reviewers come from the **active-owner model** (recency-weighted git history,
bots + departed devs filtered, author excluded, blended with CODEOWNERS). Honor
its caveats: a `busFactor: 1` line is a real single-point-of-failure to call out;
a `note` (owners inactive / no signal) means don't invent a reviewer. It renders
`@handle`s, never emails, and you can pass them to `gh pr create --reviewer`.

## [2] Narrate + tailor — the only hand-written parts

The command leaves one placeholder: `## What & why`. Write the problem this
solves and the approach, in 1–3 sentences — proportional to the change (a
one-commit fix gets a line; a multi-commit feature gets a short paragraph).
Refine the suggested **title** if the computed one is generic (it's the dominant
commit type + the headline commit's subject; make it specific and imperative).

Then **tailor the computed checklist** to the actual change — the rules are
diff-derived (a supply-chain row appears only when a manifest moved, a migration
row only when a migration moved), but you know things the diff can't show: drop a
row that doesn't apply, add a specific one (a config flag to set, a caller to
re-test from the blast radius, a manual step to run). A targeted checklist guides
the review; a generic one is noise.

## [3] Confirm + open

Show the user the full draft (title + body) and confirm. On yes:

```bash
git push -u origin HEAD                # if not already pushed
gh pr create --base main --title "<title>" --body "<body>" \
    --reviewer <handle1>,<handle2>     # the active owners from `reviewers`, if any
```

If `gh` isn't authenticated, print the title + body for the user to paste, and
point them at `gh auth login`. Never open a PR the user hasn't seen.

## Scope — what NOT to do

- Don't invent changes the diff doesn't show, or claim a finding is fixed
  without having verified it (re-run the analyzer first — see `dxkit-action`).
- Don't open the PR before the guardrail is green, unless the user explicitly
  wants a draft PR for early review — and then mark it draft and say so in the body.
- Don't restate every commit verbatim — synthesize. The commit log is one click
  away; the body's job is the narrative + the review guidance.

## Hand-offs

- A guardrail FAIL blocking the PR → `dxkit-action` to fix the net-new findings first.
- Writing the feature being PR'd → `dxkit-feature`; closing test gaps it opened → `dxkit-test`.
- Branch-protection / required-check setup so the PR is actually gated → `dxkit-hooks` / repo settings.
