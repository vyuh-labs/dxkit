# CLAUDE.md — DXKit Development Rules

## Architecture Rules

### 1. Tool invocation goes through the registry

Every external tool (cloc, gitleaks, semgrep, graphify, jscpd, ruff, etc.) MUST be:

- **Defined** in `src/analyzers/tools/tool-registry.ts` (TOOL_DEFS)
- **Detected** via `findTool(TOOL_DEFS.xxx, cwd)` — never hardcode binary paths
- **Installed** via `vyuh-dxkit tools install` — never ad-hoc npx/pip calls

Builtins (grep, find, wc, git, node) are exempt — they're always available.

### 2. Never duplicate tool invocation logic

Each tool has ONE gather function (e.g., `gatherGraphifyMetrics` in `tools/graphify.ts`).
If another module needs that tool's output, it MUST call the existing function.
Do NOT rewrite the command string, JSON parsing, or error handling in a new file.

**Bad**: Copy-pasting the graphify Python script into parallel.ts
**Good**: Calling `gatherGraphifyMetrics()` from parallel.ts

### 3. Language facts come from detect.ts

Anything that varies by language (semgrep rulesets, file extensions, test patterns)
MUST be derived from `DetectedStack.languages`, not hardcoded per-analyzer.

### 4. Exclusions come from exclusions.ts

Directory exclusions (node_modules, dist, vendor, etc.) have ONE source of truth:
`src/analyzers/tools/exclusions.ts`. Do not hardcode exclusion lists anywhere else.

### 5. Prefer established tools over custom parsers

Before writing a regex or grep pattern, check if an established tool handles it:

- Secrets → gitleaks (not grep)
- SAST → semgrep (not grep)
- Line counts → cloc (not wc)
- AST → graphify (not regex)
- Duplicates → jscpd (not custom)
- CVSS scoring → `src/analyzers/tools/cvss-v4.ts` (ported from FIRST's reference)

Our code only stitches tools together and computes scores.

### 6. Language capabilities live in one file per language

Every language-specific concern (detection, tool list, semgrep rulesets,
coverage parsing, import extraction/resolution, metric gathering, lint
severity mapping) lives in a single `LanguageSupport` implementation in
`src/languages/{python,typescript,go,rust,csharp}.ts`. Dispatch everywhere
goes through `detectActiveLanguages()` or `getLanguage()` — never
per-language `if (stack.python)` chains in report code.

Reports, analyzers, and tool registries **must not** grow language-specific
branches. If you find yourself writing one, the right answer is almost
always to add the capability to `LanguageSupport` and let the pack provide it.

## Build & Test

```bash
npm run build        # TypeScript → dist/
npm run test:run     # Vitest (39 tests)
npm run lint         # ESLint
npm run format:check # Prettier
```

Pre-commit hooks (husky + lint-staged) run eslint + prettier + typecheck on staged files.

## CLI Commands

```bash
vyuh-dxkit health [path]          # 6-dimension health score
vyuh-dxkit vulnerabilities [path] # Deep security scan
vyuh-dxkit test-gaps [path]       # Test coverage gaps
vyuh-dxkit quality [path]         # Code quality + slop score
vyuh-dxkit dev-report [path]      # Developer activity
vyuh-dxkit tools [list|install]   # Tool status & installation
```

## Key Files

- `src/detect.ts` — stack detection (languages, frameworks, tools)
- `src/types.ts` — DetectedStack, ToolRequirement
- `src/languages/types.ts` — `LanguageSupport` interface (the contract)
- `src/languages/{python,typescript,go,rust,csharp}.ts` — one file per language
- `src/languages/index.ts` — `LANGUAGES` registry, `getLanguage`, `detectActiveLanguages`
- `src/analyzers/tools/tool-registry.ts` — tool definitions, detection, install
- `src/analyzers/tools/exclusions.ts` — centralized exclusion paths
- `src/analyzers/tools/osv.ts` — OSV.dev severity enrichment (session cache + offline fallback)
- `src/analyzers/tools/cvss-v4.ts` — CVSS v4.0 base-score calculator (FIRST reference port)
- `src/analyzers/health.ts` — health orchestrator (async, `Promise.all` over packs)
- `src/analyzers/{security,tests,quality,developer}/` — deep analyzers
