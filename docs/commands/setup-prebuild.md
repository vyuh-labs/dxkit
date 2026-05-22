# `vyuh-dxkit setup-prebuild`

Configure GitHub Codespaces prebuilds for the repo so fresh
Codespaces start from a prebuilt image instead of re-running the
full devcontainer build.

## Why an automation CLI

dxkit's polyglot devcontainer takes ~7 min cold-start (post per-stack
feature work in 2.5.1). Prebuilds drop this to ~30s by maintaining
the built image in GitHub's image cache.

The math is overwhelming for any team using Codespaces:

| Cost                                    | Saved per dev per week (5 fresh Codespaces) |
| --------------------------------------- | ------------------------------------------- |
| ~$3-5/month prebuild storage per region | ~30 min of wall-clock wait time             |
| For a 20-dev team: ~$60-100/month       | ~200 hours of dev time per year per team    |

Manually configuring Codespaces prebuilds is a UI dance through repo
Settings → Codespaces → Set up prebuild → configure branches → wait
for first prebuild. Many teams skip it — and pay the ~7 min cold-
start cost on every fresh Codespaces session.

This CLI automates the configuration in one command.

## Usage

```bash
# Default: prebuild the repo's default branch in GitHub's chosen region
vyuh-dxkit setup-prebuild

# Specify a branch other than the default
vyuh-dxkit setup-prebuild --branch develop

# Pin specific regions (comma-separated GitHub region IDs)
vyuh-dxkit setup-prebuild --regions westus2,eastus

# Force re-create even if a prebuild config exists for the branch
vyuh-dxkit setup-prebuild --force
```

## Flags

| Flag              | Effect                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--branch <name>` | Branch to prebuild. Default: the repo's default branch.                                                                                         |
| `--regions <r>`   | Comma-separated GitHub region IDs (e.g. `westus2,eastus`). Default: omit — GitHub picks based on the org's Codespaces preferences.              |
| `--force`         | Re-create the prebuild config even if one already exists for the branch. Default: skip (idempotent; avoids clobbering customer-chosen regions). |

## Prerequisites

- **GitHub CLI installed + authenticated**: same as
  [`setup-branch-protection`](setup-branch-protection.md).
- **Repo has a `.devcontainer/`**: prebuilds without a devcontainer
  are pointless (nothing to prebuild). The CLI checks and refuses
  to proceed otherwise — fix path is `npx vyuh-dxkit init --with-devcontainer --yes`.
- **You have admin permission on the repo**: required for the
  Codespaces prebuild API.
- **Codespaces enabled for your org**: if Codespaces is disabled at
  the org level, the API returns HTTP 404. Surfaces with org-admin
  guidance.

## Idempotency

By default, skips if a prebuild config already exists for the target
branch. This avoids clobbering customer-chosen regions on accidental
re-runs.

`--force` re-creates the config, replacing the existing one.

## Edge cases

| Symptom                                            | Likely cause                   | Suggestion                                                                                   |
| -------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| "gh CLI not available or not authenticated"        | Missing `gh` or not logged in  | Install gh from <https://cli.github.com>; run `gh auth login`                                |
| "No .devcontainer/devcontainer.json found"         | No devcontainer scaffolded yet | Run `npx vyuh-dxkit init --with-devcontainer --yes` first                                    |
| HTTP 404 ("Codespaces prebuilds API returned 404") | Codespaces disabled for org    | Ask your org admin to enable Codespaces, or configure manually in repo Settings → Codespaces |
| HTTP 402 ("Codespaces billing limit reached")      | Org spending limit hit         | Check repo / org spending limits in GitHub Settings                                          |
| HTTP 403                                           | You're not a repo admin        | Ask a repo admin to run this command                                                         |

## First-prebuild timing

After the config lands, the **first** prebuild takes ~25 minutes
(one-time cost — GitHub builds the image fresh). Subsequent fresh
Codespaces sessions on that branch start in ~30s by pulling the
prebuilt image. Prebuilds auto-refresh on every push to the
configured branch (or on the cadence the customer configures in
repo Settings → Codespaces).

## Output

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  vyuh-dxkit setup-prebuild
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  → Checking existing prebuilds for vyuh-labs/dxkit#main...
  → Creating prebuild for main...

  ✓ Prebuild configured for vyuh-labs/dxkit#main.
    → First prebuild takes ~25 min (one-time); subsequent fresh Codespaces start in ~30s.
    → Verify: https://github.com/vyuh-labs/dxkit/settings/codespaces
```

## See also

- [`setup-branch-protection`](setup-branch-protection.md) — companion
  CLI for unbypassable PR-gate enforcement (same gh-CLI infrastructure)
- [`init --with-devcontainer`](init.md) — install the per-stack
  devcontainer this CLI prebuilds
