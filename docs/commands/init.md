# `vyuh-dxkit init`

> **Canonical first install:** `npm init @vyuhlabs/dxkit` — collapses
> install + scaffold into a single command. Falls through to
> `vyuh-dxkit init --full --yes` internally.
>
> **Direct use:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx vyuh-dxkit <cmd>` for one-shot use. Examples on this page
> use the short form.

Install the dxkit agent DX layer in a repository: `AGENTS.md` +
`CLAUDE.md` shim + `.claude/skills/dxkit-*/` (nine lifecycle skills)

- `.claude/rules/` (per-language conventions), plus — optionally —
  git hooks, per-stack devcontainer, CI guardrails, and the post-merge
  baseline-refresh workflow.

Works on any codebase, greenfield or brownfield. dxkit is additive:
existing `.husky/`, `.devcontainer/`, or CI workflows are never
destroyed — sidecars are written instead (see "Additive install"
below).

## Usage

```bash
vyuh-dxkit init [options]
```

## Modes

| Mode                  | Effect                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--dx-only` (default) | Agent DX layer only — `AGENTS.md`, `CLAUDE.md`, `.claude/skills/dxkit-*/`, `.claude/rules/`, `.vyuh-dxkit.json`  |
| `--full`              | Agent DX + git hooks + per-stack devcontainer + CI guardrails + baseline-refresh (every `--with-*` flag enabled) |

## Options

| Option                    | Effect                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--with-dxkit-agents`     | Install the nine `dxkit-*` skills + `AGENTS.md` + `CLAUDE.md` shim. Default-on under `--full`; opt-in on bare `init`.                                                                                                                                         |
| `--with-hooks`            | Install `.githooks/pre-push` for [guardrail check](guardrail.md). Hook activation is auto-chained via package.json postinstall — teammates who `npm install` get hooks wired automatically. Pre-commit is opt-in (`--with-precommit-hook`).                   |
| `--with-precommit-hook`   | Additionally install `.githooks/pre-commit`. Implies `--with-hooks`. Use on small/fast repos where every-commit gating is worth the wait.                                                                                                                     |
| `--with-devcontainer`     | Install `.devcontainer/` with per-stack pinned toolchains (only the languages your project uses) + Claude Code & Codex CLIs                                                                                                                                   |
| `--with-ci`               | Install `.github/workflows/dxkit-guardrails.yml` (PR-gate)                                                                                                                                                                                                    |
| `--with-baseline-refresh` | Install `.github/workflows/dxkit-baseline-refresh.yml` (post-merge auto-regen)                                                                                                                                                                                |
| `--with-pr-review`        | Install `.github/workflows/pr-review.yml` — Claude Code reviews each PR and posts a comment. Inert until you set the `ANTHROPIC_API_KEY` repo secret AND `ENABLE_AI_REVIEW=true` repo variable. Not included in `--full` because it requires API-cost opt-in. |
| `--detect`                | Auto-detect stack (language, framework); skip most prompts                                                                                                                                                                                                    |
| `--yes`                   | Accept all defaults                                                                                                                                                                                                                                           |
| `--force`                 | Overwrite existing files in place (otherwise sidecars are emitted — see "Additive install" below)                                                                                                                                                             |
| `--stealth`               | Generated files are gitignored — local-only, not committed                                                                                                                                                                                                    |
| `--name <n>`              | Override the project name                                                                                                                                                                                                                                     |
| `--no-scan`               | Skip the codebase analysis step                                                                                                                                                                                                                               |

`--full` implies `--with-dxkit-agents` + `--with-hooks` + `--with-devcontainer` + `--with-ci` + `--with-baseline-refresh`. It does NOT imply `--with-precommit-hook` (slow on large repos) or `--with-pr-review` (needs API-cost opt-in). Combine when you want both: `--full --with-precommit-hook --with-pr-review`.

## What it generates (default `--dx-only` mode)

```
AGENTS.md              # open-standard project-context file (Claude Code,
                       # Codex, Cursor, Aider, any AGENTS.md-compliant agent)
CLAUDE.md              # Claude Code shim that points at AGENTS.md
.claude/
  settings.json        # tool permissions
  skills/dxkit-*/      # nine lifecycle skills: learn / init / config /
                       # hooks / reports / action / fix / update / onboard
  rules/               # per-language coding conventions
.vyuh-dxkit.json       # install manifest (config, install flags, evolving file hashes)
```

## `--full` adds

- `.githooks/pre-push` — full-mode [guardrail](guardrail.md) hook
  (pre-commit available via `--with-precommit-hook`)
- `.devcontainer/{devcontainer.json,post-create.sh,install-agent-clis.sh}` —
  per-stack pinned toolchains + Claude Code + Codex CLIs (auth stays user-owned)
- `.github/workflows/dxkit-guardrails.yml` — PR-gate workflow that
  posts a markdown comment
- `.github/workflows/dxkit-baseline-refresh.yml` — post-merge
  auto-regen of `.dxkit/baselines/main.json` (gated on PR-gate success)

After `--full` (or any `--with-hooks`), the postinstall chain auto-
activates `core.hooksPath`. Capture your first baseline:

```bash
vyuh-dxkit baseline create            # capture today's state as the brownfield anchor
```

If hook activation didn't fire (e.g. you cloned the repo without
running `npm install`), trigger it manually:

```bash
vyuh-dxkit hooks activate
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
