# `vyuh-dxkit setup-branch-protection`

Configure GitHub branch protection on the repo's default branch with
`dxkit-guardrails` listed as a required status check. Without this
step, the dxkit-guardrails workflow installed by `init --with-ci`
only runs informationally — PRs can merge even if the guardrail
fails. With it, merges are blocked on guardrail failures.

## Why an automation CLI

The dxkit safety story is "local hooks for fast feedback, CI workflow
as unbypassable enforcement." The CI layer only enforces when
configured as a required status check via branch protection.

Manually configuring branch protection is a UI dance (Settings →
Branches → Add rule → Require status checks → check
`dxkit-guardrails`). Many admins skip this — and silently lose the
entire safety guarantee.

This CLI automates the step in one command.

## Usage

```bash
# Default: protect the repo's default branch, add dxkit-guardrails as
# a required check, don't change review-count policy
vyuh-dxkit setup-branch-protection

# Specify a branch other than the default
vyuh-dxkit setup-branch-protection --branch develop

# Also require N PR reviews before merge
vyuh-dxkit setup-branch-protection --require-reviews 1

# Force replace existing required-checks list with just dxkit-guardrails
vyuh-dxkit setup-branch-protection --force
```

## Flags

| Flag                  | Effect                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--branch <name>`     | Branch to protect. Default: the repo's default branch (resolved via `gh repo view --json defaultBranchRef`).                                           |
| `--require-reviews N` | Number of required PR reviews before merge. Default: 0 (don't force a policy — preserves whatever the customer already had).                           |
| `--force`             | Replace the entire required-checks list with just `dxkit-guardrails`. Default: merge — preserve any other required checks the customer has configured. |

## Prerequisites

- **GitHub CLI installed + authenticated**: `gh auth status` must
  return clean. Install via <https://cli.github.com>; authenticate
  with `gh auth login`.
- **Repo has a github.com remote**: the command uses `gh repo view`
  to resolve owner + repo + default branch.
- **You have admin permission on the repo**: the GitHub API requires
  admin to configure branch protection. Returns HTTP 403 otherwise.
- **The dxkit-guardrails workflow exists**: `.github/workflows/dxkit-guardrails.yml`
  must be present. Configuring branch protection to require a
  non-existent check would block every PR until that workflow is
  added. The CLI checks this and refuses to proceed otherwise.

## Idempotency

Safe to re-run. When an existing protection rule is present:

- Default behavior MERGES `dxkit-guardrails` into the existing
  required-checks list (preserves any other required checks)
- `--force` REPLACES the required-checks list with just `dxkit-guardrails`
- Existing review-count policy is preserved unless `--require-reviews`
  is passed explicitly
- Existing `enforce_admins` setting is preserved

## Edge cases

| Symptom                                        | Likely cause                          | Suggestion                                                                                                       |
| ---------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| "gh CLI not available or not authenticated"    | Missing `gh` or not logged in         | Install gh from <https://cli.github.com>; run `gh auth login`                                                    |
| "Repo has no github.com remote configured"     | No remote + no push                   | `git remote add origin git@github.com:OWNER/REPO.git && git push -u origin main`                                 |
| HTTP 403 ("you need admin rights on the repo") | You're not a repo admin               | Ask a repo admin to run this command, or configure manually in repo Settings → Branches                          |
| HTTP 404                                       | Repo doesn't exist or you lack access | Verify the repo is reachable via `gh repo view`                                                                  |
| Org-level branch protection conflict           | Org policy overrides your branch rule | Check org Settings → Repository → Branch protection patterns. Your settings still apply but may be supplemented. |

## Output

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  vyuh-dxkit setup-branch-protection
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  → Resolving existing protection on vyuh-labs/dxkit#main...
  → No existing protection rule; creating one with dxkit-guardrails as required.
  → Applying protection: required checks = [dxkit-guardrails]; reviews required = 0.

  ✓ Branch protection applied to vyuh-labs/dxkit#main.
    → Verify: https://github.com/vyuh-labs/dxkit/settings/branches
    → Review-count policy NOT changed (pass --require-reviews=N to require reviews).
```

## See also

- [`setup-prebuild`](setup-prebuild.md) — companion CLI for Codespaces
  prebuild automation (same gh-CLI infrastructure)
- [`init --with-ci`](init.md) — install the dxkit-guardrails workflow
  this CLI requires
- [`guardrail check`](guardrail.md) — the actual check the workflow runs
