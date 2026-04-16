# Contributing to DXKit

Thanks for your interest in improving `@vyuhlabs/dxkit`. DXKit is an
analyzer-and-scaffolder for any repo: it runs deterministic analyses (health,
security, test gaps, code quality, dev activity) against any codebase, and
separately generates `.claude/` agents, commands, skills, and rules tuned to
whatever language and framework you're working in.

## Repo layout

```
dxkit/
├── src/
│   ├── cli.ts                      # CLI entry, dispatches all subcommands
│   ├── detect.ts                   # Stack detection (languages, frameworks, tools)
│   ├── types.ts                    # DetectedStack, ToolRequirement, WriteResult
│   ├── generator.ts, files.ts, ... # Scaffolding machinery
│   ├── analyzers/                  # Analyzer core — the bulk of recent work
│   │   ├── health.ts               # Health orchestrator
│   │   ├── scoring.ts              # Dimension formulas
│   │   ├── security/, tests/, quality/, developer/
│   │   ├── docs/, maintainability/, dx/     # Shallow-only dimensions
│   │   └── tools/                  # Tool runners, registry, exclusions,
│   │                               # coverage, suppressions, parallel
│   └── lib.ts                      # Programmatic library export
├── src-templates/                  # SOURCE OF TRUTH for shipped .claude/ content
│   ├── .claude/                    # agents, commands, skills, rules
│   └── ...                         # configs, Makefile, CLAUDE.md.template, etc.
├── scripts/
│   ├── copy-templates.js           # Build step: src-templates/ → templates/
│   ├── check-architecture.sh       # Pre-commit + CI: enforce CLAUDE.md rules
│   ├── check-slop.sh               # Pre-commit (cached) + CI (vs base branch)
│   └── check-coverage.sh           # Pre-push + CI: coverage threshold
├── templates/                      # Build output (gitignored, shipped in tarball)
└── test/                           # Vitest tests + fixtures
    ├── *.test.ts                   # Unit tests
    └── integration/analyzers.test.ts  # Integration: analyzers on a temp repo
```

`templates/` is generated — never edit it directly. Edit `src-templates/`
and run `npm run build`.

## Local development

```bash
nvm use                # picks up .nvmrc (Node 22)
npm install            # installs deps and sets up husky hooks
npm run build          # copies src-templates/ → templates/ and runs tsc
npm test               # vitest in watch mode
npm run test:run       # build + vitest run (one-shot, includes integration)
npm run test:coverage  # build + vitest run --coverage (~34s, what pre-push runs)
npm run test:integration   # only test/integration/** (~33s alone)
npm run lint           # eslint
npm run format         # prettier --write .
```

The first `npm install` registers husky hooks automatically:

- **pre-commit:**
  1. `scripts/check-architecture.sh` — enforces CLAUDE.md's 5 architecture rules
  2. `scripts/check-slop.sh` — blocks new `console.log`, `: any`, `debugger;`,
     committed `.pyc`/`.swp`, etc. Add `// slop-ok` or `# slop-ok` inline to
     suppress individual lines.
  3. `lint-staged` — `eslint --fix` and `prettier --write` on staged files
  4. `tsc --noEmit` — typecheck the whole project
- **pre-push:**
  1. `npm run build` — ensure `dist/` is current
  2. `vitest run --coverage` — full suite + coverage report
  3. `scripts/check-coverage.sh` — fails if line coverage below threshold
     (default `DXKIT_COVERAGE_THRESHOLD=50`; set the env var to override
     locally)

CI (`.github/workflows/ci.yml`) on every PR runs the same checks the local
hooks run, plus:

- Lint with `--max-warnings 0`
- Slop check in "vs base branch" mode (`DXKIT_SLOP_BASE=origin/<base_ref>`),
  so `--no-verify` can't ship code that introduces slop
- `npm pack --dry-run`

Anything the local hooks let through, CI catches.

To try the analyzers against the repo itself:

```bash
vyuh-dxkit tools install --yes         # first-time: install cloc, gitleaks, etc.
node dist/index.js health --detailed
node dist/index.js test-gaps
node dist/index.js quality
```

To try `init` against a sample repo:

```bash
mkdir /tmp/dxkit-smoke && cd /tmp/dxkit-smoke && git init -q
node ~/projects/dxkit/dist/index.js init --detect
ls .claude/
```

## Adding a new agent

1. Create a markdown file in `src-templates/.claude/agents/<name>.md` (or in
   `agents-available/` if it should be opt-in).
2. Use the existing agents as a structural reference — frontmatter with
   `name`, `description`, `tools`, plus the system prompt body.
3. Run `npm run build` and verify the new file lands in `templates/.claude/agents/`.
4. Add an entry to `CHANGELOG.md` under `[Unreleased]`.

## Adding a new command

1. Create the file in `src-templates/.claude/commands/<name>.md`. Use the
   `.md.template` extension if the command body needs variable substitution
   at `init` time (see `template-engine.ts` for available variables).
2. Build and confirm it appears in `templates/.claude/commands/`.

## Adding a new rule (path-scoped)

1. Add a file under `src-templates/.claude/rules/<lang-or-framework>/<name>.md`.
2. Rules are matched by `detect.ts` based on what the target repo contains —
   if you're adding rules for a brand-new framework, add detection logic there
   too.

## Adding analyzer functionality

### Adding a new tool to the registry

1. Define the tool in `src/analyzers/tools/tool-registry.ts` under `TOOL_DEFS`:
   binaries to look for, install commands per platform (macos/linux/windows),
   `for: 'node' | 'python' | ...`, `layer: 'universal' | 'language' | 'optional'`.
2. If the tool is a Node package without a CLI binary (e.g. a vitest plugin),
   set `nodePackage: '@scope/pkg'` instead of listing `binaries`.
3. Add it to `buildRequiredTools()` in the same file so the detected stack
   picks it up.
4. Write a gather function that calls `findTool()` / `runRegisteredTool()` —
   never hardcode binary paths.

### Adding a new analyzer dimension

Today's shape: one directory under `src/analyzers/<name>/` with `types.ts`,
`gather.ts`, `scoring.ts` (or delegate to `../scoring.ts`), `actions.ts`,
`detailed.ts`, and `index.ts`. Wire the entry function into `cli.ts`.

### Adding a new language

**Work in progress.** The pattern for onboarding a new language is being
consolidated into a single `LanguageSupport` interface (one file per
language in `src/languages/`) as part of Phase 10d.1.6. Until that lands,
adding a language requires touching ~5-9 files across `detect.ts`,
`tool-registry.ts`, `tests/gather.ts`, `tests/import-graph.ts`,
`tools/coverage.ts`, and creating a `tools/<lang>.ts` runner. If you need
to add a language before 10d.1.6 lands, open an issue first.

## Testing changes

Tests live in `test/` and use [Vitest](https://vitest.dev/). Three kinds:

- **Unit tests** (`test/*.test.ts`): exercise pure functions and single
  modules against fixtures or temp directories. Fast (<3s for the whole
  unit suite). Examples: `detect.test.ts`, `scoring.test.ts`,
  `coverage.test.ts`, `import-graph.test.ts`, `suppressions.test.ts`.
  Add fixtures under `test/fixtures/` when teaching `detect.ts` about a new
  language or framework.
- **Analyzer integration test** (`test/integration/analyzers.test.ts`):
  creates a minimal temp repo once, runs all 5 analyzers against it in
  `beforeAll`, and shares the reports across assertions. This is what
  gives us coverage of the shell-out code paths (gitleaks, jscpd, eslint,
  npm audit). ~18s. Included in the default suite.
- **CLI integration test** (`test/cli-init.test.ts`): builds the CLI and
  runs it against a temp directory, asserting on the files `init` writes.
  Use this when changing the generator.

Run the suite:

```bash
npm test                   # watch mode
npm run test:run           # one-shot (build + full suite)
npm run test:coverage      # + coverage + threshold check (~34s)
npm run test:integration   # only test/integration/** (~33s alone)
```

Integration tests require a built CLI — `npm run test:run` and
`npm run test:coverage` build automatically. `npm test` (watch mode) does
not; build manually if you're editing the CLI binary.

### Coverage expectations

- Keep dxkit's own line coverage above `DXKIT_COVERAGE_THRESHOLD` (default 50%).
  The pre-push hook and CI both enforce this.
- New analyzer modules should have unit tests before shipping — see the
  patterns in `test/scoring-dimensions.test.ts` (pure scoring), `test/
gather-tests.test.ts` (filesystem fixtures), and `test/actions-detailed.
test.ts` (report transformers).
- The integration test exercises the end-to-end pipeline; don't mock the
  analyzer internals in it. If you need isolated coverage for a gather
  function, write a unit test that drives the specific parser instead.

## Releasing

Releases are handled by the maintainers via GitHub Releases, which trigger
the publish workflow. Contributors do not need to bump versions in PRs.

## Code style

- **Prettier** is the source of truth for formatting. Run `npm run format`
  before you commit, or let the pre-commit hook handle it.
- **ESLint** runs with `--max-warnings 0` in CI. Fix anything `npm run lint`
  reports — don't suppress with eslint-disable comments unless there's a
  real reason and you note it inline.
- **TypeScript** strict mode is on. `npm run typecheck` must pass.
- **No new runtime dependencies** without discussion — DXKit aims to stay
  zero-dep so it installs fast via `npx`.

A `.git-blame-ignore-revs` file is in the repo root to mask large
formatting commits from `git blame`. Configure your local git once:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

GitHub's blame view honors this file automatically.
