#!/bin/bash
# Architecture checks — run in pre-commit hook.
# Catches common violations of CLAUDE.md rules.

ERRORS=0

# Rule 2: No duplicated tool invocation.
# The graphify Python script should only exist in tools/graphify.ts.
# If it appears elsewhere, someone copy-pasted instead of importing.
GRAPHIFY_DUPS=$(grep -rl "from graphify.extract import\|from graphify.build import" src/ 2>/dev/null | grep -v "tools/graphify.ts" | grep -v "tools/parallel.ts")
if [ -n "$GRAPHIFY_DUPS" ]; then
  echo "❌ Architecture violation: graphify invocation duplicated outside tools/graphify.ts:"
  echo "$GRAPHIFY_DUPS"
  echo "   → Import from tools/graphify.ts instead of duplicating the Python script."
  ERRORS=$((ERRORS + 1))
fi

# Rule 1: No hardcoded tool binary paths in analyzer or language-pack code.
# Tool paths should come from findTool(TOOL_DEFS.xxx), not hardcoded strings.
HARDCODED_BINS=$(grep -rnE "(execSync|run)\(.*'(gitleaks|semgrep|cloc|jscpd|ruff|pip-audit|golangci-lint|govulncheck|clippy|cargo.audit)" src/analyzers/ src/languages/ 2>/dev/null | grep -v "tool-registry.ts" | grep -v "parallel.ts" | grep -v "// hardcoded-ok")
if [ -n "$HARDCODED_BINS" ]; then
  echo "❌ Architecture violation: hardcoded tool binary in analyzer code:"
  echo "$HARDCODED_BINS"
  echo "   → Use findTool(TOOL_DEFS.xxx) from tool-registry.ts instead."
  ERRORS=$((ERRORS + 1))
fi

# Rule 4: No hardcoded exclusion lists.
# Exclusions should come from exclusions.ts.
HARDCODED_EXCLUDES=$(grep -rnE "node_modules.*dist.*vendor.*build" src/analyzers/ 2>/dev/null | grep -v "exclusions.ts" | grep -v "// exclusions-ok" | grep -v ".d.ts")
if [ -n "$HARDCODED_EXCLUDES" ]; then
  echo "⚠️  Warning: possible hardcoded exclusion list (should use exclusions.ts):"
  echo "$HARDCODED_EXCLUDES"
  # Warning only — not a hard failure (some grep patterns legitimately inline exclusions)
fi

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "Architecture checks failed. See CLAUDE.md for rules."
  exit 1
fi
