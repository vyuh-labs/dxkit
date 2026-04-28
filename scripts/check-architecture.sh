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

# =============================================================================
# Phase 10i.0-LP recipe enforcement — pack-coupling rules.
# Catches code that re-introduces hardcoded language coupling outside the
# `LanguageSupport` registry (the LP audit deliverable).
# =============================================================================

# LP-A1: No `IF_<LANG>` references outside `constants.ts` (which produces them)
# and `generator.ts` (which consumes the conditions object). Anywhere else is
# a hardcoded language-specific gate that should iterate active packs instead.
# Filter trailing `| grep -v -E ':[[:space:]]*(//|\*)'` skips lines whose
# content (after `file:line:`) starts with `//` or `*` — i.e. JSDoc / line-
# comment text that mentions the token without using it.
LP_IF_VIOLATIONS=$(grep -rnE "\b(IF_PYTHON|IF_GO|IF_RUST|IF_CSHARP|IF_NODE|IF_NEXTJS)\b" src/ 2>/dev/null \
  | grep -v "src/constants.ts:" \
  | grep -v "src/generator.ts:" \
  | grep -v "// lp-recipe-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)')
if [ -n "$LP_IF_VIOLATIONS" ]; then
  echo "❌ LP recipe violation: hardcoded IF_<LANG> reference outside constants.ts/generator.ts:"
  echo "$LP_IF_VIOLATIONS"
  echo "   → Iterate active packs via activeLanguagesFromStack(stack) instead of conditional gates."
  echo "   → Annotate with '// lp-recipe-ok' if intentional (rare — should be a comment block)."
  ERRORS=$((ERRORS + 1))
fi

# LP-A2: No `config.languages.<id>` direct property lookups outside the
# `src/languages/` registry, `src/types.ts` (defines the shape), and a small
# allowlist of files that legitimately bridge legacy DetectedStack shape to
# the pack registry (project-yaml.ts, constants.ts, generator.ts, detect.ts).
# The allowlist shrinks to zero when 10f.4 lands the DetectedStack interface
# refactor.
LP_LANG_LOOKUP=$(grep -rnE "config\.languages\.(python|go|node|nextjs|rust|csharp)\b" src/ 2>/dev/null \
  | grep -v "src/languages/" \
  | grep -v "src/types.ts:" \
  | grep -v "src/project-yaml.ts:" \
  | grep -v "src/constants.ts:" \
  | grep -v "src/generator.ts:" \
  | grep -v "src/detect.ts:" \
  | grep -v "// lp-recipe-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)')
if [ -n "$LP_LANG_LOOKUP" ]; then
  echo "❌ LP recipe violation: direct config.languages.<id> lookup outside the registry bridge:"
  echo "$LP_LANG_LOOKUP"
  echo "   → Use activeLanguagesFromStack(stack) / activeLanguagesFromFlags(flags) from src/languages/."
  ERRORS=$((ERRORS + 1))
fi

# LP-A3: No hardcoded `<lang>.md` rule-file string literals outside
# `src/languages/` (where each pack declares its own ruleFile) and the
# framework-rule block in `generator.ts` (nextjs/loopback/express are
# framework rules, NOT pack-owned).
LP_RULEFILE_VIOLATIONS=$(grep -rnE "['\"](python|go|rust|csharp)\.md['\"]" src/ 2>/dev/null \
  | grep -v "src/languages/" \
  | grep -v "// lp-recipe-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)')
if [ -n "$LP_RULEFILE_VIOLATIONS" ]; then
  echo "❌ LP recipe violation: hardcoded <lang>.md rule-file string outside packs:"
  echo "$LP_RULEFILE_VIOLATIONS"
  echo "   → Pack should declare 'ruleFile' in LanguageSupport; consumer iterates active packs."
  ERRORS=$((ERRORS + 1))
fi

# LP-A4: No hardcoded multi-language file-extension globs. The 10j.1 bug
# was `JSCPD_PATTERN = '**/*.{ts,tsx,js,jsx,py,go,rs,cs}'` — adding
# kotlin's `.kt`/`.kts` required editing this string by hand, and the
# kotlin matrix test silently failed because we forgot. Cross-cutting
# extension globs MUST derive from `LANGUAGES.flatMap(l => l.sourceExtensions)`
# (see `buildJscpdPattern` in `tools/jscpd.ts` for the pattern). This
# rule catches any future regression.
LP_GLOB_VIOLATIONS=$(grep -rnE "'\*\*/\*\.\{[^}]*\b(py|ts|tsx|js|go|rs|cs|kt)\b[^}]*\b(py|ts|tsx|js|go|rs|cs|kt)\b[^}]*\}'" src/ 2>/dev/null \
  | grep -v "// lp-recipe-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)')
if [ -n "$LP_GLOB_VIOLATIONS" ]; then
  echo "❌ LP recipe violation: hardcoded multi-language extension glob:"
  echo "$LP_GLOB_VIOLATIONS"
  echo "   → Derive from LANGUAGES.flatMap(l => l.sourceExtensions). See tools/jscpd.ts:buildJscpdPattern for the pattern."
  ERRORS=$((ERRORS + 1))
fi

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "Architecture checks failed. See CLAUDE.md for rules."
  exit 1
fi
