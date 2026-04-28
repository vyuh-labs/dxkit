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
severity mapping, init-scaffold metadata) lives in a single
`LanguageSupport` implementation in
`src/languages/{python,typescript,go,rust,csharp,kotlin,java}.ts`. Dispatch everywhere
goes through `detectActiveLanguages()` / `activeLanguagesFromStack()` /
`activeLanguagesFromFlags()` / `getLanguage()` — never per-language
`if (stack.languages.python)` chains in report code.

Reports, analyzers, generators, and tool registries **must not** grow
language-specific branches. If you find yourself writing one, the right
answer is almost always to add the capability to `LanguageSupport` and
let the pack provide it.

#### LP-recipe enforcement (Phase 10i.0-LP / 10f.4)

Three layers run pre-commit + CI to keep this rule honest:

1. **`scripts/check-architecture.sh`** — greps for hardcoded `IF_<LANG>`
   references, direct `config.languages.<id>` lookups outside the
   registry-bridge files, and hardcoded `<lang>.md` rule-file strings.
2. **`test/languages-contract.test.ts`** — for every `LanguageSupport`,
   verifies metadata completeness (`permissions`, `cliBinaries`,
   `defaultVersion`, `projectYamlBlock`) and `tools[]` ↔ source-call
   parity (closes D009).
3. **`test/recipe-playbook.test.ts`** — synthetic 6th-pack injection
   test. Confirms each pack-iterating consumer (generator, doctor,
   detect, project-yaml, constants, coverage, generic, grep-secrets,
   tool-registry) picks up a hypothetical new pack's contributions.
   Catches "the architecture stopped being pack-driven" empirically.

Adding a new language pack is a one-command scaffold + filling in TODOs:
`npm run new-lang <id> "<displayName>"`. See `CONTRIBUTING.md` "Adding a
new language" for the full walkthrough.

## Release procedure

**Every release goes through the CI pipeline. No exceptions.** Local
`npm publish` is blocked by `scripts/require-ci.js` (wired as the
`prepublishOnly` hook) and additionally disabled by
`publishConfig.provenance: true`, which requires an OIDC token that
only exists inside GitHub Actions.

Sequence for a new release:

1. Work on a `feat/<phase-or-change>` branch.
2. Open a PR against `main`. CI must pass (typecheck, lint, format, tests, coverage, architecture rules, slop check, `npm pack --dry-run`).
3. Merge via the GitHub UI — not a local `git push`. Branch protection on `main` enforces this.
4. In the PR (or a follow-up), bump `package.json` + `package-lock.json` + add a `CHANGELOG.md` entry for the new version.
5. After the release commit is on `main` and CI is green there:

   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```

6. Create a GitHub Release from the tag. This fires `.github/workflows/publish.yml`, which preflights:
   - tag `vX.Y.Z` matches `package.json` version `X.Y.Z`
   - tagged commit is reachable from `origin/main` (no feature-branch tags)
   - the `CI` workflow succeeded on the tagged commit SHA
   - `X.Y.Z` is not already on npm

   Only then does it `npm pack` + `npm publish --provenance` + verify the
   registry shasum matches the locally built tarball. The tarball is
   archived as a workflow artifact for 90 days.

**Why this exists**: the v2.2.0 release shipped from a local
`npm publish` that raced the CI-driven one (CI lost with 403 — version
already taken). The code on npm matched main byte-for-byte, but the
release path was unauditable and provenance was absent. Tracked
internally as D015.

**Never run `npm publish` locally.** The guard will stop you with a
clear error message; don't try to work around it.

## Build & Test

```bash
npm run build        # TypeScript → dist/
npm run test:run     # Vitest (~850 tests, ~2 min wall-clock with cross-ecosystem matrix)
npm run lint         # ESLint
npm run format:check # Prettier
npm run new-lang <id> "<displayName>"  # Scaffold a new language pack (LP.7 / 10f.4)
```

Pre-commit hooks (husky + lint-staged) run eslint + prettier + typecheck on staged files,
plus `check-architecture.sh` (CLAUDE.md rules + LP-recipe enforcement),
`check-slop.sh`, and `check-cross-ecosystem-coverage.sh`.

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
- `src/types.ts` — `LanguageId` union + `DetectedStack` (`languages: Record<LanguageId, boolean>` post-10f.4) + `ToolRequirement`
- `src/languages/types.ts` — `LanguageSupport` interface (the contract)
- `src/languages/{python,typescript,go,rust,csharp,kotlin,java}.ts` — one file per language
- `src/languages/index.ts` — `LANGUAGES` registry; `getLanguage`, `detectActiveLanguages`, `activeLanguagesFromStack`, `activeLanguagesFromFlags`, `allSourceExtensions`, `allTestFilePatterns`, `splitTestFilePatterns`
- `src/analyzers/tools/tool-registry.ts` — tool definitions, detection, install
- `src/analyzers/tools/exclusions.ts` — centralized exclusion paths
- `src/analyzers/tools/osv.ts` — OSV.dev severity enrichment (session cache + offline fallback)
- `src/analyzers/tools/cvss-v4.ts` — CVSS v4.0 base-score calculator (FIRST reference port)
- `src/analyzers/health.ts` — health orchestrator (async, `Promise.all` over packs)
- `src/analyzers/{security,tests,quality,developer}/` — deep analyzers
- `scripts/scaffold-language.js` — `npm run new-lang <id> "<displayName>"` recipe scaffolder (LP.7 / 10f.4)
- `scripts/check-architecture.sh` — pre-commit + CI: enforces CLAUDE.md rules + LP-recipe rules
- `test/languages-contract.test.ts` — pack contract tests (D009 closure)
- `test/recipe-playbook.test.ts` — synthetic 6th-pack playbook (LP-architecture regression guard)
