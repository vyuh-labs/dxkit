# Migrating to 2.4.7 scoring schema

dxkit 2.4.7 introduces actionable scoring. The 0-100 numeric scores
remain on the same scale, but the JSON report shape gains structured
provenance fields and one cross-cutting field rename. This document
covers everything a downstream consumer (a script, an agent, an
external dashboard) needs to update.

If you only consume the markdown output, nothing breaks — markdown
gained Top Actions blocks but stayed otherwise compatible.

## TL;DR

- `health-audit-<date>.json` — `summary.grade` → `summary.rating`,
  letter `F` becomes `E`. Each `dimensions.<key>` gains optional
  fields `rawScore`, `rawPenalty`, `methodology`, `deductions`,
  `capsApplied`, `topActions`.
- `health-audit-<date>-detailed.json` — same as above + the existing
  `schemaVersion` field bumps `'11'` → `'12'`. The `projectedGrade`
  field is unchanged in name but its enum updates `F` → `E`.
- Other report JSONs (`vulnerability-scan`, `quality-review`,
  `test-gaps`, `dev-report`, `licenses`, `bom`) are shape-unchanged.
  Their numeric scores may shift slightly (Security and Maintainability
  carry documented behavior changes — see below).

## Field-by-field

### `HealthReport.summary`

```diff
 summary: {
   overallScore: number;
-  grade: 'A' | 'B' | 'C' | 'D' | 'F';
+  rating: 'A' | 'B' | 'C' | 'D' | 'E';
 }
```

Two changes:

1. **Field rename**: `grade` → `rating`. Same semantic; new name aligns
   with each dimension's `rating` field so the cross-surface vocabulary
   is one concept (a letter).
2. **Enum value**: failing repos now read as `E` instead of `F`. Five
   letters consistent across dimensions + overall — same as SonarQube
   and Codacy.

**Migration:**

```diff
- const grade = report.summary.grade;
- if (grade === 'F') { /* failing */ }
+ const rating = report.summary.rating;
+ if (rating === 'E') { /* failing */ }
```

### `DimensionScore` (per dimension under `report.dimensions.*`)

Existing fields are unchanged (`score`, `maxScore`, `rating`,
`metrics`, `details`). New optional fields:

```typescript
interface DimensionScore {
  score: number; // unchanged
  maxScore: number; // unchanged
  rating: 'A' | 'B' | 'C' | 'D' | 'E'; // unchanged
  metrics: Record<string, ...>; // unchanged
  details: string; // unchanged

  // ── new in 2.4.7 ──────────────────────────────────────────────
  /** Pre-cap, pre-clamp score. Can be negative on severely-troubled
   *  repos; the actionability surface uses this to distinguish
   *  "0/100 (barely bad)" from "0/100 (catastrophic)". */
  rawScore?: number;
  /** Sum of all penalty deltas applied. Equals
   *  `rawScore - baseline` for subtractive specs. */
  rawPenalty?: number;
  /** Citation key referencing src/scoring/STANDARDS.md. Surfaces
   *  the methodology source for the score. */
  methodology?: string;
  /** Every penalty that fired, with reason + delta + uplift-if-fixed. */
  deductions?: ReadonlyArray<{
    id: string;
    reason: string;
    delta: number;
    upliftIfFixed: number;
  }>;
  /** The binding cap, if one fired. Zero or one entry. */
  capsApplied?: ReadonlyArray<{
    id: string;
    tier: 'trust-broken' | 'unmeasured' | 'uncertainty' | 'partial-uncertainty' | 'fixable-finding';
    ceiling: number;
    reason: string;
    upliftIfRemoved: number;
  }>;
  /** Top actions sorted by uplift. Union of deductions + caps. */
  topActions?: ReadonlyArray<{
    source: 'deduction' | 'cap';
    id: string;
    reason: string;
    upliftIfFixed: number;
    ratingTransition?: { from: 'A'|'B'|'C'|'D'|'E'; to: 'A'|'B'|'C'|'D'|'E' };
  }>;
}
```

All six fields are **optional** so a 2.4.6-era consumer reading 2.4.7
JSON continues to work — it just won't have access to the new
provenance. Consumers that want the actionable signals check for
field presence:

```typescript
if (dim.topActions && dim.topActions.length > 0) {
  const top = dim.topActions[0];
  console.log(`Fix: ${top.reason} for +${top.upliftIfFixed}`);
}
```

### `HealthDetailedReport`

`schemaVersion: '11'` → `'12'`. `projectedGrade` retains the same
field name but the enum now uses `E` instead of `F` for failing
projected scores.

The schemaVersion bump is the right gate for downstream consumers
that key off it.

### Other report types (unchanged shape)

- `vulnerability-scan-<date>-detailed.json` — `schemaVersion` stays
  at `'13'`. The `securityScore` field is now derived from the
  declarative Security spec; numeric values may shift on repos with
  open HIGH+ code findings (those repos now cap at 79 — see
  Behavior changes below).
- `quality-review-<date>-detailed.json` — `schemaVersion` stays at
  `'11'`. `slopScore` numerics preserved by construction (the
  declarative spec produces the same numbers as the pre-2.4.7 formula
  for unchanged inputs).
- `test-gaps`, `dev-report`, `licenses`, `bom` — all shape-unchanged.

## Behavior changes (score numerics may shift)

These are intentional changes anchored to industry methodology.
Customer-facing markdown calls them out where they apply.

### Security

Repos with at least one open HIGH or CRITICAL semgrep code finding
now cap at score 79 (rating B) regardless of how clean the rest of
the dimension is. Pre-2.4.7 a single HIGH finding left the score at
95 — reading as "Excellent" while a concrete file-and-line-specific
HIGH was unfixed. This was a customer-credibility issue.

Repos with zero open HIGH+ code findings are unaffected.

### Maintainability — SQALE baseline shift

The Maintainability scoring formula migrated to ISO/IEC 25010 +
SQALE-inspired step thresholds. Two practical changes:

- Baseline moves from 70 to 100 (matches every other subtractive
  dimension). Clean repos will see Maintainability scores rise
  ~30 points.
- The legacy "small-codebase bonus" (sourceFiles < 50 → +10; < 20 →
  +5) is removed as an overfit.

Penalty values are unchanged. Differences come from the new baseline.

### Testing — cap-then-penalty ordering

Repos with high `commentedCodeRatio` (> 0.5) AND missing coverage
data now produce a final score of 35 (the `unmeasured` cap) instead
of 20 (pre-cap penalty then sub-cap subtraction). The new ordering
is cleaner — a cap is a ceiling, not a floor-then-further-subtract
— and the change only affects this narrow edge case.

### Documentation, Developer Experience — spec inversion (no behavior change)

Both dimensions migrated from additive (baseline 0, bonuses for
present artifacts) to subtractive (baseline 100, deductions for
missing artifacts). **Numeric scores are preserved by construction**
— max-possible additive total equals baseline of subtractive form
with the same per-rule values. The only customer-facing change is
the `deductions[]` provenance now reads as "missing items to add"
rather than "bonuses earned."

## How to validate the upgrade

```bash
# Re-run dxkit on a repo you analyzed pre-2.4.7
vyuh-dxkit health <repo>
vyuh-dxkit dashboard

# Diff the .dxkit/reports/health-audit-*.json file's `summary` block:
# - summary.grade should be gone; summary.rating should be present
# - dimensions.<key>.deductions should be populated for migrated dims
# - dimensions.<key>.topActions should rank the highest-uplift fixes

# The dashboard tile + CLI grid will display the "→ Top action: <X>"
# continuation line per dimension for dimensions with non-empty
# topActions.
```

## Versioning

dxkit follows semver for the npm package. The 2.4.7 release adds
optional JSON fields and renames one field (`grade` → `rating`).
Consumers that read only the `score` numbers see no breaking change.
Consumers that read the `grade` field need the one-character rename
and the enum value adjustment.

If you maintain a downstream tool that scripts against dxkit's JSON
output and the migration breaks your code, open an issue with the
specific consumer code so we can document additional migration
recipes in this file.
