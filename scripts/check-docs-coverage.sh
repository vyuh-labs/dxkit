#!/bin/bash
# Documentation coverage parity gate (Recipe v3 / G5 — landed 10k.1.0.1).
#
# Prevents the "kotlin PR #23 follow-up" failure mode: a language pack
# ships in main but README/CLAUDE docs go stale because nobody remembered
# to update them. Same shape as `check-cross-ecosystem-coverage.sh` —
# fail loudly when canonical doc anchors don't match the registry.
#
# Asserts every LanguageId in `src/languages/index.ts` appears in:
#
#   1. CLAUDE.md `{python,typescript,...,kotlin}` path glob — used in
#      file-pattern docs ("one file per language under `src/languages/
#      {python,...}.ts`"). Strict: every ID must be present.
#
#   2. README.md ecosystem coverage table — the "| Language | Detection
#      | Coverage import | ..." table is the load-bearing per-language
#      capability claim surface. Counts data rows; must equal
#      LANGUAGES.length.
#
#   3. README.md at least one substring mention of every LanguageId —
#      lenient catch-all for the case where docs are restructured but
#      a language is silently dropped.
#
# Robust to Prettier multi-lining (Recipe v3 / G1) — uses awk block
# extraction matching the fix landed in `bfab5a5`.

set -e

LANG_REGISTRY="src/languages/index.ts"
README="README.md"
CLAUDE="CLAUDE.md"

if [ ! -f "$LANG_REGISTRY" ]; then
  echo "❌ $LANG_REGISTRY not found (run from dxkit repo root)"
  exit 1
fi
for f in "$README" "$CLAUDE"; do
  if [ ! -f "$f" ]; then
    echo "❌ $f not found"
    exit 1
  fi
done

# Extract LanguageId list from the LANGUAGES registry. Same shape as
# check-cross-ecosystem-coverage.sh — multi-line robust.
LANG_BLOCK=$(awk '/^export const LANGUAGES/,/^\];/' "$LANG_REGISTRY" | tr -d '\n')
LANG_BODY=$(echo "$LANG_BLOCK" | sed 's/.*\[\(.*\)\].*/\1/' | sed 's/,[[:space:]]*$//')
LANG_IDS=$(echo "$LANG_BODY" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$')

if [ -z "$LANG_IDS" ]; then
  echo "❌ Could not extract LanguageId list from $LANG_REGISTRY"
  exit 1
fi

EXPECTED=$(echo "$LANG_IDS" | wc -l | tr -d ' ')
ERRORS=0

# ─── Anchor 1: CLAUDE.md `{python,...,kotlin}` path globs ───────────────
# Every ID must appear inside at least one curly-brace glob. Multiple
# globs in CLAUDE.md is fine — only one needs to mention each ID.
for lang in $LANG_IDS; do
  if ! grep -qE "\{[^}]*\b${lang}\b[^}]*\}" "$CLAUDE"; then
    echo "❌ CLAUDE.md: missing '${lang}' in {python,typescript,...,kotlin} path glob"
    echo "   Update the file-path examples in CLAUDE.md to include this language."
    ERRORS=$((ERRORS + 1))
  fi
done

# ─── Anchor 2: README.md ecosystem coverage table row count ─────────────
# The table is anchored on the `| Language | Detection ... |` header
# row. Count contiguous data rows after the `| -- | ... |` separator.
TABLE_DATA_ROWS=$(awk '
  done                                       { next }
  /^\| Language \| Detection/                { found_header=1; next }
  found_header && /^\| -+/                   { in_table=1; next }
  in_table && /^\| /                         { count++; next }
  in_table && !/^\| /                        { done=1 }
  END                                        { print count + 0 }
' "$README")

if [ "$TABLE_DATA_ROWS" -ne "$EXPECTED" ]; then
  echo "❌ README.md ecosystem coverage table has $TABLE_DATA_ROWS data rows, expected $EXPECTED"
  echo "   Find the '| Language | Detection | Coverage import | ...' table in README.md"
  echo "   and add/remove rows so the data-row count matches LANGUAGES.length."
  ERRORS=$((ERRORS + 1))
fi

# ─── Anchor 3: README.md substring mention of every LanguageId ──────────
# Catch-all for restructure-and-forget. Case-insensitive whole-word match
# (handles 'Java' matching 'java', 'C#' matching 'csharp' is harder so
# we look for 'csharp' itself or 'C#' literally).
for lang in $LANG_IDS; do
  # 'csharp' is the ID but README uses 'C#' — accept either.
  if [ "$lang" = "csharp" ]; then
    if ! grep -qE 'csharp|C#' "$README"; then
      echo "❌ README.md: 'csharp'/'C#' not referenced anywhere"
      ERRORS=$((ERRORS + 1))
    fi
    continue
  fi
  # 'typescript' is the ID but README often uses 'TS / JS' — accept either.
  if [ "$lang" = "typescript" ]; then
    if ! grep -iqE 'typescript|\bTS\b' "$README"; then
      echo "❌ README.md: 'typescript'/'TS' not referenced anywhere"
      ERRORS=$((ERRORS + 1))
    fi
    continue
  fi
  if ! grep -iqw "${lang}" "$README"; then
    echo "❌ README.md: '${lang}' (LanguageId) is not referenced anywhere"
    ERRORS=$((ERRORS + 1))
  fi
done

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "❌ Doc coverage parity FAILED with $ERRORS error(s)."
  echo "   Recipe v3 / G5 — every LanguageId must appear in canonical doc anchors."
  echo "   Update README.md + CLAUDE.md so docs match the registry, or this commit"
  echo "   will surface as 'kotlin PR #23 follow-up' style stale-doc drift."
  exit 1
fi

echo "✅ Doc coverage parity OK ($EXPECTED languages × 3 anchors)."
