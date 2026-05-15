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

# G_v4_8 (2.4.7 Phase C): security finding aggregation lives in ONE place.
#
# What this prevents:
#   Re-introducing per-consumer countBySeverity / manual finding-array
#   re-summing outside the canonical aggregator. D086/D087/D091 traced
#   to multiple consumers (security/index.ts, security/shallow.ts,
#   dashboard/index.ts) counting the same signal with different rules,
#   producing drift between health.md, vulnerability-scan.md, and
#   bom.md on the same repo.
#
# Canonical replacement: buildSecurityAggregate() in
#   src/analyzers/security/aggregator.ts — produces SecurityAggregate
#   once per run; every renderer reads `aggregate.codeBySeverity` /
#   `aggregate.depBySeverity` / `aggregate.secretsBySeverity` by name.
#
# Allowlist rationale:
#   - aggregator.ts itself: this IS the canonical site.
G_V4_8_ALLOWLIST="src/analyzers/security/aggregator.ts"

# Pattern: the SMOKING-GUN shape that caused D086 / D087 / D091. A
# severity-keyed accumulator bump (`bucket[f.severity]++`) — i.e.
# "iterate findings and tally by severity locally." Variants we catch:
#   counts[f.severity]++
#   bySeverity[f.severity]++
#   vulnBySeverity[f.severity]++
# We do NOT match static lookup maps (`SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, ... }`)
# or type declarations (`bySeverity: Record<BomSeverity, number>` inside
# an interface) — neither is the disease class.
# BoM's per-package loop uses `[e.maxSeverity]++` (different attribute
# name) so the gate naturally excludes BoM's legitimate per-package
# aggregation without an allowlist.
g_v4_8_re='\[[a-zA-Z_][a-zA-Z0-9_]*\.severity\][[:space:]]*\+\+|function[[:space:]]+countBySeverity\('

ALLOW_FILTER_8=""
for f in $G_V4_8_ALLOWLIST; do
  ALLOW_FILTER_8="$ALLOW_FILTER_8 -e ^${f}:"
done

G_V4_8_VIOLATIONS=$(grep -rnE "$g_v4_8_re" src/ 2>/dev/null \
  | grep -v "// aggregator-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | { [ -n "$ALLOW_FILTER_8" ] && grep -v $ALLOW_FILTER_8 || cat; })
if [ -n "$G_V4_8_VIOLATIONS" ]; then
  echo "❌ G_v4_8 violation: security severity-aggregation outside the canonical aggregator:"
  echo "$G_V4_8_VIOLATIONS"
  echo "   → Read from SecurityAggregate built by buildSecurityAggregate()."
  echo "   → See src/analyzers/security/aggregator.ts."
  echo "   → Annotate '// aggregator-ok' if your case is a genuinely distinct"
  echo "     metric (e.g. per-package severity in BoM); review justification required."
  ERRORS=$((ERRORS + 1))
fi

# G_v4_10 (2.4.7 Phase C3): dep-action phrasing lives in ONE place.
#
# What this prevents:
#   Re-introducing the `${fixedVersion ?? '(no patch)'}` literal in
#   action titles, bash-comment headers, or any other rendered surface.
#   D111 traced to that pattern producing the grammatically broken
#   "Upgrade `SharpCompress` to (no patch)" on dpl-studio Top 5 when
#   D108 sparse-tier floated a mitigation-only finding into the table.
#
# Canonical replacement: formatDepActionTitle(pkg, fixedVersion) in
#   src/analyzers/security/index.ts — branches the phrasing so
#   "upgrade" semantics never get glued onto "no patch" findings.
#
# Allowlist rationale:
#   - index.ts itself: this IS the canonical site, plus the legitimate
#     H3 heading "Mitigation required — no patch available" lives here.
G_V4_10_ALLOWLIST="src/analyzers/security/index.ts"

# Pattern: any literal `'(no patch)'` or `"(no patch)"` string.
g_v4_10_re="'\(no patch\)'|\"\(no patch\)\""

ALLOW_FILTER_10=""
for f in $G_V4_10_ALLOWLIST; do
  ALLOW_FILTER_10="$ALLOW_FILTER_10 -e ^${f}:"
done

G_V4_10_VIOLATIONS=$(grep -rnE "$g_v4_10_re" src/ 2>/dev/null \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | { [ -n "$ALLOW_FILTER_10" ] && grep -v $ALLOW_FILTER_10 || cat; })
if [ -n "$G_V4_10_VIOLATIONS" ]; then
  echo "❌ G_v4_10 violation: '(no patch)' literal outside the canonical dep-action helper:"
  echo "$G_V4_10_VIOLATIONS"
  echo "   → Route through formatDepActionTitle(pkg, fixedVersion) in"
  echo "     src/analyzers/security/index.ts. The helper branches phrasing on"
  echo "     whether a fix exists — never glue 'upgrade' semantics onto a"
  echo "     mitigation-only finding (D111)."
  ERRORS=$((ERRORS + 1))
fi

# Path-render enforcement: renderer/analyzer code cannot emit absolute
# filesystem paths in string literals.
#
# What this prevents:
#   Customer-facing reports leaking the auditor's home directory or
#   username via lines like `Densest file: /home/<auditor>/projects/...`.
#   Runtime path normalization lives in src/analyzers/tools/paths.ts —
#   each tool wrapper that consumes external-tool output normalizes via
#   `toProjectRelative(cwd, file)` before the path enters the envelope.
#
# What this DOES NOT prevent:
#   Runtime values bubbling through un-normalized (the gate is static).
#   The defense in depth is the normalize-at-gather pattern + this gate
#   for accidental literal slips.
#
# Allowlist:
#   - tool-registry.ts: legitimate brew/system probe paths (e.g.
#     `/home/linuxbrew/.linuxbrew/bin`) used to discover binaries. These
#     never reach customer-facing output.
PATH_RENDER_ALLOWLIST="src/analyzers/tools/tool-registry.ts"

# Pattern: absolute-path literals shaped /home/<seg>/ or /Users/<seg>/
# inside a string literal (single/double/backtick). Username-shaped
# segment after the prefix prevents matching neutral references like
# `/home/page` (a URL path) — only filesystem-shaped username paths
# trigger.
path_render_re="['\"\`](/home/|/Users/)[A-Za-z0-9_.-]+/"

ALLOW_FILTER_PR=""
for f in $PATH_RENDER_ALLOWLIST; do
  ALLOW_FILTER_PR="$ALLOW_FILTER_PR -e ^${f}:"
done

PATH_RENDER_VIOLATIONS=$(grep -rnE "$path_render_re" src/analyzers/ 2>/dev/null \
  | grep -v "// path-render-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | { [ -n "$ALLOW_FILTER_PR" ] && grep -v $ALLOW_FILTER_PR || cat; })
if [ -n "$PATH_RENDER_VIOLATIONS" ]; then
  echo "❌ Path-render violation: absolute-path literal in analyzer code:"
  echo "$PATH_RENDER_VIOLATIONS"
  echo "   → Customer reports must never contain the auditor's home dir / username."
  echo "   → Runtime path normalization lives in src/analyzers/tools/paths.ts"
  echo "     (toProjectRelative). Each tool wrapper normalizes its output before"
  echo "     the path enters the report envelope."
  echo "   → Annotate '// path-render-ok' if your case is a justified exception"
  echo "     (probe paths, error messages with hard-coded system locations, etc.)."
  ERRORS=$((ERRORS + 1))
fi

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "Architecture checks failed. See CLAUDE.md for rules."
  exit 1
fi
