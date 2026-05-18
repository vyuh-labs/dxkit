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

| Mode                  | Effect                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `--dx-only` (default) | Just the developer-experience layer — `.claude/`, `CLAUDE.md`, agent definitions            |
| `--full`              | Everything — DX + quality tooling + hooks + devcontainer + CI guardrails + baseline-refresh |

## Options

| Option                    | Effect                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `--with-hooks`            | Install `.githooks/{pre-commit,pre-push}` for [guardrail check](guardrail.md)                     |
| `--with-devcontainer`     | Install `.devcontainer/` with pinned toolchains + Claude Code & Codex CLIs                        |
| `--with-ci`               | Install `.github/workflows/dxkit-guardrails.yml` (PR-gate)                                        |
| `--with-baseline-refresh` | Install `.github/workflows/dxkit-baseline-refresh.yml` (post-merge auto-regen)                    |
| `--detect`                | Auto-detect stack (language, framework); skip most prompts                                        |
| `--yes`                   | Accept all defaults                                                                               |
| `--force`                 | Overwrite existing files in place (otherwise sidecars are emitted — see "Additive install" below) |
| `--stealth`               | Generated files are gitignored — local-only, not committed                                        |
| `--name <n>`              | Override the project name                                                                         |
| `--no-scan`               | Skip the codebase analysis step                                                                   |

`--full` implies every `--with-*` flag.

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
- `.githooks/{pre-commit,pre-push}` — fast-mode + full-mode [guardrail](guardrail.md) hooks
- `.devcontainer/{devcontainer.json,post-create.sh,install-agent-clis.sh}` — pinned toolchains + AI agent CLIs
- `.github/workflows/dxkit-guardrails.yml` — PR-gate workflow that posts a markdown comment
- `.github/workflows/dxkit-baseline-refresh.yml` — post-merge auto-regen of `.dxkit/baselines/main.json`

After `--full` (or any `--with-hooks`):

```bash
git config core.hooksPath .githooks   # activate the hooks, once per clone
vyuh-dxkit baseline create            # capture today's state as the brownfield anchor
```

## Additive install

`init` never destroys consumer-authored files unless `--force` is set.

- **Hooks** — if `.githooks/pre-commit` or `.husky/pre-commit` already
  exists, the dxkit hook is written as `.githooks/<name>.dxkit` and
  a merge note is printed. Chain by sourcing the sidecar from your
  existing hook (`sh .githooks/pre-commit.dxkit`).
- **Devcontainer** — if `.devcontainer/devcontainer.json` already
  exists, the dxkit set is stashed under
  `.devcontainer/.dxkit-reference/` for manual merge.
- **CI workflows** — workflow files are uniquely named; if the file
  already exists, init skips it.

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

- [`update`](update.md) — re-generate while preserving "evolved" files
- [`baseline`](baseline.md) — capture per-finding state as a brownfield anchor
- [`guardrail`](guardrail.md) — diff current scan against baseline to block new regressions
- [`.dxkit/policy.json`](../configuration/policy.md) — tune guardrail block/warn classifications
- [Getting started](../getting-started.md) — quick reference for brand-new users
