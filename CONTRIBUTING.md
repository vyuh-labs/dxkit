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
npm ci                 # bit-exact install from package-lock.json (recommended)
npm run build          # copies src-templates/ → templates/ and runs tsc
npm test               # vitest in watch mode
npm run test:run       # build + vitest run (one-shot, includes integration)
npm run test:coverage  # build + vitest run --coverage (~34s, what pre-push runs)
npm run test:integration   # only test/integration/** (~33s alone)
npm run lint           # eslint
npm run format         # prettier --write .
```

`npm ci` is the recommended install command — it reproduces `package-lock.json`
exactly and matches what CI runs (`.github/workflows/ci.yml:20`). Use
`npm install <pkg>` only when intentionally adding or changing a dependency.
Avoid `--legacy-peer-deps` — the lockfile resolves cleanly without it; the
flag can silently drift versions in `package.json` during install.

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

Adding a language is **one file** — `src/languages/<name>.ts` implementing
the `LanguageSupport` interface (`src/languages/types.ts`). Register it in
`src/languages/index.ts` and the dispatch fans out automatically through
`health`, `quality`, `test-gaps`, and the tool registry.

What the pack provides (all but `detect`, `sourceExtensions`,
`testFilePatterns`, `tools`, and `semgrepRulesets` are optional):

- `detect(cwd)` — return `true` when this language is present
- `sourceExtensions: string[]` — file extensions to treat as source
- `testFilePatterns: string[]` — glob patterns for test files
- `extraExcludes?: string[]` — dirs to exclude beyond the defaults
- `tools: string[]` — TOOL_DEFS keys the pack invokes (must match)
- `semgrepRulesets: string[]` — semgrep `--config` values to add
- `capabilities?: LanguagePackCapabilities` — typed providers (each
  returns a `CapabilityEnvelope`) for depVulns, lint, coverage,
  testFramework, and imports. This is the only data channel from a
  pack to the analyzer layer — the dispatcher fans out across every
  pack and filters nulls, so adding a capability means implementing a
  provider and slotting it here. See existing packs for the pattern.
- `mapLintSeverity?(ruleId)` — tier lint rules into critical/high/medium/low

Contract tests in `test/languages-contract.test.ts` and
`test/languages-<name>.test.ts` exercise each method.

### Enriching dependency-vulnerability severity

Scanners that don't publish per-finding severity tiers (pip-audit,
govulncheck) can be enriched via OSV.dev. The utility lives in
`src/analyzers/tools/osv.ts`:

```ts
import { enrichSeverities, classifyOsvSeverity } from '../analyzers/tools/osv';

// For per-ID lookup:
const severities = await enrichSeverities(['CVE-2025-X', 'GHSA-Y']);

// When the scanner already embeds the advisory (like govulncheck):
const sev = classifyOsvSeverity(embeddedOsvRecord);
```

Both paths handle CVSS v3, CVSS v4, and the `database_specific.severity`
string. Unreachable IDs fall back to `'unknown'` — callers should bucket
unknowns into their scanner's legacy default (pip-audit → medium,
govulncheck → high).

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
- **Cross-ecosystem integration test** (`test/integration/cross-ecosystem.test.ts`):
  runs `dxkit vulnerabilities` against committed benchmark fixtures
  under `test/fixtures/benchmarks/{python,go,rust,csharp,csharp-multi}/`
  — projects with deliberately pinned vulnerable deps. Validates non-TS
  language packs against real ecosystem-tool output (pip-audit,
  govulncheck, cargo-audit, dotnet list package --vulnerable). ~150s
  end-to-end (subprocess-heavy; CI parallelizes). Each ecosystem's
  tests `skipIf` the relevant binary is not on PATH, so contributors
  without the toolchain see those tests skip locally; CI installs them
  all. See **Cross-ecosystem benchmarks** below.
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

## Cross-ecosystem benchmarks

`test/fixtures/benchmarks/` holds five committed reference projects
(`python`, `go`, `rust`, `csharp`, `csharp-multi`) with deliberately
pinned vulnerable dependencies. They exist to validate dxkit's non-TS
language packs against **real** ecosystem-tool output rather than
hand-crafted JSON.

The history that motivated them: through 2.4.0, the Python / Rust / C#
packs were unit-tested only against synthetic JSON the test author
hand-wrote. Phase 10h.6.8 surfaced four real defects — including a
C# parser that returned **zero findings on every real .NET project**
because the synthetic fixture had the wrong schema shape and the
parser had drifted to match. The benchmarks are the regression net.

### Toolchain requirements

**Routine dxkit development does not require any of these toolchains.**
The cross-ecosystem suite uses `it.skipIf(!commandExists(...))(...)`
gates — locally, contributors without `cargo` / `dotnet` / `go` /
`govulncheck` / `pip-audit` see those tests skip with a clear message.
CI (`.github/workflows/ci.yml`) installs them all; that's the
canonical validation point.

If you need to run the cross-ecosystem suite locally — e.g., because
you're modifying a non-TS language pack — install the relevant
toolchain:

| Toolchain             | Matrix rows                           | Required for                                                       | Install (Linux/macOS)                                                                                                               |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pip-audit`           | Python                                | depVulns                                                           | `pipx install pip-audit` (already in TOOL_DEFS)                                                                                     |
| `ruff`                | Python                                | lint (Phase 10i.0.2)                                               | `pipx install ruff`                                                                                                                 |
| `cargo` (rustup)      | Rust                                  | depVulns + lint (clippy is bundled with rustup `clippy` component) | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh -s -- -y --profile minimal && rustup component add clippy`         |
| `cargo-audit`         | Rust                                  | depVulns                                                           | `cargo install --locked cargo-audit`                                                                                                |
| `dotnet` (.NET 8 SDK) | C# (single) + C# (multi)              | depVulns + lint (`dotnet format` is bundled)                       | `wget https://dot.net/v1/dotnet-install.sh && bash dotnet-install.sh --channel 8.0 --install-dir $HOME/.dotnet`                     |
| `go` 1.21+            | Go                                    | depVulns + lint                                                    | `apt install golang` / `brew install go`                                                                                            |
| `govulncheck`         | Go                                    | depVulns                                                           | `go install golang.org/x/vuln/cmd/govulncheck@latest`                                                                               |
| `golangci-lint`       | Go                                    | lint (Phase 10i.0.2)                                               | `curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh \| sh -s -- -b $(go env GOPATH)/bin v1.64.8` |
| `gitleaks`            | all (matrix — secrets, Phase 10i.0.1) | secrets                                                            | `pipx install gitleaks` / `brew install gitleaks` / [GitHub release](https://github.com/gitleaks/gitleaks/releases)                 |

### Regenerating a fixture

The fixtures are committed minus `obj/` (.NET build artifacts — see
`.gitignore` rule for `test/fixtures/benchmarks/**/obj/`). Most
fixtures need no regeneration; the cases that do:

```bash
# Rust — re-resolve dependency graph
cd test/fixtures/benchmarks/rust && rm Cargo.lock && cargo generate-lockfile

# Go — re-resolve module checksums (use `tidy`, not `download` — govulncheck needs transitive sums)
cd test/fixtures/benchmarks/go && rm go.sum && go mod tidy

# C# (single + multi) — restore is automatic in the integration test's beforeAll
# To regenerate locally for inspection:
cd test/fixtures/benchmarks/csharp && dotnet restore
cd test/fixtures/benchmarks/csharp-multi && dotnet restore Solution.sln
```

Each fixture has its own `README.md` documenting expected scanner
output and the specific defect it guards against.

### Running locally

```bash
# Full cross-ecosystem suite (will skip ecosystems whose toolchains are missing):
npm run test:run -- test/integration/cross-ecosystem.test.ts

# Single ecosystem:
npm run test:run -- test/integration/cross-ecosystem.test.ts -t Rust
```

Subprocess-heavy: ~150s wall-clock end-to-end. Each test invokes
`node dist/index.js vulnerabilities <fixture>` which in turn shells
out to the real ecosystem tool. CI parallelizes the matrix; locally
they run serially.

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
