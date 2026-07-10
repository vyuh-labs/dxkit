# `vyuh-dxkit upgrade`

Combined CLI for upgrading dxkit to a newer version. Wraps two
stages — the npm binary and the in-repo scaffold — into a single
command, with a plan-only preview mode that the `dxkit-update`
agent skill consumes.

## Why an upgrade CLI

dxkit ships in two layers, and an upgrade touches both:

1. **The binary** — `@vyuhlabs/dxkit` npm package. `npm install
@vyuhlabs/dxkit@<version>` replaces the local install.
2. **The scaffold** — files in the customer's repo (`.devcontainer/`,
   `.githooks/`, `.claude/skills/dxkit-*/`, `AGENTS.md`, `CLAUDE.md`,
   `.github/workflows/dxkit-*.yml`). `vyuh-dxkit update` refreshes
   these to match the new binary's templates.

Either step alone leaves an inconsistent install. `vyuh-dxkit upgrade`
runs both, plus `vyuh-dxkit doctor` afterwards to verify operational
health.

The scaffold-refresh step (`vyuh-dxkit update`) also **migrates your
baseline + allowlist** when a release changes the finding-identity scheme:
it re-anchors allowlist fingerprints onto the new scheme (preserving your
reviewed suppressions) and regenerates the baseline, so the guardrail keeps
working without a manual re-baseline. See [`update`](update.md#identity-scheme-migration-run-after-every-upgrade)
for details. Commit `.dxkit/` afterward to finish the migration.

## Usage

```bash
# Preview only — emit the upgrade plan, no mutations
vyuh-dxkit upgrade --plan
vyuh-dxkit upgrade --plan --json    # structured output for dxkit-update skill

# Execute — interactive (requires --yes today; no built-in prompt)
vyuh-dxkit upgrade --yes

# Pin to a specific version
vyuh-dxkit upgrade --target=3.1.0 --yes

# Print the commands without executing
vyuh-dxkit upgrade --yes --dry-run
```

## Flags

| Flag             | Effect                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--plan`         | Plan-only mode. Emits the UpgradePlan and exits. No mutations.                                                                                      |
| `--json`         | (Combine with `--plan`) Emit the plan as JSON instead of human-prose. Schema discriminator `upgrade-plan.v1`. Consumed by the `dxkit-update` skill. |
| `--target=X.Y.Z` | Pin upgrade to a specific version. Default: latest from `npm view @vyuhlabs/dxkit version`.                                                         |
| `--yes`          | Skip interactive confirmation. Required for execution today (no built-in prompt; the `dxkit-update` skill handles confirmation conversationally).   |
| `--dry-run`      | Print the commands without executing. Useful for risk-averse review before a real upgrade.                                                          |

## UpgradePlan schema

`upgrade --plan --json` emits a JSON document with this shape:

```json
{
  "schema": "upgrade-plan.v1",
  "generatedAt": "2026-05-21T22:00:00.000Z",
  "cwd": "/path/to/your/repo",
  "current": {
    "binary": "3.0.0", // installed binary version (via npx vyuh-dxkit --version)
    "scaffold": "3.0.0" // scaffold version recorded in manifest
  },
  "target": "3.1.0", // resolved target (latest or --target)
  "delta": "patch", // none | patch | minor | major | downgrade
  "steps": [
    {
      "command": "npm install @vyuhlabs/dxkit@3.1.0",
      "purpose": "Install dxkit binary 3.0.0 → 3.1.0"
    },
    {
      "command": "npx vyuh-dxkit update",
      "purpose": "Refresh scaffold (.devcontainer, .githooks, .claude/skills, CI workflows)"
    },
    {
      "command": "npx vyuh-dxkit doctor",
      "purpose": "Verify operational health post-upgrade"
    },
    {
      "command": "# Rebuild devcontainer: VSCode Command Palette → \"Dev Containers: Rebuild Container\"",
      "purpose": "Pick up devcontainer.json changes (if any) — manual step",
      "optional": true
    }
  ],
  "warnings": [], // populated on major bumps, downgrades, scaffold drift
  "changelogNote": "For per-version details: https://github.com/vyuh-labs/dxkit/blob/main/CHANGELOG.md"
}
```

## Delta classification

| `delta`     | When                        | Recommended path                                                                    |
| ----------- | --------------------------- | ----------------------------------------------------------------------------------- |
| `none`      | Current = target. No-op.    | Nothing to do.                                                                      |
| `patch`     | 3.1.0 → 3.1.1               | Low risk. Run `--yes` directly.                                                     |
| `minor`     | 3.1.x → 3.2.0               | Probably safe. Check changelog for new features + scaffold changes.                 |
| `major`     | 2.x.x → 3.0.0               | Read CHANGELOG.md for breaking changes BEFORE upgrading.                            |
| `downgrade` | Target older than installed | Not officially supported. Schemas may differ. Surfaces warning; never auto-execute. |

## Manual step: devcontainer rebuild

When the upgrade touches `.devcontainer/`, the customer's running
container is stale. The CLI can't drive a UI command — it surfaces
the manual step as an `optional: true` entry in the plan:

```
VSCode:     Command Palette → "Dev Containers: Rebuild Container"
Codespaces: Command Palette → "Codespaces: Rebuild Container"
Local Docker: docker compose down && docker compose up -d --build
```

## Companion: the `dxkit-update` skill

Most customers should reach for the conversational upgrade flow via
Claude Code:

> "Update dxkit"

The `dxkit-update` skill consumes `upgrade --plan --json`, explains
the delta + warnings + per-version highlights, asks for confirmation
at each step, and hands off to `dxkit-fix` if post-upgrade doctor
surfaces broken signals.

The CLI is the underlying machinery; the skill is the recommended
human interface.

## See also

- [`update`](update.md) — scaffold-only refresh (no binary upgrade)
- [`doctor`](doctor.md) — verify operational health
- [`init`](init.md) — fresh install
