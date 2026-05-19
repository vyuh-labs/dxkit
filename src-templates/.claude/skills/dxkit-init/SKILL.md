---
name: dxkit-init
description: Walk the user through installing and configuring dxkit on a fresh repo. Use when the user asks "how do I install dxkit?", "set up dxkit on this repo", "what flags should I use?", or wants to scaffold the guardrail surface. Defers to dxkit-config / dxkit-hooks for post-install tuning.
---

# dxkit-init

This skill scaffolds dxkit on a repo: chooses flags, runs `init`, captures a baseline, and points at the next steps.

## Decision tree

Ask the user what they want, then pick the right invocation:

1. **"Just give me everything"** → `npm init @vyuhlabs/dxkit` (collapses install + init), or if dxkit is already a devDep: `npx vyuh-dxkit init --full --yes`
2. **"I only want the agent context, no guardrails yet"** → `npx vyuh-dxkit init --with-dxkit-agents --yes`
3. **"I want guardrails but no CI"** → `npx vyuh-dxkit init --with-hooks --with-dxkit-agents --yes`
4. **"I want the full setup but no pre-commit"** → `--full --yes` already does this (pre-commit is opt-in via `--with-precommit-hook` because it's slow on large repos)
5. **"Interactive — talk me through it"** → `npx vyuh-dxkit init` (no `--yes`) and let it prompt

## Flag reference

| Flag | What it ships | Default under `--full`? |
|---|---|---|
| `--with-dxkit-agents` | The 6 dxkit-* skills + AGENTS.md + CLAUDE.md shim | Yes |
| `--with-hooks` | `.githooks/pre-push` + postinstall activation wire-up | Yes |
| `--with-precommit-hook` | Adds `.githooks/pre-commit` (slow on large repos) | No (still opt-in) |
| `--with-devcontainer` | `.devcontainer/devcontainer.json` (per-stack features) + post-create.sh | Yes |
| `--with-ci` | `.github/workflows/dxkit-guardrails.yml` (PR gate) | Yes |
| `--with-baseline-refresh` | `.github/workflows/dxkit-baseline-refresh.yml` (post-merge regen) | Yes |
| `--with-pr-review` | `.github/workflows/pr-review.yml` (AI PR review; needs `ANTHROPIC_API_KEY`) | No (still opt-in) |

`--yes` accepts all prompts; `--force` overwrites existing files instead of writing `.dxkit` sidecars on conflict.

## Steps

1. **Detect the stack** before installing — let the user confirm:
   ```bash
   npx vyuh-dxkit init --detect
   ```
   This auto-detects and previews what `init --full` would do without writing anything.

2. **Run init**:
   ```bash
   # Most common case — full setup, no prompts
   npx vyuh-dxkit init --full --yes
   ```

3. **Capture the brownfield baseline** — must do this before hooks/CI become useful:
   ```bash
   npx vyuh-dxkit baseline create
   git add .dxkit/baselines/
   git commit -m "chore: capture dxkit baseline"
   ```

4. **Verify the install**:
   ```bash
   npx vyuh-dxkit doctor
   ```
   This checks: hooks active, baseline present, workflows installed, scanner toolchain available.

5. **Hand off**:
   - For policy / exclusions / scoring thresholds → `dxkit-config` skill
   - For hook troubleshooting → `dxkit-hooks` skill
   - For running reports → `dxkit-reports` skill
   - For branch protection (manual today, automated in next release): GitHub repo settings → Branches → require `dxkit guardrails` check + require PR review

## Common pitfalls

- **No package.json**: `npm init @vyuhlabs/dxkit` seeds a minimal one. For Python-only / Go-only repos, install dxkit globally instead: `npm install -g @vyuhlabs/dxkit && vyuh-dxkit init --full --yes`.
- **Existing .claude/ from 2.5.0**: dxkit init is additive — your existing `.claude/` files are preserved. To switch to the new dxkit-specific shape, delete the old `.claude/` dir first, then re-init.
- **Peer-dep ERESOLVE during `npm install`**: `npm init @vyuhlabs/dxkit` automatically retries with `--legacy-peer-deps`. Manual installs may need that flag.
- **Brownfield repo with thousands of existing findings**: that's normal — the baseline records them all once. Guardrail only blocks net-new findings.

## What `init --full` writes

A complete install lays down ~15-20 files (down from the 2.5.0 ~73-file scaffold). Per-repo:

- `.dxkit/baselines/main.json` (after `baseline create`)
- `.dxkit-ignore` (starter template)
- `.vyuh-dxkit.json` (manifest)
- `.githooks/pre-push`
- `.github/workflows/dxkit-guardrails.yml`
- `.github/workflows/dxkit-baseline-refresh.yml`
- `.devcontainer/devcontainer.json` (per-stack features)
- `.devcontainer/post-create.sh`
- `.devcontainer/install-agent-clis.sh`
- `.claude/skills/dxkit-{learn,init,config,hooks,reports,action}/SKILL.md`
- `.claude/rules/<lang>.md` (per active language pack)
- `.claude/settings.json` (narrowed: dxkit-binary permissions only)
- `AGENTS.md` (project prose context for any agent — Claude, Codex, Cursor, Aider)
- `CLAUDE.md` (shim pointing at AGENTS.md)
- `package.json` (postinstall = `vyuh-dxkit hooks activate`)
- `.gitignore` (additive: `.dxkit/reports/`, `.dxkit/cache/`, `graphify-out/`)
