# Contributing to DXKit

Thanks for your interest in improving `@vyuhlabs/dxkit`. This package is the
drop-in AI developer experience toolkit for any repo: it generates `.claude/`
agents, commands, skills, and rules tuned to whatever language and framework
you're working in.

## Repo layout

```
dxkit/
├── src/                    # TypeScript source for the CLI
├── src-templates/          # SOURCE OF TRUTH for everything shipped into .claude/
│   ├── .claude/
│   │   ├── agents/         # Active agents shipped by default
│   │   ├── agents-available/  # Dormant agents users can opt into
│   │   ├── commands/       # Slash commands (.md and .md.template)
│   │   ├── skills/         # Skills bundled with the kit
│   │   ├── rules/          # Path-scoped rules per language/framework
│   │   └── settings.json.template
│   ├── .ai/                # Prompt library
│   ├── .devcontainer/      # Used by --full mode
│   ├── .github/            # CI templates used by --full mode
│   ├── configs/            # Lint/format/test configs
│   ├── Makefile            # Used by --full mode
│   ├── .project/           # Project scripts used by --full mode
│   └── CLAUDE.md.template
├── scripts/copy-templates.js   # Build step: src-templates/ → templates/
├── templates/              # Build output (gitignored, shipped in npm tarball)
└── test/                   # Vitest tests + fixtures
```

`templates/` is generated — never edit it directly. Edit `src-templates/`
and run `npm run build`.

## Local development

```bash
nvm use                # picks up .nvmrc (Node 22)
npm install            # installs deps and sets up husky hooks
npm run build          # copies src-templates/ → templates/ and runs tsc
npm test               # vitest in watch mode
npm run lint           # eslint
npm run format         # prettier --write .
```

The first `npm install` registers husky hooks automatically. From then on:

- **pre-commit:** `lint-staged` runs `eslint --fix` and `prettier --write` on
  staged files, then `tsc --noEmit` runs across the whole project.
- **pre-push:** `vitest run --changed @{u}` runs only the tests affected by
  what you're about to push (falls back to the full suite if there's no
  upstream).

CI re-runs everything (lint with `--max-warnings 0`, format check, build,
full test suite, pack-dry) on every push and PR. Anything the local hooks
let through, CI catches.

To try the CLI against a sample repo:

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

## Testing changes

Tests live in `test/` and use [Vitest](https://vitest.dev/). There are two
kinds:

- **Unit tests** (`test/detect.test.ts`): exercise pure functions like
  `detect()` against fixture project trees in `test/fixtures/`. Add a new
  fixture directory whenever you teach `detect.ts` about a new language or
  framework.
- **Integration tests** (`test/cli-init.test.ts`): build the CLI and run it
  against a temp directory, asserting on the files it writes. Use these when
  changing the generator or any code path that touches disk.

Run the suite:

```bash
npm test           # watch mode
npx vitest run     # one-shot
```

Integration tests require a built CLI — `npm run build` first, or use
`npm run test:run` which builds then runs.

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
