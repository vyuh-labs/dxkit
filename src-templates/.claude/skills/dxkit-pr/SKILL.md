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

## [3] Signals — one command, computed not narrated

The signals block (guardrail verdict, allowlist delta, score movement) is a
COMMAND, not something you hand-assemble: `vyuh-dxkit receipt`. It emits
ready-to-paste markdown, so the PR body can never misrepresent gate state, and
it **reuses the verdict cache** — a feature session normally ran the gate against
this exact HEAD moments ago (dxkit-feature verify, the pre-push hook), so
`receipt` replays that result instead of paying a third ~25s scan. It re-runs
only when the tree actually changed since the last gather.

```bash
npx vyuh-dxkit receipt --since <base-branch>    # verdict + allowlist delta + score movement
```

- `--since <ref>` adds the health-score movement vs the base branch (it runs a
  base-ref analysis, so omit it if you only need the verdict + allowlist — that
  part is always cached and instant).
- `--json` if you want to parse it; `--refresh` forces a fresh gather (rarely
  needed — the cache already misses on any real tree change).

Paste `receipt`'s output straight into the body under `## dxkit signals`. It
already contains:

- **Guardrail verdict** — PASS, or BLOCKED with the net-new findings named.
- **Allowlist delta** — any suppression added on this branch, with category +
  reason + expiry, called out for explicit review (suppressions are the
  highest-trust thing a reviewer approves).
- **Score movement** — the per-dimension base→head table (only with `--since`).

Because the block is computed, you don't transcribe numbers by hand — that's
what used to let a PR body drift from the real gate state. `receipt` is
informational (it never fails the command); `guardrail check` remains the gate.

### Suggested reviewers

```bash
npx vyuh-dxkit reviewers --base <base-branch> --json
```

This ranks reviewers by the **active-owner model** — recency-weighted git
history on the touched files, with bots and departed contributors filtered, the
PR author excluded, blended with `CODEOWNERS`. Better signal than the platform's
naive last-touch suggestion. Surface the top few in the body with the *why*
("@alice — owns 3/4 touched files, active"), and you can pass them to
`gh pr create --reviewer`. Honor the output's caveats: if it returns a
`busFactor: 1`, note the single-point-of-failure; if it returns a `note`
(original authors inactive / no signal), say so rather than inventing a
reviewer. Renders `@handle`s, never emails.

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

<!-- ## dxkit signals — paste `vyuh-dxkit receipt --since <base>` output here.
     It already renders the verdict, allowlist delta, and score-movement table. -->

## Suggested reviewers
- @alice — owns 3/4 touched files, active · @bob — CODEOWNERS
  (or the `note` when there's no active-owner signal)

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
