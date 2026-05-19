# `vyuh-dxkit init`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Install the dxkit agent DX layer in a repository: `CLAUDE.md`,
`.claude/` (skills, commands, agents, per-language rules), plus —
optionally — git hooks, devcontainer, CI guardrails, and the post-
merge baseline-refresh workflow.

Works on any codebase, greenfield or brownfield. dxkit is additive:
existing `.husky/`, `.devcontainer/`, or CI workflows are never
destroyed — sidecars are written instead (see "Additive install"
below).

## Usage

```bash
vyuh-dxkit init [options]
```

## Modes

| Mode                  | Effect                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `--dx-only` (default) | Agent DX layer only — `.claude/`, `CLAUDE.md`, `.vyuh-dxkit.json` manifest                             |
| `--full`              | Agent DX + git hooks + devcontainer + CI guardrails + baseline-refresh (every `--with-*` flag enabled) |

## Options

| Option                    | Effect                                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--with-hooks`            | Install `.githooks/pre-push` for [guardrail check](guardrail.md). Pre-commit is opt-in (`--with-precommit-hook`) because it re-runs every analyzer on every commit (slow on large repos). |
| `--with-precommit-hook`   | Additionally install `.githooks/pre-commit`. Implies `--with-hooks`. Use on small/fast repos where every-commit gating is worth the wait.                                                 |
| `--with-devcontainer`     | Install `.devcontainer/` with pinned toolchains + Claude Code & Codex CLIs                                                                                                                |
| `--with-ci`               | Install `.github/workflows/dxkit-guardrails.yml` (PR-gate)                                                                                                                                |
| `--with-baseline-refresh` | Install `.github/workflows/dxkit-baseline-refresh.yml` (post-merge auto-regen)                                                                                                            |
| `--detect`                | Auto-detect stack (language, framework); skip most prompts                                                                                                                                |
| `--yes`                   | Accept all defaults                                                                                                                                                                       |
| `--force`                 | Overwrite existing files in place (otherwise sidecars are emitted — see "Additive install" below)                                                                                         |
| `--stealth`               | Generated files are gitignored — local-only, not committed                                                                                                                                |
| `--name <n>`              | Override the project name                                                                                                                                                                 |
| `--no-scan`               | Skip the codebase analysis step                                                                                                                                                           |

`--full` implies every `--with-*` flag.

## What it generates (default `--dx-only` mode)

```
CLAUDE.md              # entry-point doc loaded by Claude Code at session start
.claude/
  settings.json        # tool permissions
  skills/              # domain context loaded on demand
  commands/            # slash commands (/health, /quality, /test-gaps, ...)
  agents/              # active agent specialists (auto-triggered)
  agents-available/    # dormant agents (opt in via /enable-agent)
  rules/               # per-language coding conventions
.vyuh-dxkit.json       # install manifest (what was generated, when, evolving flags)
```

## `--full` adds

- `.githooks/{pre-commit,pre-push}` — fast-mode + full-mode
  [guardrail](guardrail.md) hooks
- `.devcontainer/{devcontainer.json,post-create.sh,install-agent-clis.sh}` —
  pinned toolchains + Claude Code + Codex CLIs (auth stays user-owned)
- `.github/workflows/dxkit-guardrails.yml` — PR-gate workflow that
  posts a markdown comment
- `.github/workflows/dxkit-baseline-refresh.yml` — post-merge
  auto-regen of `.dxkit/baselines/main.json` (gated on PR-gate success)

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

## See also

- [`update`](update.md) — re-generate while preserving "evolved" files
- [`baseline`](baseline.md) — capture per-finding state as a brownfield anchor
- [`guardrail`](guardrail.md) — diff current scan against baseline to block new regressions
- [`.dxkit/policy.json`](../configuration/policy.md) — tune guardrail block/warn classifications
- [Getting started](../getting-started.md) — quick reference for brand-new users
