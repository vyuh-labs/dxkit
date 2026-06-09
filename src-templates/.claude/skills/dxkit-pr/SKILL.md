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
[1] Survey      → branch vs base: commits, diff stat, files touched
[2] Classify    → features / fixes / refactors / docs / findings closed
[3] Signals     → guardrail verdict + allowlist activity + score deltas
[4] Draft       → title + body grounded in [1]–[3] + a reviewer checklist
[5] Confirm     → show the user the draft; open with `gh pr create` on yes
```

Don't skip [5]. A PR is outward-facing — show the draft and get a yes before
opening it.

## [1] Survey — read the branch, don't guess

```bash
git fetch origin
BASE=origin/main                      # or the repo's default branch
git log --oneline $BASE..HEAD         # every commit on this branch
git diff --stat $BASE...HEAD          # files + churn
git diff $BASE...HEAD                 # the actual change, when you need detail
```

Read the commit messages first — on a well-kept branch they already narrate the
work. Use the diff to verify and fill gaps, not to re-derive everything.

## [2] Classify — group the change for a reviewer

Sort the commits/diff into the buckets a reviewer cares about:

- **Features** — new capability, with the entry point / surface it adds.
- **Fixes** — bugs or findings closed (name the finding if it came from a dxkit
  report: rule, file, severity).
- **Refactors** — behavior-preserving structure changes (flag these — they're
  where "looks big, reads safe" lives).
- **Docs / tests / chore** — supporting changes.

Lead the body with the *why* (the problem) and the *what* (the approach), then
the bucketed change list. Keep it proportional — a one-commit fix gets a short
body; a multi-commit feature gets sections.

## [3] Signals — attach what dxkit knows

Run the guardrail so the PR states its own verdict, and surface any suppression
activity a reviewer must sign off on:

```bash
npx vyuh-dxkit guardrail check                       # PASS/FAIL the PR will get in CI
npx vyuh-dxkit allowlist audit                        # any new/expiring suppressions?
npx vyuh-dxkit health --detailed | head -40           # score movement, if relevant
```

Put in the body:

- **Guardrail verdict** — PASS, or FAIL with the net-new findings named (a
  reviewer should know before CI tells them).
- **Allowlist activity** — any suppression added on this branch, with its
  category + reason + expiry, called out for explicit review (suppressions are
  the highest-trust thing a reviewer approves).
- **Score deltas** — only when the change targeted a dimension (e.g. "Tests
  62 → 71 after closing the auth gaps"). Don't pad with unchanged scores.

## [4] Draft — title, body, reviewer checklist

**Title** — imperative, scoped, specific. `feat(auth): add refresh-token
rotation`, not `Updates`. Match the repo's existing PR/commit convention
(check `git log` on the base branch).

**Body** — structure:

```markdown
## What & why
<the problem this solves, in 1–3 sentences>

## Changes
- **Feature:** …
- **Fix:** … (closes <finding/issue>)
- **Refactor:** … (behavior-preserving)

## dxkit signals
- Guardrail: ✅ PASS  (or ❌ + the net-new findings)
- Allowlist: <new suppressions + reason + expiry, or "no changes">
- Scores: <dimension deltas, if the change targeted one>

## Reviewer checklist
- [ ] Change matches the description; scope isn't broader than stated
- [ ] <feature>: behavior verified (how to exercise it)
- [ ] Refactors are behavior-preserving (no silent semantic change)
- [ ] New/changed code is tested; test gaps addressed or noted
- [ ] Any allowlist suppression is justified (category + reason + expiry)
- [ ] No secrets/keys/tokens in the diff
- [ ] Docs updated if behavior or interfaces changed
```

Tailor the checklist to the *actual* change — drop rows that don't apply, add
specific ones (a migration step, a config flag to set, a caller to re-test from
the blast radius). A generic checklist is noise; a targeted one guides the review.

## [5] Confirm + open

Show the user the full draft (title + body) and confirm. On yes:

```bash
git push -u origin HEAD                # if not already pushed
gh pr create --base main --title "<title>" --body "<body>"
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
