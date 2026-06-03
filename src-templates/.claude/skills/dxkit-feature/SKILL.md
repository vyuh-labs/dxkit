---
name: dxkit-feature
description: Develop a new feature with the code graph as your map — orient cheaply by querying structure instead of reading whole files, implement following the patterns already in the repo, then verify the change did not regress security, tests, or quality before you push. Use when the user says "add a feature", "implement X", "build the Y flow", "where should this live", or otherwise starts net-new development in a dxkit-scaffolded repo.
---

# dxkit-feature

This skill drives forward development — building something new — the way
`dxkit-action` drives the reverse (fixing what's flagged). Its two jobs:

1. **Orient by graph, not by grep.** Use the code graph to find where the
   feature plugs in, what patterns already exist, and what a change will
   touch — at a fraction of the tokens that repeated whole-file reads cost.
2. **Close the loop a plain coding agent skips.** After the edit, run the
   dxkit analyzers on the change and the guardrail check, so the new feature
   doesn't quietly ship a vuln, a test gap, or a quality regression.

## The feature loop

```
[1] Clarify        → what's the feature + what does "done" mean
[2] Orient         → query the graph: where it lives, patterns, blast radius
[3] Plan           → ordered edits, reusing the patterns found in [2]
[4] Build          → read only the files the graph named, then implement
[5] Verify         → run the analyzers on the change; confirm nothing regressed
[6] Decide baseline→ commit, or re-baseline if the change is deliberately accepted
```

Don't skip [2] or [5]. [2] is where the token saving lives; [5] is the whole
reason to use dxkit for forward work instead of a generic agent.

## [2] Orient — query structure before you read files

This is the step that differentiates this skill. **Orientation (discovery)
is where direct agents burn the most tokens** — grep, read a 2,000-line
file, grep again, read another. The graph answers the same questions from a
budget-bounded slice instead.

Run `health` once first if there's no graph yet (it writes
`.dxkit/reports/graph.json` as a side effect), then query:

```bash
# "Where is this feature area implemented?" — clusters of matching symbols
npx vyuh-dxkit explore feature auth

# Token-budgeted structural slice for an area you're about to extend:
# anchor symbol, its callers/callees grouped by module, blast radius
npx vyuh-dxkit context "checkout session"

# Zoom into one symbol's exact neighborhood (curated AST chunk, not the
# whole file) — read 500 focused lines instead of ingesting 15k
npx vyuh-dxkit context src/payments/checkout.ts:142

# One file's structural neighborhood — symbols, callers, callees, imports
npx vyuh-dxkit explore file src/payments/checkout.ts

# The repo's public API / dead surface — useful when adding an entry point
npx vyuh-dxkit explore api-surface
```

Use the answers to decide three things before you write anything:

- **Where the feature plugs in** — which module/cluster owns this area, so
  the new code lands next to its neighbors rather than in a new island.
- **Which pattern to copy** — read the anchor symbol the graph points at;
  it's the highest-in-degree example of "how this repo already does X."
  Match its shape (error handling, validation, naming) so the feature reads
  like the surrounding code.
- **The blast radius** — how many caller files a change to the touched
  symbols reaches. That's your re-test list for step [5].

### Honest scope of the graph win (don't oversell it)

The reduction is a **navigation-phase win, not an end-to-end multiplier.**
The graph cuts the cost of *finding and orienting*; the *edit* phase still
reads the real files you change, and *verification* still runs the real
analyzers. The win is largest in big, unfamiliar codebases (orientation-by-
grep is expensive there) and near-zero in a small repo whose relevant files
already fit in context. Lead with the graph for discovery; then read the
actual code you're about to modify — `context` is a map, not a substitute
for the territory.

### Three hard rules for graph context (same as dxkit-action)

1. **It's a hint, never ground truth.** Confirm the symbol and call sites by
   opening the file before you act on them — the graph stores declaration
   lines, not end lines, and same-name symbols can conflate.
2. **A blank or `n/a` blast radius is NOT "safe to change".** Languages whose
   call graph dxkit can't fully resolve (C# is the known case) report no
   callers even for heavily-used files. Treat empty as *unknown* — fall back
   to grep/read to find callers before a risky edit. Never read "no callers"
   as "free to rewrite."
3. **Fall open — the graph is an accelerator, never a dependency.** If
   graphify hasn't built a graph yet, `context` / `explore` print
   `No graph.json … Run vyuh-dxkit health or pass --refresh` and exit
   non-zero (they never crash or hang). Two responses, in order:
   - Build it once: `npx vyuh-dxkit health` writes `graph.json` as a side
     effect, or add `--refresh` to any explore/context call. Do this if the
     repo is large enough that the orientation saving is worth one scan.
   - Or just orient the normal way — grep + read — and carry on. You lose
     the token saving, not the ability to build the feature.

### If graphify isn't installed at all

The graph is built by **graphify** (a registry tool). If it isn't installed,
`health` won't produce a `graph.json`, so step [2]'s graph queries are
unavailable — fall back to grep + read as above, or install it to unlock the
saving:

```bash
npx vyuh-dxkit tools install   # installs graphify + the other scanners
```

**Steps [5] and [6] do not need graphify.** The `vulnerabilities`,
`test-gaps`, `quality`, and `guardrail check` commands run fully without a
graph — only the `--graph-context` *enrichment* is suppressed (drop the flag
and the reports are still complete). So verification never depends on the
graph being present; only the orientation *speed-up* does.

## [3] Plan

Write an ordered list of edits. For each, name the file and the existing
pattern it mirrors (from step [2]). Prefer extending an existing module over
creating a new one unless the graph showed no natural home. Call out the
caller files in the blast radius that will need updating or re-testing.

## [4] Build

Read only the files the orientation step named — that's the point of doing
[2] first. Implement following the matched pattern. Keep the change tight:
comment density, naming, and idioms should match the surrounding code, not a
generic template.

## [5] Verify — never skip

A new feature can introduce exactly the things dxkit scans for: a SAST
finding, a vulnerable dependency you just added, an untested new surface, a
quality/slop regression. Run the analyzers on the changed area, with graph
context attached so you see each finding's blast radius:

```bash
npx vyuh-dxkit vulnerabilities --detailed --graph-context   # new code + new deps
npx vyuh-dxkit test-gaps --graph-context                    # is the new surface tested?
npx vyuh-dxkit quality --graph-context                      # slop / duplication / complexity
```

Then gate the change the same way CI will:

```bash
npx vyuh-dxkit guardrail check
```

Exit 0 = the feature added no net-new regressions. Exit 1 = something new
appeared — **a finding you introduced.** Address it before pushing:

- A real finding in your new code → fix it now (hand off to `dxkit-action`
  for the fix recipes — secret rotation, dep upgrade, writing the missing
  test, etc.).
- A genuine false positive / intentional pattern → allowlist with a typed
  category + reason (see `dxkit-action`'s allowlisting section). Fix first;
  allowlist second.

The feature isn't done when it works — it's done when it works **and** the
guardrail is green.

## [6] Baseline decision

| Scenario | Action |
|---|---|
| Feature is clean; guardrail green | Just commit the code. Baseline + allowlist unchanged. |
| You fixed an introduced finding | Commit the code + fix together. Baseline unchanged. |
| Introduced finding is a true false positive / intentional | `vyuh-dxkit allowlist add` with `category=false-positive` or `test-fixture`; commit the annotation. |
| Feature deliberately accepts a known trade-off (documented) | `vyuh-dxkit allowlist add` with `category=accepted-risk` + `--expires`; never re-baseline silently. |

Prefer the allowlist over re-baselining for per-finding calls — it carries a
typed reason a future maintainer can read. Reserve "accept as baseline" for
the deliberate codebase-wide line-in-the-sand, not for hiding a finding your
own feature introduced.

## Hand-offs

- A finding the guardrail blocked needs fixing → `dxkit-action` (the fix-loop
  recipes for secrets, dep-vulns, SAST, test gaps).
- Re-running reports between iterations → `dxkit-reports`.
- Ignore-file / config edits as part of the feature → `dxkit-config`.
- Hook problems on the verify push → `dxkit-hooks`.
- Deeper structural exploration than `context` gives (entry-points,
  communities, hot-files) → run `npx vyuh-dxkit explore <subcommand>`
  directly; see the `explore` command docs.
