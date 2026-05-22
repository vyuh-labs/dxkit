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
# updated it, so the .NET WinForms benchmark reported 0 TODOs on 3,234 `.cs` files —
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
#   whole tree producing stdout matched per content line. A JS-heavy
#   customer frontend's D082/D083 silent-zero cascade traced to this
#   shape — minified files
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
#   "Upgrade `SharpCompress` to (no patch)" on the .NET WinForms benchmark Top 5 when
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

# G_v4_12: language packs must use the canonical depth-unlimited walker
# (`walkPaths` from `src/analyzers/tools/walk-paths.ts`) for manifest
# and source-file discovery. Hardcoded `maxDepth` parameters and direct
# recursive `fs.readdirSync` walkers in `src/languages/*.ts` silently
# missed real customer monorepos — the .NET WinForms benchmark's C# projects sit 6–9
# levels under repo root, well past every previous per-pack cap
# (python 2, csharp 3, kotlin 3, java 5, ruby 5). The canonical walker
# closes the class by removing depth caps entirely; this gate stops
# the pattern from re-appearing in any new pack.
#
# Annotate `// canonical-walker-ok` for justified exceptions (the
# walker module itself, a probe that explicitly targets a build-output
# subtree that would otherwise be excluded, etc.).
DEPTH_VIOLATIONS=$(grep -rnE "maxDepth[[:space:]]*=[[:space:]]*[0-9]+|depth[[:space:]]*>[[:space:]]*[0-9]+" src/languages/ 2>/dev/null \
  | grep -v "// canonical-walker-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)')
if [ -n "$DEPTH_VIOLATIONS" ]; then
  echo "❌ Depth-capped walker in language pack:"
  echo "$DEPTH_VIOLATIONS"
  echo "   → Use walkPaths from src/analyzers/tools/walk-paths.ts."
  echo "     Depth-unlimited + exclusion-aware. Closes the class of"
  echo "     'manifest deeper than my hardcoded cap' regressions."
  echo "   → Annotate '// canonical-walker-ok' for justified exceptions"
  echo "     (the walker module itself, build-artifact subtree probes)."
  ERRORS=$((ERRORS + 1))
fi

# Scoring discipline: dimension scoring lives in `src/scoring/` —
# never under `src/analyzers/`. Closes the class of "scoring formulas
# drift across consumers" by giving every dimension exactly one home
# (a declarative spec consumed by the shared evaluator).
#
# Three rules, each annotated with `// scoring-spec-ok` for justified
# exceptions:
#
# 1. No `src/analyzers/**/scoring.ts` paths. Each dimension's spec
#    lives at `src/scoring/dimensions/<id>.ts`. Adapter code that
#    builds the per-dimension input shape stays in the analyzer
#    subdir (e.g. `src/analyzers/security/shallow.ts`) — but the
#    file name `scoring.ts` is reserved for the canonical location.
SCORING_FILE_VIOLATIONS=$(find src/analyzers -name 'scoring.ts' 2>/dev/null \
  | grep -v "src/analyzers/tests/scoring.ts")
# Allowlist: src/analyzers/tests/scoring.ts is an internal score helper
# for ranking test-gap remediation actions in detailed reports. It is
# NOT dimension scoring (no DimensionScore output, no spec engine
# consumption); the file name predates this gate and the function is
# scoped to the test-gaps analyzer's action plan.
if [ -n "$SCORING_FILE_VIOLATIONS" ]; then
  echo "❌ Scoring file outside the canonical home:"
  echo "$SCORING_FILE_VIOLATIONS"
  echo "   → Dimension scoring lives in src/scoring/dimensions/<id>.ts."
  echo "     The analyzer subdir holds gather + adapter + renderer code"
  echo "     only — never the scoring formula itself."
  ERRORS=$((ERRORS + 1))
fi

# 2. No hardcoded rating-band thresholds (>= 80, >= 60, >= 40, >= 20)
#    in scoring-related code outside `src/scoring/thresholds.ts`.
#    All consumers route through `ratingFromScore` / `RATING_THRESHOLDS`
#    so the band boundaries have one source of truth.
RATING_VIOLATIONS=$(grep -rnE ">=[[:space:]]*(80|60|40|20)[^0-9]" src/ 2>/dev/null \
  | grep -E "(score|rating|grade|dimension)" \
  | grep -v "src/scoring/thresholds.ts" \
  | grep -v "// scoring-spec-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)')
if [ -n "$RATING_VIOLATIONS" ]; then
  echo "❌ Hardcoded rating-band threshold in scoring context:"
  echo "$RATING_VIOLATIONS"
  echo "   → Use ratingFromScore() / RATING_THRESHOLDS from src/scoring."
  echo "   → Annotate '// scoring-spec-ok' for justified exceptions"
  echo "     (renderer bucketing on unrelated 0-100 values, etc.)."
  ERRORS=$((ERRORS + 1))
fi

# 3. No hardcoded cap-tier ceiling values (40, 35, 65, 75, 79) used
#    in subtractive/clamp contexts outside spec files. Spec files
#    declare tier names; the values come from CAP_TIERS.
CAP_VIOLATIONS=$(grep -rnE "(final|score)[[:space:]]*=[[:space:]]*(35|40|65|75|79)\b" src/ 2>/dev/null \
  | grep -v "src/scoring/" \
  | grep -v "// scoring-spec-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)')
if [ -n "$CAP_VIOLATIONS" ]; then
  echo "❌ Hardcoded cap ceiling outside scoring module:"
  echo "$CAP_VIOLATIONS"
  echo "   → Use CAP_TIERS[tier] from src/scoring. Each tier name says"
  echo "     what the cap means (trust-broken / uncertainty /"
  echo "     fixable-finding / etc.)."
  echo "   → Annotate '// scoring-spec-ok' for legitimate exceptions."
  ERRORS=$((ERRORS + 1))
fi

# Architectural-shape discipline: framework path patterns + role
# vocabulary live in `src/languages/*.ts:architecturalShape` — never
# inline in `src/analyzers/`.
#
# What this prevents:
#   Re-introducing the pre-extension class of "hardcoded
#   backend-centric paths in cross-cutting consumers": `*/controllers/*`
#   in find commands, `if (lower.includes('/services/'))` in classifier
#   code, `'controller' | 'service' | ...` enum types, "controllers /
#   handlers, models" prose in renderers. The class caused both a JS-heavy
#   customer frontend and the .NET WinForms benchmark to report empty
#   test-gap CRITICAL/HIGH/MEDIUM
#   buckets pre-extension because the patterns matched neither React
#   components/pages nor .NET Forms/Services.
#
# Canonical replacement: each language pack declares its own
#   `architecturalShape` in `src/languages/<id>.ts`. Cross-cutting
#   consumers union contributions via `allPrimaryComponentPaths`,
#   `allRoutePaths`, `allModelPaths`, `allTestGapPriorityPaths`,
#   `dominantVocabulary` from `src/languages/index.ts`.
#
# Rule 1: no quoted path-style framework literals (`'/controllers/'`,
#   `"/services/"`, `'\/Forms\/'`) in `src/analyzers/`. The leading
#   AND trailing slash ensures we catch path patterns (where the
#   meaning is "files under this directory") rather than property
#   names or unrelated tokens.
#
# Allowlist:
#   - `src/analyzers/maintainability/shallow.ts`: holds the generic
#     vocabulary fallbacks (`'components'`, `'models'`) consumed when
#     no active pack supplies `dominantVocabulary`. These are
#     deliberately stack-agnostic words at the renderer surface, not
#     hardcoded framework paths.
#
#   Annotate `// arch-shape-ok` for justified exceptions (e.g. a
#   legitimate runtime probe path that's not pack-relevant).
ARCH_SHAPE_ALLOWLIST="src/analyzers/maintainability/shallow.ts"

arch_shape_path_re="['\"\`]\\/(controllers?|handlers?|services?|repositories?|interceptors?|middleware|models?|entities|forms?|viewmodels?|pages|views|components|hooks|screens|usecases|routers|viewsets|daos?|resources|endpoints|usercontrols|workers|jobs|helpers|channels|serializers|schemas|dtos?|domain|api)\\/"
arch_shape_word_re="['\"\`](controller|service|interceptor|repository|handler|viewmodel|viewset|router)['\"\`]"

ALLOW_FILTER_AS=""
for f in $ARCH_SHAPE_ALLOWLIST; do
  ALLOW_FILTER_AS="$ALLOW_FILTER_AS -e ^${f}:"
done

ARCH_SHAPE_PATH_VIOLATIONS=$(grep -rnEi "$arch_shape_path_re" src/analyzers/ 2>/dev/null \
  | grep -v "// arch-shape-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | { [ -n "$ALLOW_FILTER_AS" ] && grep -v $ALLOW_FILTER_AS || cat; })
if [ -n "$ARCH_SHAPE_PATH_VIOLATIONS" ]; then
  echo "❌ Architectural-shape violation: hardcoded framework path literal in analyzer code:"
  echo "$ARCH_SHAPE_PATH_VIOLATIONS"
  echo "   → Path patterns like '/controllers/', '/components/', '/Forms/' belong in"
  echo "     src/languages/<id>.ts under architecturalShape.primaryComponentPaths /"
  echo "     routePaths / modelPaths / testGapPriority. Consumers union active-pack"
  echo "     contributions via the helpers in src/languages/index.ts."
  echo "   → Annotate '// arch-shape-ok' if your case is a genuine exception (runtime"
  echo "     probe path that doesn't represent stack vocabulary, etc.)."
  ERRORS=$((ERRORS + 1))
fi

# Rule 2: no quoted singular role-name literals (`'controller'`,
#   `'service'`, `'handler'`, `'interceptor'`, `'repository'`,
#   `'viewmodel'`, `'viewset'`, `'router'`) in `src/analyzers/`.
#   These were the pre-extension `SourceFile.type` enum values; the
#   post-extension type is a free string drawn from
#   `patternToLabel(matchedPattern)`. Excludes generic words
#   (`'model'`, `'component'`, `'form'`, `'view'`, `'page'`) that
#   commonly appear in non-architectural contexts (data models in
#   ML code, view rendering libraries, page-object test patterns).
ARCH_SHAPE_WORD_VIOLATIONS=$(grep -rnE "$arch_shape_word_re" src/analyzers/ 2>/dev/null \
  | grep -v "// arch-shape-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | { [ -n "$ALLOW_FILTER_AS" ] && grep -v $ALLOW_FILTER_AS || cat; })
if [ -n "$ARCH_SHAPE_WORD_VIOLATIONS" ]; then
  echo "❌ Architectural-shape violation: hardcoded role-name string literal in analyzer code:"
  echo "$ARCH_SHAPE_WORD_VIOLATIONS"
  echo "   → Role-name labels come from patternToLabel(matched architecturalShape pattern)."
  echo "     The pre-extension closed enum ('controller' | 'service' | ...) was replaced"
  echo "     by a free string label drawn from the matched pack pattern's last segment."
  echo "   → Annotate '// arch-shape-ok' for non-architectural uses (rare)."
  ERRORS=$((ERRORS + 1))
fi

# ─── Rule 9 (fingerprint discipline): one home for finding-identity hashes ──
#
# What this prevents:
#   A future analyzer rolling its own SHA scheme for finding identity,
#   silently opting out of the baseline / guardrail contract. Every
#   per-finding fingerprint flows through the canonical helpers in
#   `src/analyzers/tools/fingerprint.ts`, dispatched by
#   `src/baseline/finding-identity.ts:identityFor`.
#
# Canonical sites (`createHash` allowed):
#   - `src/analyzers/tools/fingerprint.ts` — the home of every
#     SHA-1[0:16] fingerprint scheme.
#   - `src/baseline/finding-identity.ts` — the dispatch that delegates
#     to those helpers for cross-kind identity output.
#
# Scope:
#   `src/analyzers/` + `src/baseline/`. `src/files.ts` legitimately
#   uses SHA-256 for file-content hashing (caching / dedup, NOT finding
#   identity); it sits outside the scope and is unaffected.
#
# Annotate `// fingerprint-helper-ok` on a specific line for a
# justified non-identity hash inside the scoped directories.
FINGERPRINT_HELPER_ALLOWLIST="src/analyzers/tools/fingerprint.ts src/baseline/finding-identity.ts src/baseline/content-hash.ts"
ALLOW_FILTER_FP=""
for f in $FINGERPRINT_HELPER_ALLOWLIST; do
  ALLOW_FILTER_FP="$ALLOW_FILTER_FP -e ^${f}:"
done

ROGUE_HASH=$(grep -rnE "createHash[[:space:]]*\(" src/analyzers/ src/baseline/ 2>/dev/null \
  | grep -v "// fingerprint-helper-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | { [ -n "$ALLOW_FILTER_FP" ] && grep -v $ALLOW_FILTER_FP || cat; })
if [ -n "$ROGUE_HASH" ]; then
  echo "❌ Rule 9 violation: createHash() used outside the canonical fingerprint helpers:"
  echo "$ROGUE_HASH"
  echo "   → Use computeFingerprint or computeCodeFingerprint from src/analyzers/tools/fingerprint.ts."
  echo "   → For new finding kinds, extend src/baseline/finding-identity.ts:identityFor"
  echo "     with a new IdentityInput discriminant rather than hashing inline."
  echo "   → Annotate '// fingerprint-helper-ok' for justified non-identity hashing."
  ERRORS=$((ERRORS + 1))
fi

# Line-bucketing reimplementation gate: the 3-line window used by code-
# finding fingerprints lives in `lineWindowFor()` and only there. Any
# `Math.floor(x / N) * N`-shaped expression inside the scoped
# directories is a candidate for rolling-your-own bucket scheme.
LINE_BUCKET_ALLOWLIST="src/analyzers/tools/fingerprint.ts"
ALLOW_FILTER_LB=""
for f in $LINE_BUCKET_ALLOWLIST; do
  ALLOW_FILTER_LB="$ALLOW_FILTER_LB -e ^${f}:"
done

ROGUE_BUCKET=$(grep -rnE "Math\.floor\([^/]*\/[[:space:]]*[0-9]+[[:space:]]*\)[[:space:]]*\*[[:space:]]*[0-9]+" src/analyzers/ src/baseline/ 2>/dev/null \
  | grep -v "// fingerprint-helper-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | { [ -n "$ALLOW_FILTER_LB" ] && grep -v $ALLOW_FILTER_LB || cat; })
if [ -n "$ROGUE_BUCKET" ]; then
  echo "❌ Rule 9 violation: inline line-bucketing outside the canonical helper:"
  echo "$ROGUE_BUCKET"
  echo "   → Import { lineWindowFor } from '../tools/fingerprint' instead of"
  echo "     reimplementing Math.floor(line / N) * N inline."
  echo "   → The 3-line constant lives in CODE_FINGERPRINT_LINE_WINDOW."
  echo "   → Annotate '// fingerprint-helper-ok' for justified exceptions (rare)."
  ERRORS=$((ERRORS + 1))
fi

# ─── Rule 10 (baseline producer coverage): identity calls confined ──────────
# Closes the class of bug where a new analyzer's findings reach disk
# via a one-off `BaselineEntry`-builder that bypasses the canonical
# producer registry. Every `identityFor(` call MUST live inside a
# producer module (so the registry sees the contribution) or inside
# the dispatch itself.
#
# Canonical sites:
#   - `src/baseline/finding-identity.ts` — the dispatch definition.
#   - `src/baseline/producers/**` — every registered producer.
#
# Annotate `// rule10-producer-ok` on the violating line for justified
# exceptions (today: zero needed; the registry is the right home).
RULE10_ALLOWLIST="src/baseline/finding-identity.ts"
ROGUE_IDENTITY=$(grep -rnE "identityFor[[:space:]]*\(" src/ 2>/dev/null \
  | grep -v "// rule10-producer-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | grep -v "^src/baseline/producers/" \
  | { [ -n "$RULE10_ALLOWLIST" ] && grep -v -e "^${RULE10_ALLOWLIST}:" || cat; })
if [ -n "$ROGUE_IDENTITY" ]; then
  echo "❌ Rule 10 violation: identityFor() called outside the producer registry:"
  echo "$ROGUE_IDENTITY"
  echo "   → Register a producer in src/baseline/producers/index.ts:PRODUCERS"
  echo "     and put the identityFor() call inside that producer module."
  echo "   → The orchestrator iterates the registry; bypassing it means the"
  echo "     new finding kind silently misses guardrail coverage."
  echo "   → Annotate '// rule10-producer-ok' for justified exceptions (rare)."
  ERRORS=$((ERRORS + 1))
fi

# =============================================================================
# Sprint 4 (2.5.2): dead template-condition detector.
# =============================================================================
#
# `src/constants.ts:getConditions()` computes IF_<NAME> booleans from
# the resolved config. Each one is meant to gate a template branch
# (`{{#IF_NAME}}…{{/IF_NAME}}` in src-templates/) or a generator.ts
# `copyStatic` call. Conditions that compute but have NO consumer are
# dead code: harmless in behavior, but they accumulate (we found 4
# dead conditions sitting since 2026-05-19 because typecheck doesn't
# catch compute-without-consumer — they're type-correct, just useless).
#
# This rule extracts every `IF_*:` key from constants.ts and verifies
# each has at least one consumer in either:
#   - src-templates/                (mustache {{#IF_NAME}} blocks)
#   - src/generator.ts              (conditions.IF_NAME programmatic refs)
#
# Allowlist: `// arch-check-ok` on the constants.ts line for any
# intentional ahead-of-template addition.
DEAD_CONDS=""
IF_TOKENS=$(grep -E "^\s+IF_[A-Z_]+:" src/constants.ts 2>/dev/null \
  | grep -v "// arch-check-ok" \
  | sed -E 's/^\s+(IF_[A-Z_]+):.*/\1/')
for cond in $IF_TOKENS; do
  # Mustache section/inverted/standalone in any template file
  if grep -rq "{{[#^/]*$cond}}" src-templates/ 2>/dev/null; then
    continue
  fi
  # Programmatic consumer in generator.ts
  if grep -q "conditions\.$cond\b" src/generator.ts 2>/dev/null; then
    continue
  fi
  DEAD_CONDS="$DEAD_CONDS $cond"
done
if [ -n "$DEAD_CONDS" ]; then
  echo "❌ Dead template conditions computed in src/constants.ts but consumed nowhere:"
  for c in $DEAD_CONDS; do echo "   • $c"; done
  echo "   → Either add a template consumer ({{#$c}}…{{/$c}} in src-templates/)"
  echo "     or remove the IF_ entry from getConditions() in src/constants.ts."
  echo "   → Annotate '// arch-check-ok' on the constants.ts line for intentional"
  echo "     ahead-of-template additions (rare)."
  ERRORS=$((ERRORS + 1))
fi

# =============================================================================
# Sibling-package release-discipline rule (added 2026-05-22).
# =============================================================================
#
# dxkit ships from a monorepo with sibling packages under `packages/`.
# Today there's one — `@vyuhlabs/create-dxkit` (the `npm init
# @vyuhlabs/dxkit` shim). Tomorrow there may be more (MCP server,
# Claude Code marketplace plugin, etc. per the 2.6 plan).
#
# Each sibling publishes independently with its own tag scheme:
#   - dxkit → `vX.Y.Z` (e.g. v2.5.2) → publish.yml
#   - create-dxkit → `create-dxkit@vX.Y.Z` (e.g. create-dxkit@v0.2.0)
#     → publish-create-dxkit.yml
#
# Failure mode this rule catches: during a dxkit release-prep PR, the
# author bumps `package.json` to a new dxkit version but forgets to
# bump `packages/create-dxkit/package.json` even though create-dxkit
# code has changed since its last release. The dxkit release ships
# with a stale create-dxkit on npm; customers running `npm init
# @vyuhlabs/dxkit` get the old shim. This happened during 2.5.2
# release-prep — caught manually mid-flight; rule added so the
# class fix is in place for next time.
#
# Detection logic:
#   1. Determine if we're in dxkit release-prep state — package.json
#      version differs from the latest `v*` tag.
#   2. If yes, find the latest `create-dxkit@v*` tag.
#   3. Diff `packages/create-dxkit/` between that tag and HEAD,
#      excluding `package.json` itself (we don't care about version
#      bumps; we care about content changes).
#   4. If there are content changes AND the on-disk create-dxkit
#      version still matches the last published one, fail.
DXKIT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
LAST_DXKIT_TAG_RAW=$(git tag --list 'v*' --sort=-v:refname 2>/dev/null | head -1)
LAST_DXKIT_VERSION=$(echo "$LAST_DXKIT_TAG_RAW" | sed 's/^v//')

if [ -n "$DXKIT_VERSION" ] && [ -n "$LAST_DXKIT_VERSION" ] && [ "$DXKIT_VERSION" != "$LAST_DXKIT_VERSION" ]; then
  # Release-prep state: we're tagging a new dxkit version. Check siblings.
  CREATE_VERSION=$(node -p "require('./packages/create-dxkit/package.json').version" 2>/dev/null || echo "")
  LAST_CREATE_TAG=$(git tag --list 'create-dxkit@v*' --sort=-v:refname 2>/dev/null | head -1)
  LAST_CREATE_VERSION=$(echo "$LAST_CREATE_TAG" | sed 's/^create-dxkit@v//')

  if [ -n "$LAST_CREATE_TAG" ] && [ -n "$CREATE_VERSION" ]; then
    # Diff create-dxkit content (excluding the package.json version field) since its last tag.
    CREATE_CHANGES=$(git diff --name-only "$LAST_CREATE_TAG"...HEAD -- packages/create-dxkit/ 2>/dev/null | grep -v '^packages/create-dxkit/package\.json$' || true)
    if [ -n "$CREATE_CHANGES" ] && [ "$CREATE_VERSION" = "$LAST_CREATE_VERSION" ]; then
      echo "❌ Release-prep state detected (dxkit ${LAST_DXKIT_VERSION} → ${DXKIT_VERSION})"
      echo "   create-dxkit content has changed since ${LAST_CREATE_TAG}:"
      echo "$CREATE_CHANGES" | sed 's/^/      /'
      echo "   But packages/create-dxkit/package.json version is unchanged (${CREATE_VERSION})."
      echo "   → Bump packages/create-dxkit/package.json before tagging the dxkit release."
      echo "   → Customers running 'npm init @vyuhlabs/dxkit' will keep getting the old"
      echo "     shim if this isn't published alongside the dxkit release."
      ERRORS=$((ERRORS + 1))
    fi
  fi
fi

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "Architecture checks failed. See CLAUDE.md for rules."
  exit 1
fi
