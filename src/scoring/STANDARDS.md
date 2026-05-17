# Scoring methodology — sources and citations

This document is co-located with the scoring code it grounds. Every
threshold, every cap tier, every per-dimension methodology choice
traces back through one of three layers of references.

The customer-facing version of this material lives in `docs/SCORING.md`
(written for end-users). This file is the developer reference: it lives
next to the code, includes implementation-relevant details, and is the
authority cited by JSDoc in `spec.ts`, `evaluator.ts`, and each
per-dimension spec module.

## Layer 1 — Underlying open standards (primary authority)

These are the international standards and open methodologies dxkit
implements directly. Each is publicly available; none has IP
restrictions on methodology re-implementation.

### ISO/IEC 25010 — Software quality model

Defines the canonical software quality characteristics: Reliability,
Performance Efficiency, Security, Maintainability, Compatibility,
Usability, Portability. dxkit's six dimensions (Security, Code
Quality, Tests, Maintainability, Documentation, Developer Experience)
align with this taxonomy: Security and Maintainability are direct
ISO 25010 characteristics; Code Quality bundles Reliability with
maintainability sub-characteristics; the rest are dxkit-specific
extensions for developer-facing repositories.

- Published by: ISO/IEC
- Status: International standard
- Reference: <https://www.iso.org/standard/35733.html>

### ISO/IEC 5055 — Automated source code quality measures

Specifies measurable signals (counts, ratios) for the ISO 25010
quality characteristics. Driven by CISQ (Consortium for IT Software
Quality). Provides the "severity-dominant rating" pattern used by
dxkit's Security dimension (and SonarQube's Reliability/Security
ratings, and others) — the rating is determined by the worst single
issue, not a count average.

- Published by: ISO/IEC via CISQ
- Status: International standard (executive summary public; full
  text paywalled)
- CISQ public material: <https://www.it-cisq.org/standards/code-quality-standards/>

### SQALE method (Letouzey 2012)

Software Quality Assessment based on Lifecycle Expectations. An open
methodology for computing technical debt as a remediation-effort
ratio: `debt_time / dev_time → debt_ratio`. Used by dxkit's
Maintainability dimension. Each violation contributes a
remediation-time estimate; dev time is approximated from source-file
size with a per-language baseline.

- Published by: Jean-Louis Letouzey, Inspearit
- Status: Open methodology, freely available
- Reference: <https://www.sqale.org/>

### CVSS v4.0 — Common Vulnerability Scoring System

FIRST.org's open specification for vulnerability severity scoring.
dxkit's Security dimension uses CVSS bands (Critical 9.0+, High
7.0-8.9, Medium 4.0-6.9, Low 0.1-3.9) for finding severity. The
calculator implementation ports the FIRST reference (see
`src/analyzers/tools/cvss-v4.ts`).

- Published by: FIRST.org
- Status: Open specification, royalty-free
- Reference: <https://www.first.org/cvss/v4-0/specification-document>

### CWE — Common Weakness Enumeration

MITRE's open taxonomy of software weaknesses. Used by dxkit for
cross-tool finding categorization (semgrep, gitleaks, language-specific
SAST tools all map to CWE).

- Published by: MITRE
- Status: Open, government-supported
- Reference: <https://cwe.mitre.org/>

### OWASP Top 10 / ASVS

Open application-security frameworks. Used by dxkit's Security
dimension for finding categorization and recommendation framing.

- Published by: OWASP
- Status: Creative Commons (open)
- Reference: <https://owasp.org/Top10/> and <https://owasp.org/www-project-application-security-verification-standard/>

## Layer 2 — Reference implementations (factual, for customer familiarity)

These commercial and open-source tools implement the same underlying
standards as dxkit. Customers familiar with them can expect dxkit's
ratings to be conceptually comparable — though specific threshold
values may differ since each tool's defaults are independent choices.

- **SonarQube** — Severity-dominant Reliability/Security ratings (per
  ISO/IEC 5055); SQALE-based Maintainability rating. Closest analog
  to dxkit's overall scoring shape.
- **Codacy** — A-F grades per file and project; CISQ-aligned.
- **Veracode** — CVSS-based severity bands; OWASP-aligned categories.
- **Lighthouse** — Percentile-based 0-100 scoring with tier breakpoints
  (red/orange/green). Future dxkit work (Phase 10rr corpus +
  percentile rating) follows this pattern.
- **OpenSSF Scorecard** — Open-source supply-chain security; weighted
  check-based scoring with public methodology. Inspiration for
  dxkit's Developer Experience and Security dimensions.

dxkit does not copy any of these tools' code or documentation. Their
methodology choices that match dxkit's are independent
implementations of shared open standards (Layer 1), not copies of
each other's expression.

## Layer 3 — dxkit-specific choices (transparency)

Where Layer 1 standards specify methodology but not specific numeric
thresholds, dxkit makes explicit choices documented here. These are
calibrated to match industry convention (the values commonly used by
SonarQube and Codacy default configurations) but are dxkit's own —
no claim is made that they are dictated by the upstream standards.

### Rating thresholds (uniform across dimensions)

```
A: score ≥ 80
B: score ≥ 60 and < 80
C: score ≥ 40 and < 60
D: score ≥ 20 and < 40
E: score < 20
```

Defined in `thresholds.ts:RATING_THRESHOLDS`. Boundaries chosen to
span 20 points per band (academic-grading shape) with the A boundary
at 80 (industry convention for "no blockers").

### Cap tier ceilings

Each cap fires when its named condition holds; the score is bounded
at the tier's ceiling. Ceiling values derive from the rating
thresholds:

```
trust-broken         40   (top of C)
unmeasured           35   (below C boundary)
uncertainty          65   (middle of B)
partial-uncertainty  75   (top of B)
fixable-finding      79   (just below A)
```

Defined in `thresholds.ts:CAP_TIERS`. Tier names express the meaning
of the cap (catastrophic, no-signal, key-source-missing, partial-
measurement, concrete-finding); the numeric ceilings line up with
rating boundaries so the cap reads naturally as "this disclosure
bounds your rating at the next tier."

### Numeric scoring approach per dimension

The methodology choice per dimension determines HOW the numeric score
is computed from inputs. The score-to-rating mapping is always
uniform (above).

| Dimension            | Methodology                                  | Layer 1 source                                  |
| -------------------- | -------------------------------------------- | ----------------------------------------------- |
| Security             | Severity-dominant penalty + caps             | ISO/IEC 5055 + CVSS v4 + CWE                    |
| Code Quality         | Density-based penalties + caps               | ISO 25010 (maintainability sub-characteristics) |
| Tests                | Coverage-anchored + test-ratio penalties     | Industry consensus (coverage 80%+ excellent)    |
| Maintainability      | SQALE debt-ratio inversion                   | SQALE method                                    |
| Documentation        | Checklist-additive                           | dxkit-specific (Layer 1 silent)                 |
| Developer Experience | Checklist-additive (OpenSSF Scorecard shape) | OpenSSF Scorecard methodology                   |

Each per-dimension spec file (`dimensions/<name>.ts`) carries a
JSDoc citation back to its Layer 1 source(s) and any Layer 3 choices
specific to that dimension.

## Implementation rules

1. **No hardcoded thresholds outside `thresholds.ts`.** Every rating
   threshold and cap ceiling is a single named constant. Architectural
   gate enforces this; see CLAUDE.md.
2. **No score arithmetic outside `dimensions/*.ts`.** Every dimension's
   penalties and caps are declared as spec rules consumed by
   `evaluator.ts`. Architectural gate enforces this.
3. **Every spec cites its methodology.** The `methodology` field in
   `DimensionScoringSpec` must reference an entry in this file
   (Layer 1 or Layer 3). The renderer surfaces this so customers can
   trace every score to its source.
4. **No IP risk.** dxkit cites underlying open standards directly,
   not the commercial tools (Layer 2) that also implement them. We
   do not copy SonarQube/Codacy code, documentation, or trademark
   imagery.
