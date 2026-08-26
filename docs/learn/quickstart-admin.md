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

## 4. Credentials and settings the lanes need

Three things decide whether the scheduled lanes can do their jobs — two
GitHub settings and, for the remediation lane, an agent key:

1. **Allow GitHub Actions to create and approve pull requests**
   (repo or org Settings, Actions, General). Without it, the dep-bump and
   remediation lanes can push branches but cannot open their PRs; the run
   log will name this setting.
2. **A bot token for lane pushes (recommended): `DXKIT_BOT_TOKEN`.**
   Branches pushed with the default `GITHUB_TOKEN` do not trigger workflow
   runs, so lane PRs arrive with no CI checks and cannot satisfy branch
   protection. Create the token step by step:
   1. GitHub → your profile → **Settings** → **Developer settings** →
      **Personal access tokens** → **Fine-grained tokens** → _Generate new
      token_. (Prefer a dedicated bot/service account over a personal one,
      so lane PRs are not attributed to a person and survive offboarding.)
   2. **Resource owner**: your organization. **Repository access**: only
      the repositories dxkit's lanes run in.
   3. **Permissions** (repository): `Contents` → Read and write,
      `Pull requests` → Read and write. Nothing else.
   4. **Expiration**: pick a real date and put the rotation on your
      calendar; an expired token degrades lanes back to `GITHUB_TOKEN`
      (disclosed in the run log, but easy to miss).
   5. If your org requires fine-grained token approval, have an org admin
      approve it (Settings → Personal access tokens in the org).
   6. Store it as the repo secret and verify:

      ```bash
      gh secret set DXKIT_BOT_TOKEN     # paste the token when prompted
      vyuh-dxkit doctor                 # the lane-credential check goes quiet
      ```

   The lane workflows use it automatically when present and fall back to
   `GITHUB_TOKEN` (degraded, disclosed) when absent.

3. **The agent key (remediation lane only).** The remediation agent runs
   with the driver's API key from a repo secret — `ANTHROPIC_API_KEY` for
   the default `claude-code` driver:

   ```bash
   gh secret set ANTHROPIC_API_KEY
   ```

   Use a scoped workspace key with a provider-side spend limit, never a
   personal key. dxkit's runner enforces the per-task and per-run budget
   caps from policy; the key's own limit is the independent backstop. An
   absent or expired key is disclosed in the run log, and the other lanes
   are unaffected. See the spend arithmetic in
   `docs/learn/operating-the-lanes.md`.

## 5. Branches dxkit creates (allow them)

The automation works through ordinary branches and PRs, so whatever
restricts branch creation in your org must allow dxkit's names:

- **PR branches**, created by the lanes and deleted after merge:
  `dxkit/dep-bump` (the standing dependency-bump PR),
  `dxkit/remediate-<task>` (one per remediation task),
  `dxkit/advisory-decision` (the refresh lane's decision PR), and
  `dxkit/extensions-refresh` (when extensions are installed). The
  comment-defer workflow commits to the PR's own branch and creates none.
- **The anchor side branch** (`anchor: 'branch'` transport only): the
  committed baseline lives on a dedicated branch, `dxkit-baselines` by
  default, which the after-merge refresh direct-pushes. It must exist
  outside your protection rules: do not add required checks or push
  restrictions to it, or the refresh cannot update the anchor and PRs
  degrade to CANNOT GATE as it goes stale.

If an org ruleset restricts who can create branches or enforces
branch-name patterns, add `dxkit/*` and `dxkit-baselines` to its
allowances (rulesets support bypass lists and name conditions). Nothing
here needs an exemption from the default branch's protection: lane PRs
merge through the same required checks as human PRs.

## 6. Policy: what blocks here

`.dxkit/policy.json` is the contract. The pieces admins actually tune:

- **Preset** (for example `security-only`): which finding kinds block vs
  warn. Start conservative; tighten once the team trusts the gate.
- **Custom checks** (`checks[]`): repo commands run as first-class gate
  citizens. These execute in CI, so PRs that edit them deserve
  workflow-edit scrutiny.
- **Agent lane budgets**: per-task spend, turn, and time caps for the
  remediation lane, plus `remediate.maxSpendPerRun` and
  `remediate.maxDispatchBudget` org ceilings.
- **Remediation lane governance**: `remediate.recipes.enabled` (default
  on; the deterministic $0 recipe tier runs before any agent, off routes
  every order to the agent), `remediate.maxOrdersPerRun` (default 3; how
  many work orders one firing may hand to the agent, 0 restores the
  single task-prompt run), and `remediate.pauseAfterFailures` (default 2;
  the circuit breaker pauses a work-order class after this many
  consecutive failed firings instead of re-spending on it, 0 disables).

Every knob is discoverable: `vyuh-dxkit capabilities --json` is the
machine-readable menu, and `doctor` proactively recommends unused
capabilities that fit the repo.

## 7. Monorepos

Install at the repository root, once. One install gates the whole tree:

- **One baseline for the repo**, not one per package — findings carry file
  paths, so the diff scoping works regardless of package layout.
- **Nested manifests are found automatically.** The dependency audit
  discovers nested lockfiles (a sub-project's `package-lock.json`,
  `requirements.txt`, `go.mod`, ...) and audits the same set the gate
  sees; a vulnerable dependency in a nested package is not read as clean.
- **Multiple languages activate together.** Detection is per-manifest, so
  a TS frontend + Python service repo runs both packs' linters, audits,
  and correctness checks in one gate.

Per-package installs are not the model; if you need genuinely separate
policies for separate trees, make them separate repositories.

## 8. Verify end to end

```bash
vyuh-dxkit doctor          # wiring, credentials, protection, staleness
vyuh-dxkit guardrail check # the gate itself, exit 0 on a clean tree
```

Then open a trivial PR and watch the verdict land. If anything surprises
you, `doctor` first: it knows about missing tokens, missing workflows,
stale baselines, and unprotected branches, and it prints the exact remedy
for each.
