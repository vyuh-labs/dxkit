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

# G_v4_13 (Windows-compat class-fix): no POSIX file-enumeration shell-outs.
#
# What this prevents:
#   `find . -type f -name '*.cs'`, `find . -type d`, `ls a b c`,
#   `wc -l README`, `cat file` inside a run()/execSync()/countLines()/
#   runJSON()/runExitCode() command string. These return EMPTY on Windows
#   (cmd.exe has no `find`/`ls`/`wc`/`cat`), so source enumeration, the
#   directory-count metric, and the DX-config probes silently produced
#   zero — a baseline captured on Windows omitted whole finding
#   categories with no signal. This is the regex the G_v4_7 comment block
#   always SAID it wanted (find-enumeration) but only ever enforced for
#   recursive grep.
#
# Canonical replacement (all pure-Node, cross-platform):
#   - source enumeration → walkSourceFiles (extensions + includeTests/
#     includeAutogen to match a prior `find -name`)
#   - manifest/path discovery → walkPaths
#   - directory count → countDirectories
#   - file existence/count → fs.existsSync / fileExists
#   (all in src/analyzers/tools/walk-source-files.ts + walk-paths.ts)
#
# `git ls-files` / `git rev-parse` etc. are NOT matched (git is
# cross-platform and the command starts with `git`, not find/ls/wc/cat).
# Annotate '// posix-enum-ok' for a justified exception.
posix_enum_re="(run|execSync|countLines|runJSON|runExitCode)\\((\`|'|\")[[:space:]]*(find|ls|wc|cat)[[:space:]]| -type [dfl]([[:space:]]|\b)"
G_V4_13_VIOLATIONS=$(grep -rnE "$posix_enum_re" src/ 2>/dev/null \
  | grep -v "// posix-enum-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | grep -v -e '^src/analyzers/tools/walk-source-files.ts:')
if [ -n "$G_V4_13_VIOLATIONS" ]; then
  echo "❌ G_v4_13 violation: POSIX file-enumeration shell-out (breaks on Windows):"
  echo "$G_V4_13_VIOLATIONS"
  echo "   → Replace with walkSourceFiles / walkPaths / countDirectories / fs"
  echo "     (src/analyzers/tools/walk-source-files.ts). cmd.exe has no find/ls/wc/cat,"
  echo "     so these return empty on Windows and silently zero the metric."
  echo "   → Annotate '// posix-enum-ok' if your case genuinely needs the shell-out (rare)."
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

# Rule 3: no hardcoded non-consumer-route convention literals
#   (`'/webhook'`, `'/cron/'`, `'/healthz'`, ...) in `src/analyzers/`.
#   These convention path-shapes (routes an external actor drives, so a
#   "no in-repo consumer" reading is expected — not dead-surface slop)
#   are pack-declared in `architecturalShape.nonConsumerRoutePaths` and
#   consumed via `allNonConsumerRoutePaths(flags)`. The dead-surface
#   analyzer must never hardcode a `cron|webhook|health` literal — that
#   was the exact false-positive class the pack declaration exists to
#   kill (a new framework's convention must be a pack edit, not an
#   analyzer edit).
arch_conv_re="['\"\`]\\/(web)?hooks?|['\"\`]\\/cron|['\"\`]\\/scheduled|['\"\`]\\/health|['\"\`]\\/healthz|['\"\`]\\/livez|['\"\`]\\/readyz|['\"\`]\\/liveness|['\"\`]\\/readiness|['\"\`]\\/callback"
ARCH_CONV_VIOLATIONS=$(grep -rnEi "$arch_conv_re" src/analyzers/ 2>/dev/null \
  | grep -v "// arch-shape-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)')
if [ -n "$ARCH_CONV_VIOLATIONS" ]; then
  echo "❌ Architectural-shape violation: hardcoded non-consumer-route convention literal in analyzer code:"
  echo "$ARCH_CONV_VIOLATIONS"
  echo "   → Convention route shapes (webhook/cron/health/callback) belong in"
  echo "     src/languages/<id>.ts under architecturalShape.nonConsumerRoutePaths,"
  echo "     consumed via allNonConsumerRoutePaths(flags). A new framework's"
  echo "     convention is a pack declaration, never an analyzer edit."
  echo "   → Annotate '// arch-shape-ok' for a genuine non-route use (rare)."
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

ROGUE_HASH=$(grep -rnE "createHash[[:space:]]*\(" src/analyzers/ src/baseline/ src/allowlist/ 2>/dev/null \
  | grep -v "// fingerprint-helper-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | { [ -n "$ALLOW_FILTER_FP" ] && grep -v $ALLOW_FILTER_FP || cat; })
if [ -n "$ROGUE_HASH" ]; then
  echo "❌ Rule 9 violation: createHash() used outside the canonical fingerprint helpers:"
  echo "$ROGUE_HASH"
  echo "   → Use computeFingerprint or computeCodeFingerprint from src/analyzers/tools/fingerprint.ts."
  echo "   → For new finding kinds, extend src/baseline/finding-identity.ts:identityFor"
  echo "     with a new IdentityInput discriminant rather than hashing inline."
  echo "   → The allowlist module CONSUMES fingerprints (string-compares only) —"
  echo "     it never computes identity. A createHash() inside src/allowlist/ is"
  echo "     almost certainly a shortcut that should route through identityFor."
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
# Sprint 2 (2.6): baseline mode resolution discipline.
# =============================================================================
#
# Baseline mode (`committed-full` | `committed-sanitized` | `ref-based`)
# is picked by exactly one function: `resolveBaselineMode` in
# `src/baseline/modes.ts`. Two adjacent rules keep the contract from
# drifting:
#
#   - Visibility probing (`gh repo view --json visibility`) lives only
#     in `src/baseline/visibility.ts`. Other call sites should ask the
#     resolver, not re-shell to `gh`.
#   - `git worktree` mechanics for ref-based gather live only in
#     `src/baseline/ref-baseline.ts`. Other consumers go through
#     `withRefWorktree` / `gatherFromRef`.
ROGUE_VISIBILITY=$(grep -rnE 'gh repo view[^"]*visibility' src/ 2>/dev/null \
  | grep -v "// visibility-probe-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | grep -v "^src/baseline/visibility.ts:")
if [ -n "$ROGUE_VISIBILITY" ]; then
  echo "❌ Baseline mode rule violation: gh visibility probe outside src/baseline/visibility.ts:"
  echo "$ROGUE_VISIBILITY"
  echo "   → Call detectRepoVisibility() from src/baseline/visibility.ts, or go through"
  echo "     resolveBaselineMode() in src/baseline/modes.ts."
  echo "   → Annotate '// visibility-probe-ok' for justified exceptions (rare)."
  ERRORS=$((ERRORS + 1))
fi

ROGUE_WORKTREE=$(grep -rnE "git[[:space:]]+worktree[[:space:]]+(add|remove)" src/ 2>/dev/null \
  | grep -v "// ref-worktree-ok" \
  | grep -v -E ':[[:space:]]*\*' \
  | grep -v "^src/baseline/ref-baseline.ts:")
if [ -n "$ROGUE_WORKTREE" ]; then
  echo "❌ Baseline mode rule violation: 'git worktree' command outside src/baseline/ref-baseline.ts:"
  echo "$ROGUE_WORKTREE"
  echo "   → Use withRefWorktree() / gatherFromRef() from src/baseline/ref-baseline.ts."
  echo "   → Annotate '// ref-worktree-ok' for justified exceptions (rare)."
  ERRORS=$((ERRORS + 1))
fi

# =============================================================================
# Correctness floor (2.23): the liveness gate stays pack-driven.
# =============================================================================
#
# A pack declares its floor as two pure command builders
# (`correctness.syntaxCheck` / `correctness.affectedTests` in
# src/languages/<id>.ts). The ONE place that invokes those builders — and
# executes the resulting commands with the fail-open/closed + timeout policy —
# is the canonical runner `src/analyzers/correctness/run.ts`. Every surface
# (loop Stop-gate, pre-push, CI) calls `runCorrectnessFloor`, never a pack's
# builder directly. This mirrors Rule 2 (one gather path) + Rule 12 (one query
# point): bypassing the runner means re-implementing the fail-open/timeout
# policy and silently drifting from the pack-driven contract.
ROGUE_FLOOR=$(grep -rnE "\.(syntaxCheck|affectedTests)[[:space:]]*\(" src/ 2>/dev/null \
  | grep -v "// correctness-runner-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | grep -v "^src/analyzers/correctness/")
if [ -n "$ROGUE_FLOOR" ]; then
  echo "❌ Correctness-floor rule violation: a pack's syntaxCheck()/affectedTests() builder"
  echo "   invoked outside the canonical runner src/analyzers/correctness/run.ts:"
  echo "$ROGUE_FLOOR"
  echo "   → Call runCorrectnessFloor() from src/analyzers/correctness/run.ts instead;"
  echo "     it owns command execution + the fail-open/fail-closed + timeout policy."
  echo "   → Annotate '// correctness-runner-ok' for justified exceptions (rare)."
  ERRORS=$((ERRORS + 1))
fi

# =============================================================================
# Custom-check gate (3.0): the one-runner seam stays single-path.
# =============================================================================
#
# A custom check (user-declared `.dxkit/policy.json:checks` OR a pack-declared
# built-in lint gate) is a first-class gate citizen: its failures are
# fingerprinted, baselined, and gated net-new-only exactly like secrets / SAST.
# Both sources normalize to ONE `CustomCheckSpec` (via the adapters in
# src/analyzers/custom-checks/config.ts) and execute through ONE runner
# (`runCustomChecks` in src/analyzers/custom-checks/run.ts), reached by every
# consumer through the ONE gather entry point `resolveCustomCheckSpecs` /
# `gatherCustomCheckFindings` (src/analyzers/custom-checks/gather.ts). Lint is
# therefore the first CONSUMER of the seam, never a parallel path (Rule 2).
#
# SECURITY: the runner executes commands, so they must come only from the repo's
# own committed policy / a pack's built-in lint command — the same trust
# boundary as the repo's npm scripts / CI config. A rogue caller that re-runs
# checks from another source would bypass that boundary.
#
# Guard: `runCustomChecks(` is callable only from the custom-checks module
# itself and the `checks` CLI dry-run (which needs per-check status, not just
# the flattened findings). Every other consumer goes through
# gatherCustomCheckFindings. Annotate '// custom-check-runner-ok' for a
# justified exception (rare).
ROGUE_CHECK_RUNNER=$(grep -rn "runCustomChecks(" src/ 2>/dev/null \
  | grep -v "// custom-check-runner-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | grep -v "^src/analyzers/custom-checks/" \
  | grep -v "^src/checks-cli.ts")
if [ -n "$ROGUE_CHECK_RUNNER" ]; then
  echo "❌ Custom-check rule violation: runCustomChecks() invoked outside the canonical"
  echo "   runner module (src/analyzers/custom-checks/) + the \`checks\` CLI dry-run:"
  echo "$ROGUE_CHECK_RUNNER"
  echo "   → Call gatherCustomCheckFindings() from src/analyzers/custom-checks/gather.ts;"
  echo "     it is the ONE entry point (spec resolution + execution) both the baseline"
  echo "     producer and the guardrail share, so lint stays a consumer not a fork."
  echo "   → Annotate '// custom-check-runner-ok' for a justified exception (rare)."
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
# Allowlist canonical-entry-point discipline (added 2026-05-22).
# =============================================================================
#
# The allowlist module shipped by `src/allowlist/` has two contracts:
#
#   - On-disk IO: `.dxkit/allowlist.json` (committed) and the
#     gitignored sidecar `.dxkit/allowlist-reasons.local.json` are
#     read/written ONLY through `loadAllowlist()` / `saveAllowlist()`
#     in `src/allowlist/file.ts`. Bypassing means schema validation
#     + sidecar merging gets skipped silently; a customer's
#     hand-edited file could pass the guardrail with malformed
#     entries that break later runs.
#
#   - Per-language comment syntax: inline annotation generation
#     reads `LanguageSupport.commentSyntax.lineComment`. A fallback
#     like `?? '//'` would silently produce wrong-language comments
#     for a future pack whose declaration is missing — defeating
#     the whole point of the recipe enforcement layer (the contract
#     test would catch the missing field, but the fallback would
#     mask the failure if it sneaks past the test).
#
# Both checks are scoped tightly so the rules don't accumulate false
# positives in unrelated code.
#
# Annotate `// allowlist-io-ok` (rule 1) or `// comment-syntax-ok`
# (rule 2) on the violating line for justified exceptions (today:
# zero needed).

# Rule 1: no direct allowlist.json IO outside src/allowlist/
ROGUE_ALLOWLIST_IO=$(grep -rnE "['\"](allowlist\.json|allowlist-reasons\.local\.json)['\"]" src/ 2>/dev/null \
  | grep -v "^src/allowlist/" \
  | grep -v "// allowlist-io-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)')
if [ -n "$ROGUE_ALLOWLIST_IO" ]; then
  echo "❌ Allowlist IO bypass: direct allowlist.json reference outside src/allowlist/:"
  echo "$ROGUE_ALLOWLIST_IO"
  echo "   → Use loadAllowlist(cwd) / saveAllowlist(cwd, file) from"
  echo "     src/allowlist/file.ts so schema validation + sidecar merging run."
  echo "   → Annotate '// allowlist-io-ok' for justified exceptions (rare)."
  ERRORS=$((ERRORS + 1))
fi

# Rule 2: no comment-marker fallback literals in src/allowlist/
ROGUE_COMMENT_FALLBACK=$(grep -rnE "(\?\?|\|\|)[[:space:]]*['\"](//|#)['\"]" src/allowlist/ 2>/dev/null \
  | grep -v "// comment-syntax-ok" \
  | grep -v -E ':[[:space:]]*(//|\*)')
if [ -n "$ROGUE_COMMENT_FALLBACK" ]; then
  echo "❌ Allowlist comment-syntax fallback: hardcoded language literal as default:"
  echo "$ROGUE_COMMENT_FALLBACK"
  echo "   → Inline annotation code MUST drive comment markers from"
  echo "     LanguageSupport.commentSyntax.lineComment, not a hardcoded default."
  echo "   → If the language has no commentSyntax, return null / throw — never"
  echo "     fall back to '//' or '#' (defeats the recipe enforcement layer)."
  echo "   → Annotate '// comment-syntax-ok' for justified exceptions (rare)."
  ERRORS=$((ERRORS + 1))
fi

# =============================================================================
# Rule 12: Repo-explore graph queries flow through canonical entry points
# (added 2026-05-26 with the 2.7 graph foundation).
# =============================================================================
#
# Every consumer of the graphify graph artifact at
# `.dxkit/reports/graph.json` reads via `src/explore/load.ts:loadGraph(cwd)`.
# Every graph traversal — caller / callee lookup, community expansion,
# hot-file ranking, feature-keyword expansion — lives in
# `src/explore/queries.ts`. CLI subcommands, the dashboard viz adapter,
# and future graph consumers (2.8 context CLI, 2.8 reachability) MUST
# import from these two files rather than re-implementing.
#
# Four bans enforced below:
#   1. loadGraph() outside src/explore/{load,queries}.ts and the
#      allowed consumer set
#   2. Direct JSON.parse(...graph.json...) outside the canonical loader
#   3. NetworkX-style traversal (graph.neighbors / predecessors /
#      successors) outside src/explore/queries.ts and the Python gather
#      template in src/analyzers/tools/graphify.ts
#   4. Re-implementation of canonical query helpers (function
#      findCallers / findCallees / expandCommunity / hotFiles) outside
#      src/explore/queries.ts
#
# Annotate `// rule12-explore-query-ok: <reason>` for justified
# exceptions (today: zero needed outside the canonical files).

# Rule 12.1: loadGraph() outside the allowed callers
ROGUE_LOAD_GRAPH=$(grep -rnE 'loadGraph\(' src/ --include='*.ts' 2>/dev/null \
  | grep -v '^src/explore/' \
  | grep -v '^src/dashboard/' \
  | grep -v '^src/explore-cli\.ts:' \
  | grep -v 'rule12-explore-query-ok' \
  | grep -v -E ':[[:space:]]*(//|\*)' || true)
if [ -n "$ROGUE_LOAD_GRAPH" ]; then
  echo "❌ Rule 12 violation: loadGraph() called outside canonical consumers:"
  echo "$ROGUE_LOAD_GRAPH"
  echo "   → Allowed callers: src/explore/, src/dashboard/, src/explore-cli.ts."
  echo "   → Annotate '// rule12-explore-query-ok: <reason>' for justified exceptions."
  ERRORS=$((ERRORS + 1))
fi

# Rule 12.2: direct JSON.parse of graph.json outside the canonical loader
ROGUE_GRAPH_PARSE=$(grep -rnE 'JSON\.parse\([^)]*graph\.json' src/ --include='*.ts' 2>/dev/null \
  | grep -v '^src/explore/load\.ts:' \
  | grep -v 'rule12-explore-query-ok' \
  | grep -v -E ':[[:space:]]*(//|\*)' || true)
if [ -n "$ROGUE_GRAPH_PARSE" ]; then
  echo "❌ Rule 12 violation: direct JSON.parse of graph.json outside canonical loader:"
  echo "$ROGUE_GRAPH_PARSE"
  echo "   → Route through loadGraph(cwd) from src/explore/load.ts so the schema-"
  echo "     version migration + structural validation runs."
  ERRORS=$((ERRORS + 1))
fi

# Rule 12.3: NetworkX-style traversal outside the canonical query module.
# The Python gather template in graphify.ts is also allowed (it owns the
# graph extraction; G.neighbors / G.edges / G.number_of_* there are
# producer-side calls, not consumer-side traversal).
ROGUE_GRAPH_TRAVERSAL=$(grep -rnE '(graph|G)\.(neighbors|predecessors|successors)\(' src/ --include='*.ts' 2>/dev/null \
  | grep -v '^src/explore/queries\.ts:' \
  | grep -v '^src/analyzers/tools/graphify\.ts:' \
  | grep -v 'rule12-explore-query-ok' \
  | grep -v -E ':[[:space:]]*(//|\*)' || true)
if [ -n "$ROGUE_GRAPH_TRAVERSAL" ]; then
  echo "❌ Rule 12 violation: graph traversal primitives outside canonical query module:"
  echo "$ROGUE_GRAPH_TRAVERSAL"
  echo "   → All graph traversal lives in src/explore/queries.ts. Add a typed query"
  echo "     function there + import it; never call .neighbors() etc. directly."
  ERRORS=$((ERRORS + 1))
fi

# Rule 12.4: re-implementing canonical query helpers outside queries.ts
ROGUE_QUERY_REIMPL=$(grep -rnE 'function (findCallers|findCallees|expandCommunity|hotFiles)\(' src/ --include='*.ts' 2>/dev/null \
  | grep -v '^src/explore/queries\.ts:' \
  | grep -v 'rule12-explore-query-ok' \
  | grep -v -E ':[[:space:]]*(//|\*)' || true)
if [ -n "$ROGUE_QUERY_REIMPL" ]; then
  echo "❌ Rule 12 violation: re-implementing canonical query helpers outside queries.ts:"
  echo "$ROGUE_QUERY_REIMPL"
  echo "   → Extend src/explore/queries.ts; consumers import from there."
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

  # Same tripwire for the SDK sibling. The publish itself is automatic
  # (publish-dxkit-sdk.yml auto-fires when a bumped version reaches main
  # with green CI) — what a human can still forget is the BUMP. Skipped
  # when no dxkit-sdk@ tag exists yet (first publish rides the train).
  SDK_VERSION=$(node -p "require('./packages/dxkit-sdk/package.json').version" 2>/dev/null || echo "")
  LAST_SDK_TAG=$(git tag --list 'dxkit-sdk@v*' --sort=-v:refname 2>/dev/null | head -1)
  LAST_SDK_VERSION=$(echo "$LAST_SDK_TAG" | sed 's/^dxkit-sdk@v//')

  if [ -n "$LAST_SDK_TAG" ] && [ -n "$SDK_VERSION" ]; then
    SDK_CHANGES=$(git diff --name-only "$LAST_SDK_TAG"...HEAD -- packages/dxkit-sdk/ 2>/dev/null | grep -v '^packages/dxkit-sdk/package\.json$' || true)
    if [ -n "$SDK_CHANGES" ] && [ "$SDK_VERSION" = "$LAST_SDK_VERSION" ]; then
      echo "❌ Release-prep state detected (dxkit ${LAST_DXKIT_VERSION} → ${DXKIT_VERSION})"
      echo "   dxkit-sdk content has changed since ${LAST_SDK_TAG}:"
      echo "$SDK_CHANGES" | sed 's/^/      /'
      echo "   But packages/dxkit-sdk/package.json version is unchanged (${SDK_VERSION})."
      echo "   → Bump packages/dxkit-sdk/package.json (keep SDK_MAJOR in step for a major)"
      echo "     before tagging the dxkit release — the bump merging to main is what"
      echo "     triggers the SDK auto-publish (publish-dxkit-sdk.yml)."
      ERRORS=$((ERRORS + 1))
    fi
  fi
fi

# ─── Rule 13: external-findings ingestion flows through src/ingest ──────────
#
# External-engine findings (Snyk Code, CodeQL, any SARIF) must enter dxkit
# only through the canonical ingest module, so they inherit the one
# fingerprint scheme, dedup, baseline, and graph linking instead of a
# parallel pipeline:
#   - SARIF is parsed only by src/ingest/sarif.ts (the `physicalLocation`
#     walk is the smoking-gun shape of a hand-rolled SARIF parser).
#   - `.dxkit/external/` snapshots are read/written only by
#     src/ingest/snapshot.ts.
# Identity for ingested findings comes from the aggregator (Rule 9), not a
# local hash — already enforced by the createHash rule.

# 13a: no second SARIF parser (physicalLocation outside src/ingest/sarif.ts).
RULE13_SARIF=$(grep -rnE "physicalLocation" src/ 2>/dev/null \
  | grep -v "^src/ingest/sarif.ts:" \
  | grep -v "// ingest-sarif-ok")
if [ -n "$RULE13_SARIF" ]; then
  echo "❌ Rule 13 violation: SARIF parsed outside src/ingest/sarif.ts:"
  echo "$RULE13_SARIF"
  echo "   → Use parseSarif() from src/ingest/sarif.ts; don't hand-roll a SARIF walk."
  echo "   → Annotate '// ingest-sarif-ok' for a justified exception."
  ERRORS=$((ERRORS + 1))
fi

# 13b: no snapshot access outside src/ingest/snapshot.ts.
RULE13_SNAP=$(grep -rnE "\.dxkit/external|'\.dxkit',[[:space:]]*'external'" src/ 2>/dev/null \
  | grep -v "^src/ingest/snapshot.ts:" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | grep -v 'logger\.' \
  | grep -v "// ingest-snapshot-ok")
if [ -n "$RULE13_SNAP" ]; then
  echo "❌ Rule 13 violation: .dxkit/external snapshot accessed outside src/ingest/snapshot.ts:"
  echo "$RULE13_SNAP"
  echo "   → Use readAllSnapshots()/writeSnapshot() from src/ingest/snapshot.ts."
  echo "   → Annotate '// ingest-snapshot-ok' for a justified exception."
  ERRORS=$((ERRORS + 1))
fi

# 13c (Flow M3): the cross-repo flow contract snapshots under `.dxkit/flow/`
# are read/written only by src/analyzers/flow/contract.ts — the mirror of the
# ingest-snapshot confinement. Keeps the served/consumed inventory (and a future
# cross-repo fetch) composing on one primitive rather than drifting per module.
RULE13_FLOW=$(grep -rnE "\.dxkit/flow|'\.dxkit',[[:space:]]*'flow'" src/ 2>/dev/null \
  | grep -v "^src/analyzers/flow/contract.ts:" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | grep -v 'logger\.' \
  | grep -v "// flow-contract-ok")
if [ -n "$RULE13_FLOW" ]; then
  echo "❌ Rule 13 violation: .dxkit/flow contract accessed outside src/analyzers/flow/contract.ts:"
  echo "$RULE13_FLOW"
  echo "   → Use read/writeServed|ConsumedContract() from src/analyzers/flow/contract.ts."
  echo "   → Annotate '// flow-contract-ok' for a justified exception."
  ERRORS=$((ERRORS + 1))
fi

# 13d (Flow 2.28 file-routes): file-convention routing (Next.js App Router,
# SvelteKit, Pages Router) is pack-DECLARED, framework-general in the engine.
# The handler filename (`route`, `+server`) and routing base dirs (`app`,
# `src/app`, `pages/api`) are per-framework facts that MUST come from a pack's
# `httpFlow.fileRoutes` descriptor (Rule 6) — never a literal inside
# src/analyzers/flow/. The shared path algebra in file-routes.ts encodes only
# the framework-GENERAL conventions (route groups, `[param]`, catch-all). A
# hardcoded `'route'`/`'+server'`/`'src/app'`/`'pages/api'` string here would
# re-hardcode the exact Next.js coupling this capability exists to remove.
RULE13_FILEROUTES=$(grep -rnE "'(route|\+server|src/app|pages/api|route\.(ts|js))'" src/analyzers/flow/ 2>/dev/null \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | grep -v "// file-route-ok")
if [ -n "$RULE13_FILEROUTES" ]; then
  echo "❌ Rule 13d violation: hardcoded file-route framework literal in src/analyzers/flow/:"
  echo "$RULE13_FILEROUTES"
  echo "   → Declare handler filename + base dirs in a pack's httpFlow.fileRoutes"
  echo "     (src/languages/<id>.ts); the engine consumes them via the descriptor."
  echo "   → Annotate '// file-route-ok' for a justified exception (rare)."
  ERRORS=$((ERRORS + 1))
fi

# PM-awareness (2.26 → 2.29): a node devDependency install command shown to or
# run by a user MUST match the repo's package manager (pnpm/yarn/bun/npm), or it
# fails the way create-dxkit did on a pnpm repo. The canonical npm form lives in
# ONE of two places — `src/package-manager.ts` (which rewrites it per PM via
# `pmAwareDevInstall`/`addDevPrefix`) and the `TOOL_DEFS` registry (whose
# `install` strings are rendered PM-aware at display time). A raw
# `npm install --save-dev` / `npm i -D` literal anywhere else is a PM-blind
# command string — the class of bug that shipped an npm-only doctor hint + tool
# descriptor on pnpm repos. Route it through `src/package-manager.ts`.
RULE_PM_DEVINSTALL=$(grep -rnE "npm (install|i) (--save-dev|-D)" src/ 2>/dev/null \
  | grep -E '\.ts:' \
  | grep -v "^src/package-manager.ts:" \
  | grep -v "^src/analyzers/tools/tool-registry.ts:" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | grep -v "// pm-aware-ok")
if [ -n "$RULE_PM_DEVINSTALL" ]; then
  echo "❌ PM-awareness violation: raw 'npm install --save-dev' literal outside the PM module:"
  echo "$RULE_PM_DEVINSTALL"
  echo "   → Build the command via pmAwareDevInstall()/addDevCommand() from src/package-manager.ts"
  echo "     so it matches the repo's package manager (pnpm/yarn/bun/npm)."
  echo "   → Annotate '// pm-aware-ok' for a justified exception."
  ERRORS=$((ERRORS + 1))
fi

# One-concept-one-path (2.30): a recurring dogfood class was "one concept
# computed in two independent code paths; a fix lands in one, the sibling still
# misbehaves" (env-in-git count vs per-finding producer; flow config threaded in
# map/gate but not diagnose/detect). Two consolidations, each gated so the
# duplicate can't silently reappear.

# (a) Committed env-file detection has ONE command. `git ls-files .env` lives
#     only in src/analyzers/security/env-files.ts; both the metric count and the
#     per-finding producer read `trackedEnvFiles` from there (so exempting
#     `.env.example` is decided once).
RULE_ENVFILES=$(grep -rnE "git ls-files[[:space:]]+\.env" src/ 2>/dev/null \
  | grep -E '\.ts:' \
  | grep -v "^src/analyzers/security/env-files.ts:" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | grep -v "// env-files-ok")
if [ -n "$RULE_ENVFILES" ]; then
  echo "❌ One-concept violation: 'git ls-files .env' outside src/analyzers/security/env-files.ts:"
  echo "$RULE_ENVFILES"
  echo "   → Read trackedEnvFiles() from src/analyzers/security/env-files.ts (it exempts"
  echo "     .env.example / .env.template via the benign module — decided once)."
  echo "   → Annotate '// env-files-ok' for a justified exception."
  ERRORS=$((ERRORS + 1))
fi

# (b) A single-repo flow surface loads its policy config through ONE entry point
#     (`gatherRepoFlowModel`), so it cannot forget `stripUrlPrefixes` / `specs`.
#     The raw `gatherFlowModel` primitive is reserved for callers that supply
#     config from elsewhere — the flow module itself, the two-ref gate, the
#     cross-repo publish, and the map CLI (which merges CLI + policy specs).
RULE_FLOWGATHER=$(grep -rn "gatherFlowModel(" src/ 2>/dev/null \
  | grep -E '\.ts:' \
  | grep -v "^src/analyzers/flow/gather.ts:" \
  | grep -v "^src/baseline/flow-gate-check.ts:" \
  | grep -v "^src/analyzers/flow/publish.ts:" \
  | grep -v "^src/flow-cli.ts:" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | grep -v "// flow-gather-ok")
if [ -n "$RULE_FLOWGATHER" ]; then
  echo "❌ One-concept violation: raw gatherFlowModel() on a single-repo surface:"
  echo "$RULE_FLOWGATHER"
  echo "   → Use gatherRepoFlowModel(cwd) from src/analyzers/flow/gather.ts — it loads"
  echo "     .dxkit/policy.json:flow so the base-URL strip + specs are always applied."
  echo "   → Annotate '// flow-gather-ok' for a justified explicit-config caller."
  ERRORS=$((ERRORS + 1))
fi

# Model-schema mirror of the flow one-concept rules (Rule 2):
#   (a) raw gatherModelSet() is reserved for explicit-config callers — the
#       model-schema module itself, the two-ref drift gate, and the schema
#       CLI's base-side gather. Every single-repo surface goes through
#       gatherRepoModelSet(cwd), which loads .dxkit/policy.json:schema itself
#       so the configured specs are always applied.
RULE_MODELGATHER=$(grep -rn "gatherModelSet(" src/ 2>/dev/null \
  | grep -E '\.ts:' \
  | grep -v "^src/analyzers/model-schema/gather.ts:" \
  | grep -v "^src/baseline/schema-drift-gate-check.ts:" \
  | grep -v "^src/schema-cli.ts:" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | grep -v "// model-gather-ok")
if [ -n "$RULE_MODELGATHER" ]; then
  echo "❌ One-concept violation: raw gatherModelSet() on a single-repo surface:"
  echo "$RULE_MODELGATHER"
  echo "   → Use gatherRepoModelSet(cwd) from src/analyzers/model-schema/gather.ts — it"
  echo "     loads .dxkit/policy.json:schema so the configured specs are always applied."
  echo "   → Annotate '// model-gather-ok' for a justified explicit-config caller."
  ERRORS=$((ERRORS + 1))
fi

#   (b) the `schema` policy section has ONE reader/writer —
#       src/analyzers/model-schema/config.ts. A second ad-hoc read of
#       policy.json's schema block re-opens the split-config bug class the
#       flow config module closed. (The advisor's presence-probe reads the
#       block's EXISTENCE via readJsonSafe, which this rule doesn't match.)
RULE_SCHEMACONFIG=$(grep -rn "policy.json" src/ 2>/dev/null \
  | grep -E '\.ts:' \
  | grep -E "\.schema\b|\['schema'\]|\"schema\"" \
  | grep -v "^src/analyzers/model-schema/config.ts:" \
  | grep -v -E ':[[:space:]]*(//|\*)' \
  | grep -v "// schema-config-ok")
if [ -n "$RULE_SCHEMACONFIG" ]; then
  echo "❌ One-concept violation: .dxkit/policy.json:schema read outside the config module:"
  echo "$RULE_SCHEMACONFIG"
  echo "   → Route through readSchemaConfig / writeSchemaPolicy in src/analyzers/model-schema/config.ts."
  echo "   → Annotate '// schema-config-ok' for a justified exception."
  ERRORS=$((ERRORS + 1))
fi

# Rule 14 (2.13.1 self-invocation class-fix): generated artifacts invoke the
# dxkit CLI through ONE canonical helper, and every auto-running surface is
# in ONE registry.
#
# What this prevents:
#   A raw `npx vyuh-dxkit ...` literal in a hook body / CI step / doc hint is
#   invisible to the self-invocation registry, so the install flow cannot
#   know the surface needs a project-local dxkit and doctor cannot verify it
#   resolves. That class shipped the loop Stop hook 404-ing on pure-npx
#   installs (the dep was never declared, so `npx vyuh-dxkit` resolved to a
#   non-existent package).
#
# Canonical replacement: dxkitCli('<subcommand>') / DXKIT_CLI from
#   src/self-invocation.ts. New auto-executing surfaces ALSO register in
#   SELF_INVOCATION_SURFACES so requiresResolvableCli() (install + update
#   devDependency wire-up) and `loop doctor` pick them up automatically.
#
# Allowlist rationale:
#   - src/self-invocation.ts itself: this IS the canonical site.
RULE14_SELFINVOKE=$(grep -rn "npx vyuh-dxkit" src/ 2>/dev/null \
  | grep -E '\.ts:' \
  | grep -v "^src/self-invocation.ts:" \
  | grep -v "// self-invocation-ok")
if [ -n "$RULE14_SELFINVOKE" ]; then
  echo "❌ Rule 14 violation: raw 'npx vyuh-dxkit' literal outside src/self-invocation.ts:"
  echo "$RULE14_SELFINVOKE"
  echo "   → Use dxkitCli('<subcommand>') / DXKIT_CLI from src/self-invocation.ts."
  echo "   → Register new auto-running surfaces in SELF_INVOCATION_SURFACES so the"
  echo "     devDependency wire-up + loop doctor cover them."
  echo "   → Annotate '// self-invocation-ok' for a justified exception."
  ERRORS=$((ERRORS + 1))
fi

# AST tree-lifecycle rule (wave-3 class-fix): repo-scale parsing goes through
# the scoped withParsedFile(path, fn), never a raw parseFile loop.
#
# What this prevents:
#   A parsed tree lives on the wasm heap, which the JS GC cannot reclaim —
#   only tree.delete() frees it. A gather that loops parseFile without
#   deleting exhausts the emscripten heap on a large repo (~1,900 files on a
#   real .NET monorepo), after which EVERY parse in the process fails and
#   extraction silently reports the rest of the repo as empty. That class
#   shipped: flow/schema extraction covered ~60% of a 3,235-file repo.
#
# Canonical replacement: withParsedFile(path, fn) in src/ast/parse.ts —
#   parse → fn → delete in finally. parseFile remains for single-file use
#   where the caller owns the delete (annotate '// single-parse-ok').
#
# Allowlist rationale:
#   - src/ast/parse.ts — defines both; withParsedFile calls parseFile.
RULE_TREE_LIFECYCLE=$(grep -rn "parseFile(" src/ 2>/dev/null \
  | grep -E '\.ts:' \
  | grep -v "^src/ast/parse.ts:" \
  | grep -v "withParsedFile(" \
  | grep -v "// single-parse-ok")
if [ -n "$RULE_TREE_LIFECYCLE" ]; then
  echo "❌ Tree-lifecycle violation: raw parseFile() outside src/ast/parse.ts:"
  echo "$RULE_TREE_LIFECYCLE"
  echo "   → Use withParsedFile(path, fn) — it frees the tree's wasm memory in"
  echo "     finally; a raw parseFile loop exhausts the heap on large repos and"
  echo "     kills every later parse in the process."
  echo "   → Annotate '// single-parse-ok' for a justified single-file exception"
  echo "     that owns its tree.delete()."
  ERRORS=$((ERRORS + 1))
fi

# Rule 15 (managed-artifact lifecycle class-fix): a module that WRITES a managed
# ship artifact — a CI workflow (.github/workflows), a git hook (.githooks), or
# the devcontainer (.devcontainer) — must do so through src/ship-installers.ts,
# whose surfaces are registered in src/managed-artifacts.ts:MANAGED_SHIP_SURFACES.
#
# What this prevents:
#   These artifacts are NOT tracked in manifest.files, so their update-refresh
#   and uninstall-removal are driven by the managed-artifact registry. A new
#   installer that writes a workflow/hook/devcontainer directly (bypassing the
#   registry) silently skips `update` (never refreshed) and/or `uninstall`
#   (never removed) — the exact drift the deep-SAST refresh workflow shipped
#   with (installed + uninstalled but never refreshed by update).
#
# The check: any src file that BOTH writes (writeFileSync/copyFileSync) AND
# constructs a ship-dir path, outside the allowlist. Pure readers (doctor,
# detection, enforcement probes) don't write, so they never match.
#
# Allowlist rationale:
#   - src/ship-installers.ts — the canonical writer (every install* lives here).
#   - src/cli.ts — the init orchestrator (writes the manifest; references
#     workflow paths in help/logging, not a bypass installer).
#   - src/uninstall/index.ts — the reverser (writes settings.json/package.json
#     reversals; references .githooks for the core.hooksPath unset).
RULE15_MANAGED_WRITE=""
for f in $(grep -rlE "writeFileSync|copyFileSync|cpSync" src --include='*.ts' 2>/dev/null); do
  case "$f" in
    src/ship-installers.ts | src/cli.ts | src/uninstall/index.ts) continue ;;
  esac
  grep -q "// managed-write-ok" "$f" && continue
  if grep -qE "\.github/workflows|'\.github', 'workflows'|'\.githooks'|\.githooks/|'\.devcontainer'|\.devcontainer/" "$f"; then
    RULE15_MANAGED_WRITE="$RULE15_MANAGED_WRITE $f"
  fi
done
if [ -n "$RULE15_MANAGED_WRITE" ]; then
  echo "❌ Rule 15 violation: a module writes a managed ship artifact (.github/workflows,"
  echo "   .githooks, .devcontainer) outside src/ship-installers.ts:"
  for f in $RULE15_MANAGED_WRITE; do echo "     $f"; done
  echo "   → Move the write into src/ship-installers.ts and register the surface in"
  echo "     src/managed-artifacts.ts:MANAGED_SHIP_SURFACES so update + uninstall cover it."
  echo "   → Annotate '// managed-write-ok' for a justified exception (e.g. read-only use)."
  ERRORS=$((ERRORS + 1))
fi

# ─── Rule 16: capability-registry parity (block-if-unregistered) ────────────
# Every top-level CLI command MUST be registered in the capability registry
# (the COMMANDS descriptor data in src/discovery/command-defs.ts, re-exported by
# src/discovery/commands.ts). That registry is the single source of truth driving
# the help index, doctor advisor mode, the skill mapping, and generated docs — so
# a command that skips registration is undiscoverable. Enforce bidirectional
# parity between the top-level switch cases in src/cli.ts and the registry's
# ids + aliases. (Richer checks — user-facing field completeness, skill-file
# existence, synthetic-injection — live in test/discovery-playbook.test.ts.)
RULE16_CLI_CASES=$(grep -oE "^    case '[a-z][a-z-]*':" src/cli.ts | sed -E "s/^    case '([a-z-]+)':/\1/" | sort -u)
RULE16_REG_TOKENS=$( { \
  grep -oE "id: '[a-z][a-z-]*'" src/discovery/command-defs.ts | sed -E "s/id: '([a-z-]+)'/\1/"; \
  grep -oE "aliases: \[[^]]*\]" src/discovery/command-defs.ts | grep -oE "'[a-z-]+'" | tr -d "'"; \
} | sort -u)
RULE16_UNREGISTERED=$(comm -23 <(printf '%s\n' "$RULE16_CLI_CASES") <(printf '%s\n' "$RULE16_REG_TOKENS"))
RULE16_ORPHANED=$(comm -13 <(printf '%s\n' "$RULE16_CLI_CASES") <(printf '%s\n' "$RULE16_REG_TOKENS"))
if [ -n "$RULE16_UNREGISTERED" ]; then
  echo "❌ Rule 16 violation: CLI command(s) with no CapabilityDescriptor in src/discovery/command-defs.ts:"
  for c in $RULE16_UNREGISTERED; do echo "     $c"; done
  echo "   → Add a descriptor (mirror an existing entry). Discoverability is part of a"
  echo "     command's definition of done: the registry drives the help index, doctor"
  echo "     advisor mode, the skill mapping, and generated docs. Machine-invoked"
  echo "     commands register with audience: 'internal' (still registered, not hidden)."
  ERRORS=$((ERRORS + 1))
fi
if [ -n "$RULE16_ORPHANED" ]; then
  echo "❌ Rule 16 violation: registry lists command token(s) with no dispatch in src/cli.ts:"
  for c in $RULE16_ORPHANED; do echo "     $c"; done
  echo "   → Remove the stale entry/alias, or add its switch case in src/cli.ts."
  ERRORS=$((ERRORS + 1))
fi

# ─── Side-ref push discipline (Rule 2 / Rule 11 for workflow templates) ─────
# Publishing files to a dxkit side ref (dxkit-baselines, dxkit-reports, …) has
# ONE implementation: src/baseline/anchor-publish.ts, reached from a workflow
# via the CLI (`baseline publish` / `report snapshot`). A workflow template
# that re-implements the push inline — the `git checkout -B` + `git push
# --force` shape — forks the unchanged-skip/self-heal/idempotence semantics
# into untested bash (the exact divergence the branch-transport refresh
# shipped with). Plain `git push` to the DEFAULT branch (the `tree` transport,
# deep-SAST snapshot commits) is a tracked-file commit, not a side-ref
# publish, and stays allowed.
SIDEREF_INLINE_PUSH=""
for f in src-templates/.github/workflows/*.yml; do
  hits=$(grep -nE "git checkout -B|git push (--force|-f)( |$)" "$f" 2>/dev/null | grep -v "# side-ref-push-ok" || true)
  if [ -n "$hits" ]; then
    SIDEREF_INLINE_PUSH="$SIDEREF_INLINE_PUSH $f"
  fi
done
if [ -n "$SIDEREF_INLINE_PUSH" ]; then
  echo "❌ Side-ref push violation: a workflow template re-implements the side-ref publish inline:"
  for f in $SIDEREF_INLINE_PUSH; do echo "     $f"; done
  echo "   → Publish through the CLI (\`baseline publish\` / \`report snapshot\`), which routes"
  echo "     through the ONE writer src/baseline/anchor-publish.ts (unchanged-skip + self-heal"
  echo "     + non-fast-forward retry live there, tested). Annotate '# side-ref-push-ok' on the"
  echo "     line for a justified exception."
  ERRORS=$((ERRORS + 1))
fi

# ─── Contract-source discipline: artifact formats live in the registry ──────
# A declared contract artifact (Postman collection, Pact contract, HAR
# capture, …) is parsed by exactly one reader module under
# src/analyzers/flow/contract-sources/. A format kind-literal appearing
# elsewhere in src/ is the smoking-gun shape of a second parser (or a
# hardcoded kind dispatch) growing outside the registry. 'http'/'openapi'
# are too common as words to grep; the distinctive kinds are the tripwire.
ROGUE_FORMAT=$(grep -rnE "'(postman|pact|har)'|\"(postman|pact|har)\"" src/ 2>/dev/null \
  | grep -v "^src/analyzers/flow/contract-sources/" \
  | grep -v -E ':[0-9]+:[[:space:]]*(//|\*)' \
  | grep -v "// contract-source-ok" || true)
if [ -n "$ROGUE_FORMAT" ]; then
  echo "❌ Contract-source violation: artifact-format literal outside the reader registry:"
  echo "$ROGUE_FORMAT"
  echo "   → Formats are registry entries (CONTRACT_SOURCE_READERS). Extend the"
  echo "     reader module or add a new one + one entry; never dispatch on a"
  echo "     format kind elsewhere. Annotate '// contract-source-ok' for"
  echo "     justified exceptions (docs strings, tests fixtures)."
  ERRORS=$((ERRORS + 1))
fi

# ─── Extension-runner discipline (mirror of Rule 17's custom-check gate) ────
# runExtension EXECUTES repo-declared commands. It is callable only from
# src/extensions/ (the orchestrator's own modules) and the extensions CLI —
# every other consumer reads committed snapshots via snapshot.ts. A second
# call site is how "gates execute extensions" ships by accident.
ROGUE_EXT_EXEC=$(grep -rnE "runExtension[[:space:]]*\(" src/ 2>/dev/null \
  | grep -v "// extension-runner-ok" \
  | grep -v "^src/extensions/" \
  | grep -v "^src/extensions-cli.ts" || true)
if [ -n "$ROGUE_EXT_EXEC" ]; then
  echo "❌ Extension-runner violation: runExtension() called outside the orchestrator:"
  echo "$ROGUE_EXT_EXEC"
  echo "   → Execution happens at refresh time only (extensions refresh / the"
  echo "     on-merge workflow). Gates and reports read committed snapshots via"
  echo "     src/extensions/snapshot.ts. Annotate '// extension-runner-ok' for"
  echo "     justified exceptions (rare)."
  ERRORS=$((ERRORS + 1))
fi

# loadPluginDefinition executes a committed plugin module IN-PROCESS. The
# loader is confined to src/extensions/plugin-host.ts (createRequire is its
# smoking-gun shape); every other consumer goes through loadPluginDefinition /
# loadFlowPluginOverlay so the trust gating (--untrusted disable, snapshot
# fallback, disclosure collection) cannot be bypassed by a second loader.
ROGUE_PLUGIN_LOAD=$(grep -rnE "createRequire[[:space:]]*\(" src/ 2>/dev/null \
  | grep -v "// plugin-host-ok" \
  | grep -v "^src/extensions/plugin-host.ts" || true)
if [ -n "$ROGUE_PLUGIN_LOAD" ]; then
  echo "❌ Plugin-host violation: createRequire() outside the plugin host:"
  echo "$ROGUE_PLUGIN_LOAD"
  echo "   → Rung-4 plugin modules load ONLY via src/extensions/plugin-host.ts"
  echo "     (loadPluginDefinition / loadFlowPluginOverlay) — the one place the"
  echo "     trust tier is enforced. Annotate '// plugin-host-ok' for justified"
  echo "     non-plugin uses of createRequire (rare)."
  ERRORS=$((ERRORS + 1))
fi

# ─── Rule 18 (SDK boundary): the frozen extension surface stays one-way ─────
# The frozen surface lives in packages/dxkit-sdk; the main package depends on
# it and re-exports. Two invariants keep the freeze real:
#
# (a) The SDK is SELF-CONTAINED. Nothing under packages/dxkit-sdk/src may
#     import dxkit internals (relative escapes, the main package) or node
#     builtins — the SDK is types + pure helpers, so an import beyond
#     'web-tree-sitter' or a same-package relative path means internals are
#     leaking into the frozen surface.
SDK_ROGUE_IMPORTS=$(grep -rnE "(from '[^']+'|require\()" packages/dxkit-sdk/src/ 2>/dev/null \
  | grep -v "// rule18-sdk-ok" \
  | grep -vE "from '\./" \
  | grep -v "from 'web-tree-sitter'" || true)
if [ -n "$SDK_ROGUE_IMPORTS" ]; then
  echo "❌ Rule 18 violation: packages/dxkit-sdk imports outside the frozen surface:"
  echo "$SDK_ROGUE_IMPORTS"
  echo "   → The SDK is self-contained (types + pure helpers). If the surface needs"
  echo "     a new concept, MOVE it into the SDK and re-export from the main package"
  echo "     — never import main-package internals into the SDK."
  echo "   → Annotate '// rule18-sdk-ok' for justified exceptions (rare)."
  ERRORS=$((ERRORS + 1))
fi

# (b) Frozen names have ONE definition. A re-declaration of a frozen type or
#     helper in src/ forks the concept the SDK froze (the main package must
#     import + re-export instead). Line-start declarations only — import
#     braces and local helpers with coincidental names don't match.
FROZEN_REDECL=$(grep -rnE "^(export )?(interface|type) (HttpFlowSupport|FileRouteSupport|ModelSchemaSupport|GrammarShape|GrammarModelShape|ResolvedCall|WireContractDoc|WireInventoryDoc|WireFindingsDoc|WireExportReceipt|ExtensionManifest|ContributionKind|ContractSourceReader|ContractSourceParse|ContractSide|RawConsumedCall|RawServedRoute|DxkitExtensionDefinition|HttpFlowDialect|ExtensionPluginSpec|IntegrationVerifierContext|VerifierFlowContext)\b" src/ 2>/dev/null \
  | grep -v "// rule18-sdk-ok" || true)
FROZEN_REIMPL=$(grep -rnE "^export (async )?function (normalizePath|normalizeMethod|bindingKey|isCatchAllPath|catchAllStaticPrefix|walk|defineExtension)\(|^export const (ANY_METHOD|CATCHALL|WIRE_SCHEMA_IDS|SDK_MAJOR)\b" src/ 2>/dev/null \
  | grep -v "// rule18-sdk-ok" || true)
if [ -n "$FROZEN_REDECL$FROZEN_REIMPL" ]; then
  echo "❌ Rule 18 violation: a frozen SDK name is re-declared in src/:"
  [ -n "$FROZEN_REDECL" ] && echo "$FROZEN_REDECL"
  [ -n "$FROZEN_REIMPL" ] && echo "$FROZEN_REIMPL"
  echo "   → The one definition lives in packages/dxkit-sdk. Import it from"
  echo "     '@vyuhlabs/dxkit-sdk' and re-export; a second definition is the"
  echo "     drift class the freeze exists to kill."
  echo "   → Annotate '// rule18-sdk-ok' for justified exceptions (rare)."
  ERRORS=$((ERRORS + 1))
fi

# ── init finishing-arc guard ──────────────────────────────────────────────
# `init --full` / `--claude-loop` / `--with-hooks` / `--with-ci` now runs the
# finishing arc: REAL scanner installs + a baseline scan. Inside a test or CI
# workflow that isn't specifically exercising the arc, that pollutes the runner
# (installed tools flip skipIf-gated integration tests from skip→run) and burns
# minutes. Such invocations MUST pass --no-finish. Annotate '# init-arc-ok' /
# '// init-arc-ok' on the line for a test that genuinely drives the arc.
INIT_ARC=$(grep -rnE "('init',[^)]*'(--full|--claude-loop|--with-hooks|--with-ci|--with-precommit-hook)'|(vyuh-dxkit|index\.js.?) init [^\`]*(--full|--claude-loop|--with-hooks|--with-ci))" test/ .github/ 2>/dev/null \
  | grep -v -- "--no-finish" \
  | grep -vE "expect\(|toContain|toEqual|not\.to|name: |init-arc-ok" || true)
if [ -n "$INIT_ARC" ]; then
  echo "❌ init finishing-arc guard: a test/workflow runs init with a baseline-consuming"
  echo "   flag but no --no-finish (the arc installs real scanners + scans a baseline,"
  echo "   polluting the runner + flipping skipIf-gated integration tests):"
  echo "$INIT_ARC"
  echo "   → Add --no-finish, or annotate '# init-arc-ok' if the test drives the arc."
  ERRORS=$((ERRORS + 1))
fi

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "Architecture checks failed. See CLAUDE.md for rules."
  exit 1
fi
