# `vyuh-dxkit init`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Scaffold a new project with Claude Code DX pre-configured — generates
`.claude/`, `CLAUDE.md`, and (with `--full`) CI workflows, pre-commit
hooks, ESLint/Prettier configs, and quality tooling.

This is primarily a **greenfield** command. Brownfield repos
typically don't need `init` — they just install dxkit and start
running reports.

## Usage

```bash
vyuh-dxkit init [options]
```

## Modes

| Mode                  | Effect                                                                           |
| --------------------- | -------------------------------------------------------------------------------- |
| `--dx-only` (default) | Just the developer-experience layer — `.claude/`, `CLAUDE.md`, agent definitions |
| `--full`              | Everything — DX + quality tooling + CI + pre-commit + ESLint/Prettier            |

## Options

| Option       | Effect                                                     |
| ------------ | ---------------------------------------------------------- |
| `--detect`   | Auto-detect stack (language, framework); skip most prompts |
| `--yes`      | Accept all defaults                                        |
| `--force`    | Overwrite existing files (except files marked "evolved")   |
| `--stealth`  | Generated files are gitignored — local-only, not committed |
| `--name <n>` | Override the project name                                  |
| `--no-scan`  | Skip the codebase analysis step                            |

## What it generates (default mode)

```
.claude/
  agents/
    *.md           # specialized agent definitions
  commands/
    *.md           # slash commands
  rules/
    *.md           # per-language coding conventions
CLAUDE.md          # the entry point for Claude Code
.dxkit/
  config.yml       # what was generated, when
```

## `--full` adds

- `.github/workflows/` — CI pipelines (lint + test + dxkit health)
- `.husky/` — pre-commit + commit-msg hooks
- `.eslintrc` / `.prettierrc` / similar — quality configs
- `tsconfig.json` / `pyproject.toml` / similar — per-pack scaffold
- `package.json` / `pyproject.toml` updates with required dev deps

## Idempotency

`init` is safe to re-run. By default it skips files that exist;
`--force` overwrites except files marked as "evolved" (touched by
the user since generation). Use `vyuh-dxkit update` to re-generate
preserving evolved files explicitly.

## When to use

- **Greenfield:** new project, scaffold everything at once
- **Brownfield:** when you want the Claude DX layer in an existing
  repo, but typically without `--full` (which would overwrite
  existing CI configs)

## See also

- [`update`](#) — re-generate while preserving "evolved" files (page pending)
- [Getting started](../getting-started.md) — quick reference for brand-new users
