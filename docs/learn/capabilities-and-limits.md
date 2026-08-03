# What dxkit verifies, and what it cannot

Transparency is a feature. This page states dxkit's claims precisely, in
both directions, so you can decide what to rely on it for.

## What dxkit verifies

- **Net-new regressions in a change.** The guardrail diffs the current scan
  against a baseline using durable per-finding identities. When it says
  BLOCKED, the listed findings are attributable to the change; when it
  cannot attribute honestly, it says CANNOT GATE instead of guessing.
- **Deterministic, reproducible verdicts.** The same tree, baseline, and
  policy produce the same verdict on every machine. No agent judgment is
  involved in gating.
- **Liveness of the change** (the correctness floor): the code still
  compiles or parses, imports still resolve, and the tests the change
  affects still pass. Only failures that are net-new versus the entry state
  block.
- **What actually ran.** Every scan records which tools executed. A scanner
  that could not run is disclosed as unobserved; it never silently reads as
  "clean".
- **That its own lanes obey the gate.** Anything a scheduled lane or a
  remediation agent produces lands only through a PR that passes the same
  guardrail as a human change.

## What dxkit does not verify

- **That your code is correct or well-designed.** The gate proves "no new
  findings" and "still alive", not "good". Review still matters.
- **Deep interprocedural taint flows.** The bundled static analysis is
  intraprocedural. Path-traversal, SSRF, and injection classes that span
  functions are covered only when an external engine (CodeQL, Snyk Code,
  Semgrep Pro) is connected; dxkit ingests those findings, it does not
  re-detect them.
- **Findings in what it cannot see.** A language without a dxkit pack, a
  scanner that is not installed, or an environment a capability cannot run
  in all produce disclosed gaps, not silent coverage.
- **The outcome of a custom remediation prompt.** A dispatch campaign with
  a custom prompt carries no automated score hinge: dxkit verifies the
  result compiles, passes affected tests, and introduces no net-new
  findings, and it says exactly that in the PR. Whether the change achieves
  the prompt's intent is human review's call.
- **The honesty of allowlist entries.** A false-positive category or a
  deferral reason is a human statement, on the record and auditable, but
  dxkit does not second-guess it.
- **UI or screen testing.** dxkit does not drive browsers or screens and
  does not generate end-to-end UI tests. Its testing surface is test-gap
  analysis, affected-test selection, and the `improve-tests` remediation
  task, which writes tests in the repo's own test framework.
- **API collection generation.** dxkit maps UI-to-API integration (the
  flow gate) and inventories served routes, but it does not generate or
  maintain request-collection suites for external API tools. The route
  inventory (`flow` / `describe`) is a sound input if you build those
  elsewhere.
- **Code migration.** Framework or platform migrations are not a dxkit
  capability. A custom remediation campaign can attempt scoped migration
  work, but it carries no score hinge: verification is compile + affected
  tests + the guardrail + your review, and the PR says so.

## Standing limits worth knowing

- The gate is only as current as the baseline. A stale baseline degrades to
  CANNOT GATE rather than misattributing, and the refresh lane exists to
  keep it current.
- Custom repo checks (lint gates, user commands) run only in committed
  baseline modes; in ref-based mode they are excluded by design, because a
  throwaway worktree lacks the toolchain and would false-flag.
- A tool upgrade can change what scanners report. dxkit detects this
  (recall tracking) and downgrades those deltas to disclosed warnings; it
  never blames them on the next PR author.
- Lane PRs pushed with the default CI credential arrive without checks
  (a GitHub rule); configuring a bot token fixes this, and doctor tells you
  when it applies.
