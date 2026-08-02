# Admin setup path

For the person wiring dxkit into a repository and keeping it healthy.
Every step here is idempotent and verifiable with `vyuh-dxkit doctor`.

## 1. Install and configure

```bash
npm init @vyuhlabs/dxkit -- --yes     # or: vyuh-dxkit init on an existing install
vyuh-dxkit configure --apply           # deterministic policy from repo facts
vyuh-dxkit doctor                      # verify, and read its recommendations
```

`configure` derives policy from observable facts (repo visibility, stack,
lockfiles) and is reproducible: same repo, same plan. `doctor` is the
ongoing health check; run it after every step below until it is quiet.

## 2. The baseline and its transport

`init` captures the first baseline. Decide where it lives:

- **Private repos** default to a committed baseline (`committed-full`).
- **Public repos** default to `ref-based` (nothing sensitive committed).
- Compliance-conscious private repos can opt into `committed-sanitized`.

Install the **baseline refresh workflow** so the baseline stays current on
the default branch and advisory decisions surface as PRs. A baseline
captured once on a laptop and never refreshed goes stale, and stale
baselines are the top cause of CANNOT GATE verdicts.

## 3. Branch protection

```bash
vyuh-dxkit setup-branch-protection
```

Require the guardrail check on the default branch. dxkit reads BOTH classic
branch protection and repository rulesets, so either mechanism works;
`doctor` reports the effective protection either way.

## 4. GitHub settings the lanes need

Two settings decide whether the scheduled lanes can do their jobs:

1. **Allow GitHub Actions to create and approve pull requests**
   (repo or org Settings, Actions, General). Without it, the dep-bump and
   remediation lanes can push branches but cannot open their PRs; the run
   log will name this setting.
2. **A bot token for lane pushes (recommended): `DXKIT_BOT_TOKEN`.**
   Branches pushed with the default `GITHUB_TOKEN` do not trigger workflow
   runs, so lane PRs arrive with no CI checks and cannot satisfy branch
   protection. Set a fine-grained PAT (contents: write, pull requests:
   write) as a repo secret named `DXKIT_BOT_TOKEN`; the lane workflows use
   it automatically when present and fall back to `GITHUB_TOKEN` (degraded,
   disclosed) when absent.

## 5. Policy: what blocks here

`.dxkit/policy.json` is the contract. The pieces admins actually tune:

- **Preset** (for example `security-only`): which finding kinds block vs
  warn. Start conservative; tighten once the team trusts the gate.
- **Custom checks** (`checks[]`): repo commands run as first-class gate
  citizens. These execute in CI, so PRs that edit them deserve
  workflow-edit scrutiny.
- **Agent lane budgets**: per-task spend, turn, and time caps for the
  remediation lane, plus `remediate.maxSpendPerRun` and
  `remediate.maxDispatchBudget` org ceilings.

Every knob is discoverable: `vyuh-dxkit capabilities --json` is the
machine-readable menu, and `doctor` proactively recommends unused
capabilities that fit the repo.

## 6. Verify end to end

```bash
vyuh-dxkit doctor          # wiring, credentials, protection, staleness
vyuh-dxkit guardrail check # the gate itself, exit 0 on a clean tree
```

Then open a trivial PR and watch the verdict land. If anything surprises
you, `doctor` first: it knows about missing tokens, missing workflows,
stale baselines, and unprotected branches, and it prints the exact remedy
for each.
