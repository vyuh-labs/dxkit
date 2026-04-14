#!/bin/bash
# Slop checks — run in pre-commit hook on STAGED changes only.
#
# Blocks commits that introduce:
#   - Committed temp/backup files (.pyc, .swp, .bak, .orig, .tmp, .pyo)
#   - New console.log / console.error / console.warn in source
#   - New `: any` type annotations in TypeScript
#   - New `debugger;` statements
#
# Scope: only changes being committed, not the whole repo. Fast (<1s).
# Escape hatch: prefix a line with `// slop-ok` or `# slop-ok` to suppress
# the check on that line.

set -o pipefail

ERRORS=0

# ─── 1. Stale files staged for commit ───────────────────────────────────────
STALE_STAGED=$(git diff --cached --name-only --diff-filter=AM 2>/dev/null \
  | grep -E '\.(pyc|pyo|swp|swo|bak|orig|tmp)$|__pycache__/')
if [ -n "$STALE_STAGED" ]; then
  echo "❌ Slop check: staging temp/backup files:"
  echo "$STALE_STAGED" | sed 's/^/   /'
  echo "   → Add these patterns to .gitignore and unstage with \`git restore --staged\`."
  ERRORS=$((ERRORS + 1))
fi

# Collect staged source files we want to scan for added-line patterns.
STAGED_SOURCE=$(git diff --cached --name-only --diff-filter=AM 2>/dev/null \
  | grep -E '\.(ts|tsx|js|jsx|py|go)$' \
  | grep -vE '(^|/)(public/assets|static/js|public/static)/' \
  || true)

if [ -z "$STAGED_SOURCE" ]; then
  exit $ERRORS
fi

# Helper: grep added lines (prefixed with + but not ++, the file header) of
# staged source files for a pattern. Skips lines with `slop-ok` marker.
check_added() {
  local label="$1"
  local pattern="$2"
  local hint="$3"
  local hits
  # --unified=0 so context lines don't contaminate the grep.
  hits=$(git diff --cached --unified=0 -- $STAGED_SOURCE 2>/dev/null \
    | grep -E "^\+[^+]" \
    | grep -vE 'slop-ok' \
    | grep -E "$pattern" \
    || true)
  if [ -n "$hits" ]; then
    echo "❌ Slop check: new ${label} in staged changes:"
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
  "Use a logger or remove before committing. Suppress per-line with // slop-ok."

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
