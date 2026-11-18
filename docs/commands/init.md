# `vyuh-dxkit init`

> **Canonical first install:** `npm init @vyuhlabs/dxkit` — collapses
> install + scaffold into a single command. Falls through to
> `vyuh-dxkit init --full --yes` internally.
>
> **Direct use:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx vyuh-dxkit <cmd>` for one-shot use. Examples on this page
> use the short form.

Install the dxkit agent DX layer in a repository: `AGENTS.md` +
`CLAUDE.md` shim + `.claude/skills/dxkit-*/` (the lifecycle skills)

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

| Option                    | Effect                                                                                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--with-dxkit-agents`     | Install the `dxkit-*` skills + `AGENTS.md` + `CLAUDE.md` shim. Default-on under `--full`; opt-in on bare `init`.                                                                                                                                                                                      |
| `--with-hooks`            | Install `.githooks/pre-push` (and `dxkit-guardrails.sh`, which it runs) for [guardrail check](guardrail.md). Hook activation is auto-chained via package.json postinstall — teammates who `npm install` get hooks wired automatically. Pre-commit is opt-in (`--with-precommit-hook`).                |
| `--with-precommit-hook`   | Additionally install `.githooks/pre-commit`. Implies `--with-hooks`. Use on small/fast repos where every-commit gating is worth the wait.                                                                                                                                                             |
| `--with-devcontainer`     | Install `.devcontainer/` with per-stack pinned toolchains (only the languages your project uses) + Claude Code & Codex CLIs                                                                                                                                                                           |
| `--with-ci`               | Install `.github/workflows/dxkit-guardrails.yml` (PR-gate; it runs `dxkit-guardrails.sh`). On a stack that declares a capability the ubuntu runner can't serve (e.g. a `net*-windows` build), also generates a `dxkit-gate-<host>.yml` job — mark it a required PR check alongside `dxkit-guardrails` |
| `--with-baseline-refresh` | Install `.github/workflows/dxkit-baseline-refresh.yml` (post-merge auto-regen)                                                                                                                                                                                                                        |
| `--with-pr-review`        | Install `.github/workflows/pr-review.yml` — Claude Code reviews each PR and posts a comment. Inert until you set the `ANTHROPIC_API_KEY` repo secret AND `ENABLE_AI_REVIEW=true` repo variable. Not included in `--full` because it requires API-cost opt-in.                                         |
| `--detect`                | Auto-detect stack (language, framework); skip most prompts                                                                                                                                                                                                                                            |
| `--yes`                   | Accept all defaults                                                                                                                                                                                                                                                                                   |
| `--force`                 | Overwrite existing files in place (otherwise sidecars are emitted — see "Additive install" below)                                                                                                                                                                                                     |
| `--stealth`               | Generated files are gitignored — local-only, not committed                                                                                                                                                                                                                                            |
| `--name <n>`              | Override the project name                                                                                                                                                                                                                                                                             |
| `--no-finish`             | Opt out of the auto tools-install + baseline capture — arm the gates now, run `vyuh-dxkit tools install` / `vyuh-dxkit baseline create` later                                                                                                                                                         |
| `--no-scan`               | Skip the codebase analysis step                                                                                                                                                                                                                                                                       |

`--full` implies `--with-dxkit-agents` + `--with-hooks` + `--with-devcontainer` + `--with-ci` + `--with-baseline-refresh`. It does NOT imply `--with-precommit-hook` (slow on large repos) or `--with-pr-review` (needs API-cost opt-in). Combine when you want both: `--full --with-precommit-hook --with-pr-review`.

## What it generates (default `--dx-only` mode)

```
AGENTS.md              # open-standard project-context file (Claude Code,
                       # Codex, Cursor, Aider, any AGENTS.md-compliant agent)
CLAUDE.md              # Claude Code shim that points at AGENTS.md
.claude/
  settings.json        # tool permissions
  skills/dxkit-*/      # the dxkit lifecycle skills (run `vyuh-dxkit
                       # capabilities` to see the installed set)
  rules/               # per-language coding conventions
.vyuh-dxkit.json       # install manifest (config, install flags, evolving file hashes)
```

## `AGENTS.md`: the owner section and the stack headings

`AGENTS.md` has two kinds of content. dxkit owns most of it (the dxkit
commands, the skills list, the per-stack sections, the security rules) and
refreshes it on `update`. The "About this product" section near the top is
yours: write what the product is, how to build, run and test it, and the
domain rules an agent must know, between these two lines:

```markdown
<!-- dxkit:owner:start -->

...your notes...

<!-- dxkit:owner:end -->
```

dxkit never rewrites the text between the markers: not on a re-run of
`init`, not on `update`, not on `update --force`. Editing it does not count
as editing a dxkit file, so `update` keeps refreshing dxkit's sections around
it. An edit anywhere else in the file is treated as before: the file becomes
yours and dxkit leaves it alone, even under `--force`. To get refreshes back,
move your notes between the markers and restore the rest (or delete the file
and run `update`, then paste your notes back in).

An install from before the owner section existed gets one on its next
`update`, provided you never edited the file; an edited one is left as is.
`uninstall` removes dxkit's sections and keeps your notes as the whole of
`AGENTS.md` (an empty section is removed with the file).

The line under the title is the description your repo states in its own
manifest (`package.json` `description`, the pyproject `[project]`
`description`, a single `.csproj` `<Description>`, `Cargo.toml`,
`composer.json`). When the repo states none, there is no line; the owner
section is where the description goes.

Each per-stack heading names what the repo targets, read by the language
pack: `C# on .NET Framework 4.8 (ASP.NET)`, `C# on .NET 8 (ASP.NET Core)`,
`Node.js >=20`, `Python >=3.10`, `Go 1.22`. When the repo states nothing,
the heading is the bare language name; dxkit's default toolchain version is
never printed as if the repo had declared it.

## `--full` adds

- `dxkit-guardrails.sh` — the one entry point for dxkit's checks (correctness
  floor, policy-render parity, [guardrail](guardrail.md)), at the repo root.
  The hooks and the CI workflow both call it; run `./dxkit-guardrails.sh`
  yourself (or have your agent run it) before declaring a change done to get
  the pipeline's verdict locally. Installed whenever `--with-hooks` or
  `--with-ci` is. See [the entry point](guardrail.md#one-entry-point-dxkit-guardrailssh).
- `.githooks/pre-push` — runs `./dxkit-guardrails.sh --quick` before every push
  (pre-commit available via `--with-precommit-hook`)
- `.devcontainer/{devcontainer.json,post-create.sh,install-agent-clis.sh}` —
  per-stack pinned toolchains + Claude Code + Codex CLIs (auth stays user-owned).
  The container is Linux. When part of the stack cannot build on Linux (a
  .NET Framework or Windows desktop project, a Unity project, an iOS app),
  devcontainer.json and AGENTS.md say so and name the machine the build needs
  (for example "C#: Windows with Visual Studio Build Tools (MSBuild) and the
  .NET Framework 4.x developer pack", "Swift: macOS with Xcode"). The container
  then skips that toolchain and keeps editing, scanning and dependency audit.
  The gates use the same answer: that build is placed on a Windows or macOS CI
  job, or reported as skipped with the reason.
  See [The generated devcontainer](#the-generated-devcontainer) below.
- `.github/workflows/dxkit-guardrails.yml` — PR-gate workflow that runs
  `./dxkit-guardrails.sh` and posts its report as a markdown comment
- `.github/workflows/dxkit-baseline-refresh.yml` — post-merge
  auto-regen of `.dxkit/baselines/main.json` (gated on PR-gate success)

After `--full` (or any `--with-hooks`), the postinstall chain auto-
activates `core.hooksPath`. Setup then FINISHES in the same run: when a
baseline-consuming gate is armed (hooks / CI / the Stop-gate), the finish
arc installs the scanner toolchain and captures today's state as the
brownfield anchor automatically — no separate `tools install` /
`baseline create` step. Pass `--no-finish` to defer both and capture the
baseline later:

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
  exists and is yours, the dxkit set is stashed under
  `.devcontainer/.dxkit-reference/` for manual merge. When it is
  dxkit's, `update` refreshes `post-create.sh` and
  `install-agent-clis.sh` in place (that is how new pins arrive) and
  keeps `devcontainer.json`, writing the current render beside it when
  the two differ (`update --force` replaces it).
- **CI workflows** — workflow files are uniquely named; if the file
  already exists, init skips it.

## The generated devcontainer

Everything the container installs is pinned by the dxkit release that
generated the files, so two containers built from the same commit on
different days get the same environment:

- **Coding-agent CLIs** — `install-agent-clis.sh` installs
  `@anthropic-ai/claude-code` and `@openai/codex` at exact versions
  (never `latest`). Override per container with `CLAUDE_CODE_VERSION` /
  `CODEX_VERSION` set to an exact version, or `skip` to leave that CLI
  out. `devcontainer.json` sets `DISABLE_AUTOUPDATER=1` so Claude Code
  does not update itself past its pin. A pin moves when you upgrade dxkit
  and run `vyuh-dxkit update`.
- **dxkit** — the project's own `@vyuhlabs/dxkit` devDependency is used
  when present and linked onto PATH, so terminals and agents run the
  version the repo's hooks and CI run. A devDependency older than the
  version that generated the files is reported as not ready (bump it). Without one, dxkit is installed
  globally at exactly the version that generated the files; a global
  dxkit at another version is replaced, not reused.
- **Scanners** — `vyuh-dxkit tools install --yes --fail-on-missing`
  (versions pinned in dxkit's tool registry). The OS python is always
  provisioned (with pip, venv and pipx) because semgrep and graphify
  install through pipx and a venv.

`post-create.sh` runs every step (project dependencies, installed the way
the generated CI workflows install them; dxkit; scanners; git hooks;
agent CLIs), prints one summary, and **exits non-zero when the
environment is not ready**, so the devcontainer UI and an agent runner
see a failed post-create rather than a green one. Each failure carries
its reason and remedy: for example a dependency install that needs
private-registry auth, a required scanner that did not install, or
dxkit's pre-push hook present but not active (post-create runs
`vyuh-dxkit hooks activate`, because a fresh clone carries no
`core.hooksPath`), or a container built from an older
`devcontainer.json` that `update` kept (adopt the render in
`.devcontainer/.dxkit-reference/`, then rebuild). The outcome is also written to
`.dxkit/cache/devcontainer-readiness.json`, which `vyuh-dxkit doctor`
reports. Re-run with `bash .devcontainer/post-create.sh` after fixing
the cause.

## Idempotency

`init` is safe to re-run. By default it skips files that exist;
`--force` overwrites except files marked as "evolved" (touched by
the user since generation). Use `vyuh-dxkit update` to re-generate
preserving evolved files explicitly.

Re-running `init` on an already-adopted repo detects the existing (or
an older) dxkit version and recommends `vyuh-dxkit update` rather than
re-running setup — so an upgrade migrates the baseline + allowlist
instead of re-scaffolding from scratch.

## See also

- [`update`](update.md) — re-generate while preserving "evolved" files
- [`baseline`](baseline.md) — capture per-finding state as a brownfield anchor
- [`guardrail`](guardrail.md) — diff current scan against baseline to block new regressions
- [`.dxkit/policy.json`](../configuration/policy.md) — tune guardrail block/warn classifications
- [Getting started](../getting-started.md) — quick reference for brand-new users
