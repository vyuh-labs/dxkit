# Scoring methodology

dxkit produces a 0-100 score and an A/B/C/D/E letter rating for six
dimensions of every codebase it analyzes. This document explains
exactly how those numbers are computed and where the underlying
methodology comes from.

dxkit's scoring is **deterministic** (same repo + same dxkit version
→ identical score, every time), **anchored** (cites underlying open
international standards rather than inventing thresholds), and
**actionable** (every score is paired with structured provenance so
the report says what to fix and how much the score would lift).

## At a glance

Every dimension shares the same numeric scale and letter mapping:

| Rating | Score band | Meaning                               |
| :----: | :--------: | ------------------------------------- |
| **A**  |    ≥ 80    | No known blockers; clear-to-ship      |
| **B**  |   60–79    | Solid; minor issues                   |
| **C**  |   40–59    | Notable issues; warrants attention    |
| **D**  |   20–39    | Significant debt; targeted fix needed |
| **E**  |    < 20    | Critical state; major work required   |

These thresholds match the conventions used across industry tooling
(SonarQube, Codacy, Lighthouse three-tier breakpoints all align with
the 60/80 + lower-band split). dxkit uses uniform thresholds across
every dimension so a "B" in Security means the same kind of thing as
a "B" in Maintainability.

## How a score is computed

Each dimension has a declarative **spec** (a list of penalty rules +
cap rules) consumed by a pure-function evaluator. Same input always
produces the same `ScoreResult`:

```
ScoreResult {
  score: 79,                    // 0-100
  rating: 'B',                  // letter
  rawScore: 85,                 // pre-cap, pre-clamp
  rawPenalty: -15,              // sum of deductions
  deductions: [ ... ],          // structured penalties that fired
  capsApplied: [ ... ],         // binding cap (if any)
  topActions: [ ... ],          // what to fix, sorted by uplift
}
```

The fields beyond `score`/`rating` are the **provenance** — they let
the report tell you exactly what depressed the score and what action
would lift it most. Per-dimension reports surface this as a "Top
actions" block; the cross-dimension overall surfaces it as a global
"highest-leverage fix" list.

## Caps — the Label Contract

Some conditions deserve to _bound_ a rating regardless of how clean
the rest of the dimension looks. dxkit's cap-tier taxonomy expresses
this with named tiers (not arbitrary numbers):

| Tier                  | Ceiling | When it fires                                                          | Effect                          |
| --------------------- | :-----: | ---------------------------------------------------------------------- | ------------------------------- |
| `trust-broken`        |   40    | Definite catastrophic failure (committed secrets, leaked private keys) | Rating bounded at **C**         |
| `unmeasured`          |   35    | No signal at all (e.g. coverage data entirely missing)                 | Rating bounded at **D**         |
| `uncertainty`         |   65    | A key measurement tool didn't run                                      | Rating bounded at **B**         |
| `partial-uncertainty` |   75    | Some signal-source tools didn't run                                    | Rating bounded just below **A** |
| `fixable-finding`     |   79    | Concrete bounded finding open (e.g. one open HIGH-severity code issue) | Rating bounded at **B**         |

Lower ceiling = more serious disclosure. When multiple caps apply
the most-aggressive one wins. Caps are the explicit form of
"`Excellent` should mean _no known blockers_" — penalty math alone
can leave a 95/100 score in place even when one open HIGH issue
contradicts the headline.

## Per-dimension methodology

### Security

**Model:** severity-dominant rating (ISO/IEC 5055-style penalty stack
with the Label Contract enforced through caps).

| Signal                                 | Penalty              |
| -------------------------------------- | -------------------- |
| Committed secrets (gitleaks)           | -15/-20/-25 by count |
| Private keys / certs on disk           | -20                  |
| `.env` files tracked in git            | -10                  |
| CRITICAL code findings (semgrep et al) | -15/-20/-25 by count |
| HIGH code findings                     | -5/-10 by count      |
| MEDIUM > 10                            | -5                   |
| CRITICAL dependency vulnerabilities    | -15                  |
| HIGH dependency vulnerabilities        | -5/-10 by count      |

**Caps:** committed credentials trigger `trust-broken` (40); a
dep-vuln, secret, OR code-pattern scanner that didn't run triggers
`uncertainty` (65) — every measurement axis is treated the same, so a
missing scanner never reads as a confident "0 findings"; any open
HIGH+ code finding triggers `fixable-finding` (79).

**Allowlist and the score.** Penalties and caps count only findings that
are still _open_. A finding allowlisted as `false-positive` or
`test-fixture` is declared "not a real finding" and is lifted from the
Security penalties and caps (not just the guardrail), so a repo that has
genuinely triaged its noise scores honestly rather than staying capped on
findings it has already reviewed and accepted. `accepted-risk`,
`deferred`, and `mitigated-externally` accept a _real_ exposure — the
guardrail stops blocking, but the score keeps counting them, so accepting
a real risk can't earn an A. Secret findings are never down-ranked by
file path: a credential in a test keeps full severity until a human
allowlists it as `test-fixture`.

Severity bands follow **CVSS v4.0** (FIRST.org). Weakness taxonomy
follows **CWE** (MITRE). Category framing follows
**OWASP Top 10** + **ASVS**.

### Code Quality

**Model:** maintainability sub-characteristics from ISO/IEC 25010
with density-based penalties for code smells.

| Signal                            | Penalty                         |
| --------------------------------- | ------------------------------- |
| Lint errors                       | density × 100, capped at -40    |
| Files over 500 lines              | -10 if > 5, -20 if > 20         |
| Largest file size                 | -10 if > 5K lines, -20 if > 10K |
| Console density                   | -5/-10/-15 tiered               |
| `any` type density (TS)           | -5/-10/-15 tiered               |
| Type errors (density)             | -50 density, capped at -15      |
| Max functions per file > 50       | -10                             |
| Dead imports > 20                 | -10                             |
| Orphan modules > 30               | -5                              |
| Duplication > 5% / > 15%          | -10 / -20                       |
| Comment ratio > 0.4 / > 0.5       | -10 / -15                       |
| TODO+FIXME+HACK total > 20 / > 50 | -5 / -10                        |
| Stale files in git                | -2 / -5                         |
| Mixed JS/TS                       | -5                              |

**Caps:** when all 3 signal-source tools (lint / duplication /
structural) are unmeasured, `unmeasured` (35) binds. When one or two
are unmeasured, `partial-uncertainty` (75) binds.

### Tests

**Model:** additive checklist over test-discipline signals; coverage
thresholds from industry consensus.

| Signal                         | Contribution                         |
| ------------------------------ | ------------------------------------ |
| Test ratio                     | + (test/source × 200), capped at +60 |
| Coverage config present        | +10                                  |
| Test runner reports green      | +15                                  |
| Line coverage ≥ 60%            | +10                                  |
| Line coverage ≥ 80%            | +5                                   |
| Commented-out code ratio > 0.5 | -15                                  |

**Caps:** coverage data entirely absent triggers `unmeasured` (35).

Coverage thresholds (60% / 80%) are industry convention from
**SonarQube** quality-gate defaults, **CodeClimate**, and the Google
Testing on the Toilet recommendations.

### Documentation

**Model:** subtractive checklist over documentation artifacts.

| Signal                     | Penalty                        |
| -------------------------- | ------------------------------ |
| README missing or too thin | -5 to -25 tiered by line count |
| Doc-comment file density   | -10 / -20 / -25 tiered         |
| API docs missing           | -20                            |
| Architecture docs missing  | -15                            |
| `CONTRIBUTING.md` missing  | -10                            |
| `CHANGELOG.md` missing     | -5                             |

**Caps:** none. The penalty distribution enforces the rating
contract by construction.

### Maintainability

**Model:** ISO/IEC 25010 maintainability sub-characteristics
combined with the **SQALE method** (Letouzey 2012) for the
technical-debt-produces-downgraded-rating mental model. Step-style
penalty thresholds calibrated so a single major violation drops the
rating one tier.

| Signal                                   | Penalty                 |
| ---------------------------------------- | ----------------------- |
| Largest file (1K / 2K / 5K / 10K+ lines) | -5 / -10 / -15 / -25    |
| Files over 500 lines (count)             | -5 / -10 / -15 by count |
| Console statements > 100 / > 500         | -5 / -10                |
| Outdated Node engine (< 18 / < 16)       | -5 / -10                |
| God-node density > 5% / > 10%            | -5 / -10                |
| Avg cohesion < 0.15                      | -5                      |

**Caps:** none.

### Developer Experience

**Model:** subtractive checklist over operational-readiness signals.
Shape mirrors **OpenSSF Scorecard**'s weighted-checks model.

| Signal                                       | Penalty        |
| -------------------------------------------- | -------------- |
| No CI workflow                               | -20            |
| No Docker / compose                          | -15            |
| No pre-commit hooks                          | -10            |
| No Makefile                                  | -10            |
| No `.env.example`                            | -10            |
| Automation scripts shortfall (< 8 / < 4 / 0) | -5 / -10 / -15 |
| `CONTRIBUTING.md` missing                    | -10            |
| README too thin (≤ 50 lines)                 | -5             |
| `CHANGELOG.md` missing                       | -5             |

**Caps:** none.

## Overall score

The overall 0-100 number is a weighted average across the six
dimensions:

| Dimension            | Weight |
| -------------------- | :----: |
| Tests                |  25%   |
| Code Quality         |  20%   |
| Security             |  20%   |
| Developer Experience |  15%   |
| Documentation        |  10%   |
| Maintainability      |  10%   |

The overall **rating** is derived from the overall score using the
same A/B/C/D/E thresholds as each dimension. The dashboard's
"highest-leverage fix" callout ranks every dimension's top action
by its weighted contribution to the overall number, so the customer
sees the single move that lifts the overall most regardless of
which dimension it lives in.

## Determinism

dxkit's scoring is a pure function of repo state + tool versions.
Same `git rev-parse HEAD` + same dxkit version + same tool versions
→ identical score across runs and machines. This is the central
property that distinguishes dxkit from LLM-driven review products:
re-run a hundred times, get the same number a hundred times.

The same property means scores work as **agent targets**. A coding
agent given "improve Security to A" can read the structured
`topActions[]`, attempt a fix, re-run dxkit, and verify the
predicted uplift materialized — a closed loop that LLM-based
scoring cannot support.

## Citations

dxkit's methodology cites underlying open standards directly rather
than commercial implementations:

- **ISO/IEC 25010** — Software quality model (dimension taxonomy)
- **ISO/IEC 5055** — Automated source code quality measures (CISQ-driven)
- **SQALE method** (Letouzey 2012) — Technical debt ratio methodology
- **CVSS v4.0** (FIRST.org) — Vulnerability severity scoring
- **CWE** (MITRE) — Software weakness taxonomy
- **OWASP Top 10 / ASVS** — Application security risk framework
- **OpenSSF Scorecard** — Open-source supply-chain check methodology

These standards are implemented by SonarQube, Codacy, Veracode,
OpenSSF, Lighthouse, and other industry tools. dxkit implements
them independently; we do not copy their code, documentation, or
trademarks.

Developer-facing details (cap-tier values, threshold exact numbers,
penalty values per signal) live in
[`src/scoring/STANDARDS.md`](../src/scoring/STANDARDS.md) alongside
the code that consumes them.

## Reproducing a score

To verify any reported score, look at:

1. The report's per-dimension `deductions[]` list — every penalty
   that fired with its reason and delta
2. The report's per-dimension `capsApplied[]` — the binding cap
   (if any) and its rationale
3. The methodology citation on each dimension page

If two dxkit runs disagree on a score, the disagreement traces to
**input differences** (one ran with a tool the other didn't have;
one parsed a different version of the source) — never to scoring
nondeterminism. Open an issue with both `analyzedAt` SHAs and the
diff between reports if you encounter divergent scores on identical
input.
