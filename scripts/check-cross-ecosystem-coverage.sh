#!/bin/bash
# Cross-ecosystem coverage parity gate (Phase 10i.0.5).
#
# Validates that every (report × language) cell in the matrix has BOTH:
#   1. Metadata in BENCHMARK_LANGUAGES (test/integration/cross-ecosystem.test.ts)
#   2. A `describe('matrix — <report>'` block iterating it
#
# Exists because the cross-ecosystem matrix is the load-bearing
# regression net for non-TypeScript packs (see 2.4.1's D005, 2.4.2's
# D016 — both real-repo defects caught only because the matrix added
# coverage). A new feature dimension shipping without per-language
# coverage silently shrinks the regression surface.
#
# Adding a new matrix dimension (e.g., `bom`):
#   1. Add `bom?: { ... }` to the BenchmarkLanguage interface
#   2. Add `bom: { ... }` to every BENCHMARK_LANGUAGES entry
#   3. Add `describe('matrix — bom (Phase X)') { ... }` to the file
#   4. Add the matrix → field mapping to MATRIX_DESCRIBES below
#
# Step 4 is the only meta-change; the rest is just feature work.

set -e

FILE="test/integration/cross-ecosystem.test.ts"
LANG_REGISTRY="src/languages/index.ts"

if [ ! -f "$FILE" ]; then
  echo "❌ $FILE not found (run from dxkit repo root)"
  exit 1
fi
if [ ! -f "$LANG_REGISTRY" ]; then
  echo "❌ $LANG_REGISTRY not found (run from dxkit repo root)"
  exit 1
fi

# Derive expected count from the LANGUAGES registry (Recipe v2 — Phase
# 10j.1). Pre-Recipe-v2 this was hardcoded and required a manual bump
# per new pack; now the parity gate auto-tracks the registry.
#
# The grep matches the single-line `LANGUAGES = [...]` form rendered by
# the scaffolder. Counts entries by counting commas + 1 in the array
# literal (last entry has no trailing comma in our convention but
# prettier sometimes adds one — both cases handled).
LANG_LINE=$(grep -E "^export const LANGUAGES" "$LANG_REGISTRY")
if [ -z "$LANG_LINE" ]; then
  echo "❌ Could not find 'export const LANGUAGES' in $LANG_REGISTRY"
  exit 1
fi
# Extract the bracketed array contents, count comma-separated entries.
LANG_BODY=$(echo "$LANG_LINE" | sed 's/.*\[\(.*\)\].*/\1/')
# Trim trailing comma if present, then count commas + 1.
LANG_BODY=$(echo "$LANG_BODY" | sed 's/,[[:space:]]*$//')
EXPECTED_LANGUAGES=$(echo "$LANG_BODY" | tr ',' '\n' | grep -c .)
if [ "$EXPECTED_LANGUAGES" -lt 1 ]; then
  echo "❌ Could not parse LANGUAGES count from $LANG_REGISTRY"
  exit 1
fi

# Extract BENCHMARK_LANGUAGES block. awk emits lines between the
# `const BENCHMARK_LANGUAGES` declaration and the closing `];`,
# inclusive — sufficient for the per-field counts below.
TABLE=$(awk '/^const BENCHMARK_LANGUAGES/,/^\];/' "$FILE")

if [ -z "$TABLE" ]; then
  echo "❌ Could not locate BENCHMARK_LANGUAGES array in $FILE"
  exit 1
fi

# Count language entries by counting top-level `name: '...'` inside
# the table block. Each entry is a single object literal with one
# `name:` field at the top.
LANG_COUNT=$(echo "$TABLE" | grep -cE "^\s+name: '")
if [ "$LANG_COUNT" -ne "$EXPECTED_LANGUAGES" ]; then
  echo "❌ Expected $EXPECTED_LANGUAGES BENCHMARK_LANGUAGES entries, found $LANG_COUNT"
  echo "   If you intentionally added/removed a language, update EXPECTED_LANGUAGES in this script."
  exit 1
fi

# Matrix describe → BENCHMARK_LANGUAGES field name. Update when
# adding a new matrix dimension (see header for the four steps).
declare -a MATRIX_DESCRIBES=(
  "matrix — secrets|secret"
  "matrix — lint|lint"
  "matrix — duplications|dup"
  "matrix — test-gaps|untested"
)

ERRORS=0

for entry in "${MATRIX_DESCRIBES[@]}"; do
  matrix_name="${entry%|*}"
  field="${entry#*|}"

  # 1. Matrix describe block must exist in the file.
  if ! grep -qF "describe('$matrix_name" "$FILE"; then
    echo "❌ Missing matrix describe block: $matrix_name"
    echo "   Add a 'describe(\"$matrix_name (Phase X)\", () => { ... })' block iterating BENCHMARK_LANGUAGES."
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # 2. Every BENCHMARK_LANGUAGES entry must declare the corresponding
  #    field. Match `^<indent>field: {` to scope to top-level fields
  #    inside table entries.
  FIELD_COUNT=$(echo "$TABLE" | grep -cE "^\s+${field}: \{")
  if [ "$FIELD_COUNT" -ne "$EXPECTED_LANGUAGES" ]; then
    echo "❌ Matrix '$matrix_name' has describe block, but only $FIELD_COUNT/$EXPECTED_LANGUAGES BENCHMARK_LANGUAGES entries declare a '$field:' field."
    echo "   Every language row needs a '$field: { ... }' field for this report dimension."
    ERRORS=$((ERRORS + 1))
  fi
done

# 3. Cell-count summary. Each matrix × language cell needs an
#    assertion. With $EXPECTED_LANGUAGES rows × N matrices, the
#    expected coverage is the product.
N_MATRICES=${#MATRIX_DESCRIBES[@]}
EXPECTED_CELLS=$((EXPECTED_LANGUAGES * N_MATRICES))

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "❌ Cross-ecosystem coverage parity check FAILED with $ERRORS error(s)."
  echo "   Every (report × language) cell needs BENCHMARK_LANGUAGES metadata + a matrix describe."
  echo "   Expected coverage: $EXPECTED_LANGUAGES languages × $N_MATRICES report dimensions = $EXPECTED_CELLS cells."
  exit 1
fi

echo "✅ Cross-ecosystem coverage parity OK ($EXPECTED_LANGUAGES languages × $N_MATRICES reports = $EXPECTED_CELLS cells)."
