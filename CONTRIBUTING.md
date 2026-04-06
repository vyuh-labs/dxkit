# Contributing to DXKit

Thanks for your interest in improving `@vyuhlabs/dxkit`. This package is the
drop-in AI developer experience toolkit for any repo: it generates `.claude/`
agents, commands, skills, and rules tuned to whatever language and framework
you're working in.

## Repo layout

```
packages/vyuh-dxkit/        # (will become its own repo: vyuhlabs/dxkit)
├── src/                    # TypeScript source for the CLI
├── src-templates/          # SOURCE OF TRUTH for everything we ship into .claude/
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
└── templates/              # Build output (gitignored, shipped in npm tarball)
```

`templates/` is generated — never edit it directly. Edit `src-templates/`
and run `npm run build`.

## Local development

```bash
cd packages/vyuh-dxkit
npm install
npm run build         # copies src-templates/ → templates/ and runs tsc
npm run typecheck
```

To try the CLI against a sample repo:

```bash
node dist/index.js init --detect --dry-run
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

There is currently no automated test suite for the CLI itself — we rely on
the build succeeding and manual smoke tests:

```bash
npm run build
mkdir -p /tmp/dxkit-smoke && cd /tmp/dxkit-smoke && git init -q
node /path/to/packages/vyuh-dxkit/dist/index.js init --detect
ls .claude/
```

Adding a real test runner is on the roadmap — PRs welcome.

## Releasing

Releases are handled by the maintainers via GitHub Releases, which trigger
the publish workflow. Contributors do not need to bump versions in PRs.

## Code style

- TypeScript strict mode is on. Fix `tsc` errors before submitting.
- No new runtime dependencies without discussion — DXKit aims to stay
  zero-dep so it installs fast via `npx`.
