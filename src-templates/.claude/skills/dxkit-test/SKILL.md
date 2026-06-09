---
name: dxkit-test
description: Write the tests a repo is missing — read the test-gaps report (blast-radius-weighted), orient on what the untested code actually does via the graph, then write real tests that close the highest-risk gaps and move the Tests score without coverage theater. Use when the user says "write tests", "add tests for this module", "improve the test coverage / Tests score", "close the test gaps", "cover the untested files", or after a health report flags Testing.
---

# dxkit-test

This skill closes the gap `dxkit-action` doesn't: it **writes** the missing
tests rather than fixing flagged findings. It is the testing mirror of
`dxkit-docs` — same shape, different dimension. It's built around one hard
constraint: a test that doesn't actually exercise behavior (an empty `expect(true)`,
a snapshot of nothing, a call with no assertion) raises the coverage number
while proving nothing. The whole point of this skill is tests that are
**grounded in real behavior** and **catch real regressions** — not coverage
theater.

## The testing loop

```
[1] Read the gap   → test-gaps: the blast-radius-weighted untested worklist
[2] Orient         → graph: what the file does, who depends on it, what to assert
[3] Generate       → write real tests in the repo's framework + patterns
[4] Verify         → run the suite + coverage; Tests up, nothing red
[5] Guardrail      → guardrail check before pushing
```

Don't skip [2] or [4]. [2] is what makes the tests meaningful; [4] is what
proves they pass and the coverage actually moved.

## [1] Read the gap — what's actually untested, worst-first

Run the test-gaps report with graph context so the worklist is ranked by
**blast radius** (how many files depend on each untested file), not just size:

```bash
npx vyuh-dxkit test-gaps --detailed --graph-context
npx vyuh-dxkit test-gaps --detailed --graph-context --json | jq '.actions, .gaps[0:10]'
```

The report partitions untested files into CRITICAL / HIGH / MEDIUM / LOW risk
tiers, and **within each tier the most-depended-on files surface first** (the
`Graph context` column shows `role · N caller files`). Work top-down: a
30-caller untested file is a bigger liability than a 500-line leaf nothing
calls. The `actions` array names the top-K per tier with projected
score uplift — that's your queue.

A `blast radius n/a` cell means graphify couldn't resolve that language's call
graph (C# is the known case) — treat it as *unknown*, not "no callers," and
fall back to the file's role + size to judge its risk.

## [2] Orient — understand the behavior before you assert on it

A test is only as good as your understanding of what the code should do.
Before writing, learn the real shape from the graph (cheap, structural):

```bash
npx vyuh-dxkit context src/payments/refund.ts        # the file's symbols, callers, callees
npx vyuh-dxkit explore file src/payments/refund.ts   # its structural neighborhood
```

Use it to decide three things:

- **What the public contract is** — the exported symbols are what callers rely
  on; test those, not private helpers.
- **What the callers expect** — the caller files (blast radius) tell you the
  real usage shapes to cover, including the edge cases they pass.
- **What's risky** — error paths, branching, boundary conditions. Then **read
  the actual code** — the graph points you at it; it doesn't replace reading
  it.

## [3] Generate — real tests, the repo's way

- **Match the existing framework + conventions.** Detect what the repo already
  uses (vitest/jest, pytest, go test, JUnit, RSpec, …) from the existing test
  files and `test-gaps` output — never introduce a new test framework. Copy the
  nearest existing test's structure, naming, fixtures, and assertion style so
  the new tests read like the repo's.
- **Assert behavior, not existence.** Each test must exercise a real path and
  assert a real outcome — return values, side effects, error handling,
  boundaries. A test that calls a function and asserts nothing is slop.
- **Cover the contract + the edges.** Happy path, the error/edge cases the
  callers actually hit, and at least one boundary. Prioritize branches over
  lines.
- **Don't fake it.** No mocking the unit under test into a tautology; no
  asserting on a stub you wrote. Mock external boundaries (network, clock,
  fs) the way the repo already does.

## [4] Verify — Tests up, suite green, no coverage theater

```bash
# Run the repo's real test command (from package.json / Makefile / etc.)
<the repo's test command>            # e.g. npm test, pytest, go test ./...

# Re-materialize coverage + the gap report
npx vyuh-dxkit coverage              # runs the suite to produce real line coverage
npx vyuh-dxkit test-gaps --detailed  # the targeted gap should be gone / downgraded
```

The work is done when:

- The new tests **pass** (a failing or skipped test is not coverage).
- The targeted file is no longer in the gap worklist (or dropped a risk tier).
- `effectiveCoverage` rose from a real signal — prefer line-coverage truth
  (`coverage`) over the filename-match heuristic; a name-matched 5-line test on
  a 200-line file is exactly the theater this skill exists to avoid.

## [5] Guardrail — before pushing

```bash
npx vyuh-dxkit guardrail check
```

Exit 0 = your new tests didn't introduce a net-new regression (e.g. a flaky
test, a slop finding in test prose). Address anything it flags before pushing.

## Scope — what NOT to test

- Don't test auto-generated, vendored, or trivial pass-through code just to
  move the number — credit comes from covering the files that carry risk.
- Don't write tests you can't make pass; a `.skip` is a gap, not a closure.
- Don't assert on implementation details that will break on every refactor —
  test the contract, not the internals.

## Hand-offs

- Running / interpreting the health or test-gaps report → `dxkit-reports`.
- A test gap surfaced as one finding inside a broader fix pass → `dxkit-action`.
- Testing a feature you're building → `dxkit-feature` (it offers to hand the
  new surface here once the feature lands).
- Documentation gaps (the sibling generator skill) → `dxkit-docs`.
