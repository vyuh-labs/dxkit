#!/bin/bash
# Architecture checks — run in pre-commit hook.
# Catches common violations of CLAUDE.md rules.

ERRORS=0

# ─── G1 (Recipe v3): LP language list auto-derived from registry ────────────
# Pre-G1: each LP-A* rule below had its own hardcoded language list
# (`python|go|rust|csharp` etc.). Lists drifted as new packs landed:
# kotlin (2.4.4) and java (2.4.5) weren't in any rule's pattern, so
# violations against `config.languages.kotlin` slipped through this gate
# silently — only D008's `typecheck:test` caught them at a later stage.
#
# Now we derive the language ID list from `src/languages/index.ts`
# using the same awk block extraction the cross-ecosystem and docs
# coverage gates use. Multi-line robust (Prettier reformatted at the
# 7th LANGUAGES entry / 10k.1 Java add).
#
# The list is always augmented with `node|nextjs` as defensive guards
# — those aren't pack IDs but pre-10f.4 code paths sometimes reference
# them via `as any` or legacy DetectedStack shape.
LANG_REGISTRY="src/languages/index.ts"
if [ -f "$LANG_REGISTRY" ]; then
  LANG_BLOCK=$(awk '/^export const LANGUAGES/,/^\];/' "$LANG_REGISTRY" | tr -d '\n')
  LANG_BODY=$(echo "$LANG_BLOCK" | sed 's/.*\[\(.*\)\].*/\1/' | sed 's/,[[:space:]]*$//')
  LP_LANG_IDS_RAW=$(echo "$LANG_BODY" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$')
  if [ -z "$LP_LANG_IDS_RAW" ]; then
    echo "❌ G1 self-test failed: parsed zero LANGUAGES entries from $LANG_REGISTRY."
    echo "   The block-extraction parser must be broken — fix before continuing."
    exit 1
  fi
  # Pipe-delimited for use inside grep -E patterns.
  LP_LANG_IDS=$(echo "$LP_LANG_IDS_RAW" | tr '\n' '|' | sed 's/|$//')
  LP_LANG_IDS_FULL="${LP_LANG_IDS}|node|nextjs"
  # IF_<LANG> tokens: uppercase + prefix. Always include IF_NODE/IF_NEXTJS
  # (framework-level, not pack-level).
  LP_IF_TOKENS=$(echo "$LP_LANG_IDS_RAW" | tr '[:lower:]' '[:upper:]' | sed 's/^/IF_/' | tr '\n' '|' | sed 's/|$//')
  LP_IF_TOKENS="${LP_IF_TOKENS}|IF_NODE|IF_NEXTJS"
else
  # Fallback (shouldn't hit in normal CI but keeps the script runnable).
  LP_LANG_IDS_FULL="python|typescript|go|rust|csharp|kotlin|java|node|nextjs"
  LP_IF_TOKENS="IF_PYTHON|IF_TYPESCRIPT|IF_GO|IF_RUST|IF_CSHARP|IF_KOTLIN|IF_JAVA|IF_NODE|IF_NEXTJS"
fi

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
LP_IF_VIOLATIONS=$(grep -rnE "\b(${LP_IF_TOKENS})\b" src/ 2>/dev/null \
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
LP_LANG_LOOKUP=$(grep -rnE "config\.languages\.(${LP_LANG_IDS_FULL})\b" src/ 2>/dev/null \
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
LP_RULEFILE_VIOLATIONS=$(grep -rnE "['\"](${LP_LANG_IDS})\.md['\"]" src/ 2>/dev/null \
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
# (see `buildJscpdPattern` in `tools/jscpd.ts` for the pattern).
#
# Extension list is hardcoded (not derived) because pack sourceExtensions
# can be const references (typescript's `TS_JS_EXT`) that bash can't
# resolve without evaluating TS. The defense is permissive: pattern
# fires on 2+ known extensions anywhere in a multi-language glob, so
# partial drift still triggers. Add new extensions when adding new pack.
LP_GLOB_VIOLATIONS=$(grep -rnE "'\*\*/\*\.\{[^}]*\b(py|ts|tsx|js|jsx|mjs|cjs|go|rs|cs|kt|kts|java|rb)\b[^}]*\b(py|ts|tsx|js|jsx|mjs|cjs|go|rs|cs|kt|kts|java|rb)\b[^}]*\}'" src/ 2>/dev/null \
  | grep -v "// lp-recipe-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)')
if [ -n "$LP_GLOB_VIOLATIONS" ]; then
  echo "❌ LP recipe violation: hardcoded multi-language extension glob:"
  echo "$LP_GLOB_VIOLATIONS"
  echo "   → Derive from LANGUAGES.flatMap(l => l.sourceExtensions). See tools/jscpd.ts:buildJscpdPattern for the pattern."
  ERRORS=$((ERRORS + 1))
fi

# LP-A5: No hardcoded multi-language `--include='*.<ext>'` grep flags.
# D030 (2.4.7) discovered the quality hygiene grep had carried a
# hardcoded `*.ts/*.tsx/*.js/*.jsx/*.py/*.go` list since Phase 6
# (2026-04-13). The list pre-dated the language-pack registry; 5
# subsequent pack additions (rust, csharp, kotlin, java, ruby) never
# updated it, so dpl-studio reported 0 TODOs on 3,234 `.cs` files —
# the hygiene grep silently skipped every C# source.
#
# Cross-cutting `grep --include='*.<ext>'` lists MUST derive from
# `allSourceExtensions()` (see src/analyzers/quality/gather.ts:
# hygieneIncludeFlags for the pattern). Same constraint as LP-A4:
# extension list is hardcoded in this regex (not derived) because
# pack sourceExtensions can be const references (typescript's
# `TS_JS_EXT`) that bash can't resolve without evaluating TS.
# Defense fires on 2+ `--include` flags on the same line targeting
# known language extensions — partial drift still triggers.
LP_INCLUDE_VIOLATIONS=$(grep -rnE "\-\-include=['\"]\*\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|cs|kt|kts|java|rb)['\"].*\-\-include=['\"]\*\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|cs|kt|kts|java|rb)['\"]" src/ 2>/dev/null \
  | grep -v "// lp-recipe-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)')
if [ -n "$LP_INCLUDE_VIOLATIONS" ]; then
  echo "❌ LP recipe violation: hardcoded multi-language --include='*.<ext>' grep flags:"
  echo "$LP_INCLUDE_VIOLATIONS"
  echo "   → Derive from allSourceExtensions() in src/languages/index.ts. See src/analyzers/quality/gather.ts:hygieneIncludeFlags for the pattern."
  ERRORS=$((ERRORS + 1))
fi

# G_v4_7 (2.4.7 class-fix release): no recursive grep on the source tree.
#
# What this prevents:
#   `grep -rEf <pat> --include=*.js .` style content scans that walk the
#   whole tree producing stdout matched per content line. The web-client
#   D082/D083 silent-zero cascade traced to this shape — minified files
#   matched ~11,500 times × ~6KB content = 67MB stdout, overflowing
#   run()'s 64MB ceiling, returning empty, consoleLogCount fell to 0.
#
# What this DOES NOT prevent:
#   `find . -type f -name '*.cs'` — narrow file enumeration in language
#   packs (rust/python/go/java/csharp/etc.) for pack-specific purposes
#   (lint target lists, coverage path discovery). These don't suffer
#   the maxBuffer issue and have legitimate narrow uses.
#
#   `fs.readdirSync` for non-source-enumeration purposes (template-file
#   copying in generator.ts, project-structure detection in detect.ts,
#   pack-specific dir scanning) — these aren't the bug class.
#
# Canonical replacement: walkSourceFiles + countLineMatches in
# src/analyzers/tools/walk-source-files.ts — pure JS, no shell, files
# pruned at directory boundary so excluded content never reaches the
# scanner.
G_V4_7_ALLOWLIST="src/analyzers/tools/walk-source-files.ts \
                  src/analyzers/tools/grep-secrets.ts \
                  src/analyzers/tools/semgrep.ts \
                  src/analyzers/tools/gitleaks.ts"

# Pattern: `grep -r{l,n,c,E,f}` shell call inside a run()/execSync()
# wrapper. The recursive flag (`r`) combined with content matchers
# (`E`/`f`) is the specific shape that caused D082/D083. Matches
# canonical orderings: `-rnEf`, `-rcEf`, `-rlEf`, `-rEf`, `-rE`, `-rn`,
# `-rl`, `-rc`, and `-r ... -E ... -f`. Pure file-listing greps like
# `grep -l 'package.json' .` don't match because they don't carry both
# `r` and a content-match flag.
walker_re_grep="(run|execSync)\\(['\"\`].*grep -[a-zA-Z]*r[a-zA-Z]*[EFf]"

ALLOW_FILTER=""
for f in $G_V4_7_ALLOWLIST; do
  ALLOW_FILTER="$ALLOW_FILTER -e ^${f}:"
done

G_V4_7_VIOLATIONS=$(grep -rnE "$walker_re_grep" src/ 2>/dev/null \
  | grep -v "// walker-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | { [ -n "$ALLOW_FILTER" ] && grep -v $ALLOW_FILTER || cat; })
if [ -n "$G_V4_7_VIOLATIONS" ]; then
  echo "❌ G_v4_7 violation: recursive grep content-scan outside the canonical helper:"
  echo "$G_V4_7_VIOLATIONS"
  echo "   → Route through walkSourceFiles + countLineMatches in src/analyzers/tools/walk-source-files.ts."
  echo "   → Minified-content / large repos overflow run()'s maxBuffer (D082/D083);"
  echo "     the canonical helper walks in-process so excluded content never hits a scanner."
  echo "   → Annotate '// walker-ok' if your case genuinely needs grep (rare; review justification required)."
  ERRORS=$((ERRORS + 1))
fi

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "Architecture checks failed. See CLAUDE.md for rules."
  exit 1
fi
