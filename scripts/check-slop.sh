#!/bin/bash
# Slop checks — runs in pre-commit hook on STAGED changes, or in CI against
# the PR diff when DXKIT_SLOP_BASE is set.
#
# Blocks changes that introduce:
#   - Committed temp/backup files (.pyc, .swp, .bak, .orig, .tmp, .pyo)
#   - New console.log / console.error / console.warn in source
#   - New `: any` type annotations in TypeScript
#   - New `debugger;` statements
#
# Warns (advisory, never blocks) when:
#   - A changed source file exceeds the file-size budget (500 LoC) and is
#     not one of the modules that is large by architectural mandate
#     (language packs per Rule 6, queries.ts per Rule 12, tool-registry
#     per Rule 1, the CLI dispatch). Diff-scoped: you only hear about a
#     file when you are actually touching it, as a nudge to split it.
#
# Modes:
#   (default, pre-commit)  scans `git diff --cached`
#   (CI, PR job)           scans `git diff $DXKIT_SLOP_BASE...HEAD`
#                          — set DXKIT_SLOP_BASE=origin/main (or similar)
#
# Escape hatch: prefix a line with `// slop-ok` or `# slop-ok` to suppress
# the check on that line.

set -o pipefail

ERRORS=0

# Resolve diff source once; everything below uses $DIFF_BASE / $DIFF_MODE.
if [ -n "${DXKIT_SLOP_BASE:-}" ]; then
  DIFF_BASE="$DXKIT_SLOP_BASE"
  DIFF_MODE="range"
  FILE_LIST=$(git diff --name-only --diff-filter=AM "$DIFF_BASE"...HEAD 2>/dev/null)
else
  DIFF_BASE=""
  DIFF_MODE="cached"
  FILE_LIST=$(git diff --cached --name-only --diff-filter=AM 2>/dev/null)
fi

# ─── 1. Stale files being committed ────────────────────────────────────────
STALE=$(echo "$FILE_LIST" | grep -E '\.(pyc|pyo|swp|swo|bak|orig|tmp)$|__pycache__/' || true)
if [ -n "$STALE" ]; then
  echo "❌ Slop check: committing temp/backup files:"
  echo "$STALE" | sed 's/^/   /'
  echo "   → Add these patterns to .gitignore and remove from the change set."
  ERRORS=$((ERRORS + 1))
fi

# Collect source files we want to scan for added-line patterns.
SOURCE=$(echo "$FILE_LIST" \
  | grep -E '\.(ts|tsx|js|jsx|py|go)$' \
  | grep -vE '(^|/)(public/assets|static/js|public/static)/' \
  || true)

if [ -z "$SOURCE" ]; then
  exit $ERRORS
fi

# ─── File-size budget (advisory, warn-only) ────────────────────────────────
# Nudge when a changed file sprawls past the budget. Allowlisted modules are
# large by architectural mandate — splitting them would violate a CLAUDE.md
# rule (one file per language pack, one canonical query/registry module) — so
# they are exempt. Never increments ERRORS: this warns, it does not block.
SIZE_BUDGET=500
is_size_exempt() {
  case "$1" in
    src/languages/*.ts) return 0 ;;              # Rule 6 — one file per pack
    src/explore/queries.ts) return 0 ;;          # Rule 12 — canonical query module
    src/analyzers/tools/tool-registry.ts) return 0 ;; # Rule 1 — canonical registry
    src/cli.ts) return 0 ;;                       # CLI dispatch aggregator
    *) return 1 ;;
  esac
}
SIZE_WARNINGS=""
for f in $SOURCE; do
  [ -f "$f" ] || continue
  case "$f" in *.ts | *.tsx) ;; *) continue ;; esac
  is_size_exempt "$f" && continue
  loc=$(wc -l <"$f" 2>/dev/null | tr -d ' ')
  if [ -n "$loc" ] && [ "$loc" -gt "$SIZE_BUDGET" ]; then
    SIZE_WARNINGS="${SIZE_WARNINGS}   ${f} (${loc} LoC)\n"
  fi
done
if [ -n "$SIZE_WARNINGS" ]; then
  echo "⚠️  File-size budget (${SIZE_BUDGET} LoC) — consider splitting (advisory, not blocking):"
  printf "%b" "$SIZE_WARNINGS"
  echo "   → Extract cohesive units into new modules, or exempt in scripts/check-slop.sh"
  echo "     if the file is canonical single-source by a CLAUDE.md rule."
fi

# Helper: grep added lines (prefixed with + but not ++, the file header) for
# a pattern. Skips lines with `slop-ok` marker.
check_added() {
  local label="$1"
  local pattern="$2"
  local hint="$3"
  local diff hits
  if [ "$DIFF_MODE" = "range" ]; then
    diff=$(git diff --unified=0 "$DIFF_BASE"...HEAD -- $SOURCE 2>/dev/null)
  else
    diff=$(git diff --cached --unified=0 -- $SOURCE 2>/dev/null)
  fi
  # A slop rule targets CODE, and its escape hatch must be reliable. So before
  # matching the pattern, awk (per hunk, so adjacency never crosses files):
  #   - drops added COMMENT lines — a code-quality check must not fire on the
  #     English word in prose (`fail-open: any`, `--json via console.log`);
  #   - honors `// slop-ok` on the flagged line OR an adjacent added line in the
  #     same hunk — because prettier moves a trailing comment off a multi-line
  #     `console.log(` opening line, which otherwise made the escape hatch a
  #     silent trap.
  hits=$(printf '%s\n' "$diff" \
    | awk '
        /^@@/ || /^diff --git/ || /^--- / || /^\+\+\+ / { blk++; next }
        /^\+/ && !/^\+\+/ { n++; L[n] = $0; B[n] = blk }
        END {
          for (i = 1; i <= n; i++) {
            if (L[i] ~ /slop-ok/) continue
            if (i < n && B[i + 1] == B[i] && L[i + 1] ~ /slop-ok/) continue
            if (i > 1 && B[i - 1] == B[i] && L[i - 1] ~ /slop-ok/) continue
            s = L[i]; sub(/^\+/, "", s); sub(/^[ \t]+/, "", s)
            if (s ~ /^(\*|\/\/|\/\*)/) continue
            print L[i]
          }
        }' \
    | grep -E "$pattern" \
    || true)
  if [ -n "$hits" ]; then
    echo "❌ Slop check: new ${label} in ${DIFF_MODE} changes:"
    echo "$hits" | head -10 | sed 's/^/   /'
    local total
    total=$(echo "$hits" | wc -l)
    if [ "$total" -gt 10 ]; then
      echo "   … and $((total - 10)) more"
    fi
    echo "   → ${hint}"
    ERRORS=$((ERRORS + 1))
  fi
}

# ─── 2. console.{log,error,warn} in production code ────────────────────────
check_added \
  "console statement(s)" \
  'console\.(log|error|warn)' \
  "Use a logger or remove. Suppress per-line with // slop-ok."

# ─── 3. `: any` TypeScript escape hatches ──────────────────────────────────
check_added \
  ": any type annotation(s)" \
  ':\s*any(\b|$|[^a-zA-Z0-9_])' \
  "Narrow the type or use // slop-ok if truly unavoidable."

# ─── 4. debugger statements ────────────────────────────────────────────────
check_added \
  "debugger statement(s)" \
  '\bdebugger\s*;' \
  "Remove debugger; before committing."

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "Slop checks failed. Fix above, or use // slop-ok / # slop-ok on the line to suppress."
  exit 1
fi
